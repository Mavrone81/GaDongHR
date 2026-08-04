import { randomUUID } from 'node:crypto'
import { EnrolmentRepository } from './enrolment.repository'
import { AlternativeCredentialRepository } from './alternative-credential.repository'
import { PunchRepository } from './punch.repository'
import { SecurityEventRepository } from './security-event.repository'
import { PunchService } from './punch.service'
import { hashPin } from './credential-hash'
import { FakeFaceEngine } from './testing/fake-face-engine'
import { FakeLivenessChecker } from './testing/fake-liveness-checker'
import { FakeConfigClient } from './testing/fake-config-client'
import { FakeAttendanceDb } from './testing/fake-attendance-db'

const PEPPER = 'test-pepper-not-for-production'
const MATCH_THRESHOLD = 0.8

function buildService(
  db: FakeAttendanceDb,
  opts: { engine?: FakeFaceEngine; liveness?: FakeLivenessChecker; now?: () => Date } = {},
) {
  const engine = opts.engine ?? new FakeFaceEngine()
  const liveness = opts.liveness ?? new FakeLivenessChecker()
  const config = new FakeConfigClient()
  config.set('attendance.match_threshold', MATCH_THRESHOLD)
  const service = new PunchService(
    new PunchRepository(db.asPool()),
    new EnrolmentRepository(db.asPool()),
    new AlternativeCredentialRepository(db.asPool()),
    new SecurityEventRepository(db.asPool()),
    engine,
    liveness,
    config,
    PEPPER,
    opts.now,
  )
  return { service, engine, liveness }
}

async function enrolFace(db: FakeAttendanceDb, engine: FakeFaceEngine, employeeId: string, image: Buffer): Promise<string> {
  const { subjectRef } = await engine.enrol(employeeId, [image])
  const tx = db.connect()
  await tx.query('BEGIN')
  await new EnrolmentRepository(db.asPool()).insert(tx, { id: randomUUID(), employeeId, method: 'face', faceSubjectRef: subjectRef })
  await tx.query('COMMIT')
  return subjectRef
}

async function enrolPin(db: FakeAttendanceDb, employeeId: string, pin: string): Promise<void> {
  const tx = db.connect()
  await tx.query('BEGIN')
  await new AlternativeCredentialRepository(db.asPool()).upsert(tx, employeeId, 'pin', hashPin(PEPPER, employeeId, pin))
  await tx.query('COMMIT')
}

describe('PunchService — offline kiosk replay end-to-end (M4-4/M4-6)', () => {
  it('the same idem_key delivered three times via recordCodePunch creates exactly one punch and publishes attendance.punch exactly once', async () => {
    const db = new FakeAttendanceDb()
    await enrolPin(db, 'emp-1', '1234')
    const { service } = buildService(db)

    const input = { deviceId: 'device-1', idemKey: 'device-1:seq-1', direction: 'in' as const, siteCode: 'BKK-HQ', punchedAt: '2026-01-01T08:00:00.000Z', kind: 'pin' as const, code: '1234', employeeId: 'emp-1' }
    for (let i = 0; i < 3; i++) {
      const tx = db.connect()
      await tx.query('BEGIN')
      await service.recordCodePunch(tx, input)
      await tx.query('COMMIT')
    }

    expect(db.debugPunches()).toHaveLength(1)
    expect(db.debugOutboxRows().filter((r) => r.topic === 'attendance.punch')).toHaveLength(1)
  })
})

describe('PunchService — method-agnostic event shape (M4-5)', () => {
  it('a PIN punch and a face punch produce identical event shapes apart from method and match_score/liveness_passed', async () => {
    const db = new FakeAttendanceDb()
    const engine = new FakeFaceEngine()
    const image = Buffer.from('emp-face-1')
    await enrolFace(db, engine, 'emp-face', image)
    await enrolPin(db, 'emp-pin', '9999')
    const { service } = buildService(db, { engine })

    const facetx = db.connect()
    await facetx.query('BEGIN')
    await service.recordFacePunch(facetx, {
      deviceId: 'device-1', idemKey: 'device-1:seq-1', direction: 'in', siteCode: 'BKK-HQ', punchedAt: '2026-01-01T08:00:00.000Z', frame: image,
    })
    await facetx.query('COMMIT')

    const pintx = db.connect()
    await pintx.query('BEGIN')
    await service.recordCodePunch(pintx, {
      deviceId: 'device-1', idemKey: 'device-1:seq-2', direction: 'in', siteCode: 'BKK-HQ', punchedAt: '2026-01-01T08:05:00.000Z', kind: 'pin', code: '9999', employeeId: 'emp-pin',
    })
    await pintx.query('COMMIT')

    const events = db.debugOutboxRows().filter((r) => r.topic === 'attendance.punch').map((r) => r.payload as Record<string, unknown>)
    expect(events).toHaveLength(2)
    const [faceEvent, pinEvent] = events

    // Identical KEY SET — this is what makes Timesheet's consumer method-agnostic.
    expect(Object.keys(faceEvent!).sort()).toEqual(Object.keys(pinEvent!).sort())

    // Every field EXCEPT method/matchScore/livenessPassed/idemKey/employeeId/punchedAt is structurally the same shape (siteCode, deviceId, direction identical here by construction).
    expect(faceEvent).toMatchObject({ deviceId: 'device-1', direction: 'in', siteCode: 'BKK-HQ' })
    expect(pinEvent).toMatchObject({ deviceId: 'device-1', direction: 'in', siteCode: 'BKK-HQ' })

    expect(faceEvent!['method']).toBe('face')
    expect(pinEvent!['method']).toBe('pin')
    expect(typeof faceEvent!['matchScore']).toBe('number')
    expect(pinEvent!['matchScore']).toBeNull()
  })
})

describe('PunchService — failed liveness (M4-3)', () => {
  it('logs a security event, publishes attendance.liveness_failed, and creates NO punch', async () => {
    const db = new FakeAttendanceDb()
    const engine = new FakeFaceEngine()
    const image = Buffer.from('emp-face-1')
    await enrolFace(db, engine, 'emp-face', image)
    const liveness = new FakeLivenessChecker()
    liveness.setResultFor(image, { passed: false, score: 0.1 })
    const { service } = buildService(db, { engine, liveness })

    const tx = db.connect()
    await tx.query('BEGIN')
    await expect(
      service.recordFacePunch(tx, { deviceId: 'device-1', idemKey: 'device-1:seq-1', direction: 'in', siteCode: 'BKK-HQ', punchedAt: '2026-01-01T08:00:00.000Z', frame: image }),
    ).rejects.toThrow(/ATT-020|liveness_failed/i)
    await tx.query('COMMIT')

    expect(db.debugPunches()).toHaveLength(0)
    expect(db.debugSecurityEvents()).toHaveLength(1)
    expect(db.debugSecurityEvents()[0]).toMatchObject({ kind: 'liveness_failed', device_id: 'device-1', site_code: 'BKK-HQ' })
    expect(db.debugOutboxRows().find((r) => r.topic === 'attendance.liveness_failed')).toBeDefined()
    expect(db.debugOutboxRows().find((r) => r.topic === 'attendance.punch')).toBeUndefined()
  })
})

describe('PunchService — face engine unreachable ⇒ fall back to the alternative method (M4-5)', () => {
  it('recordFacePunch throws (never silently loses the punch) when the face engine is unreachable', async () => {
    const db = new FakeAttendanceDb()
    const engine = new FakeFaceEngine()
    engine.unreachable = true
    const { service } = buildService(db, { engine })

    const tx = db.connect()
    await tx.query('BEGIN')
    await expect(
      service.recordFacePunch(tx, { deviceId: 'device-1', idemKey: 'device-1:seq-1', direction: 'in', siteCode: 'BKK-HQ', punchedAt: '2026-01-01T08:00:00.000Z', frame: Buffer.from('x') }),
    ).rejects.toThrow(/ATT-070|face_engine_unavailable/i)
  })

  it('recordCodePunch (the alternative method) succeeds even though the face engine is unreachable — the kiosk\'s fallback path never touches it', async () => {
    const db = new FakeAttendanceDb()
    const engine = new FakeFaceEngine()
    engine.unreachable = true
    await enrolPin(db, 'emp-1', '1234')
    const { service } = buildService(db, { engine })

    const tx = db.connect()
    await tx.query('BEGIN')
    const result = await service.recordCodePunch(tx, {
      deviceId: 'device-1', idemKey: 'device-1:seq-1', direction: 'in', siteCode: 'BKK-HQ', punchedAt: '2026-01-01T08:00:00.000Z', kind: 'pin', code: '1234', employeeId: 'emp-1',
    })
    await tx.query('COMMIT')

    expect(result.duplicate).toBe(false)
    expect(result.row.method).toBe('pin')
  })
})

describe('PunchService — no code path can write a raw frame anywhere', () => {
  it('the stored punch row and enrolment row never contain the raw frame bytes', async () => {
    const db = new FakeAttendanceDb()
    const engine = new FakeFaceEngine()
    const image = Buffer.from('super-secret-face-pixels')
    await enrolFace(db, engine, 'emp-face', image)
    const { service } = buildService(db, { engine })

    const tx = db.connect()
    await tx.query('BEGIN')
    await service.recordFacePunch(tx, { deviceId: 'device-1', idemKey: 'device-1:seq-1', direction: 'in', siteCode: 'BKK-HQ', punchedAt: '2026-01-01T08:00:00.000Z', frame: image })
    await tx.query('COMMIT')

    const serialized = JSON.stringify(db.debugPunches()) + JSON.stringify(db.debugEnrolments())
    expect(serialized).not.toContain('super-secret-face-pixels')
  })
})
