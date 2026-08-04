import { randomUUID } from 'node:crypto'
import { AuditEmitter } from '@gadong/kernel'
import { ConsentStateRepository } from './consent-state.repository'
import { EnrolmentRepository } from './enrolment.repository'
import { ConsentEventHandler } from './consent-event.handler'
import { TemplateDeletionService } from './template-deletion.service'
import { FakeFaceEngine } from './testing/fake-face-engine'
import { FakeAttendanceDb } from './testing/fake-attendance-db'

function buildHandler(db: FakeAttendanceDb, engine: FakeFaceEngine = new FakeFaceEngine(), deletionNow: () => Date = () => new Date()) {
  const enrolmentRepo = new EnrolmentRepository(db.asPool())
  const templateDeletion = new TemplateDeletionService(enrolmentRepo, engine, new AuditEmitter(), deletionNow)
  return { handler: new ConsentEventHandler(new ConsentStateRepository(db.asPool()), templateDeletion), enrolmentRepo }
}

async function enrolFace(db: FakeAttendanceDb, engine: FakeFaceEngine, employeeId: string): Promise<string> {
  const { subjectRef } = await engine.enrol(employeeId, [Buffer.from(`${employeeId}-face`)])
  const tx = db.connect()
  await tx.query('BEGIN')
  await new EnrolmentRepository(db.asPool()).insert(tx, { id: randomUUID(), employeeId, method: 'face', faceSubjectRef: subjectRef })
  await tx.query('COMMIT')
  return subjectRef
}

describe('ConsentEventHandler.handleGranted', () => {
  it('records granted consent state, idempotently across triple delivery', async () => {
    const db = new FakeAttendanceDb()
    const { handler } = buildHandler(db)
    const consentState = new ConsentStateRepository(db.asPool())

    for (let i = 0; i < 3; i++) {
      const tx = db.connect()
      await tx.query('BEGIN')
      await handler.handleGranted(tx, 'evt-granted-1', { employeeId: 'emp-1', purpose: 'biometric', formVersion: 1, at: '2026-01-01T00:00:00.000Z' })
      await tx.query('COMMIT')
    }

    expect(await consentState.isGranted('emp-1')).toBe(true)
  })

  it('ignores a non-biometric purpose', async () => {
    const db = new FakeAttendanceDb()
    const { handler } = buildHandler(db)
    const tx = db.connect()
    await tx.query('BEGIN')
    await handler.handleGranted(tx, 'evt-hr-1', { employeeId: 'emp-1', purpose: 'hr_processing', formVersion: 1, at: '2026-01-01T00:00:00.000Z' })
    await tx.query('COMMIT')

    expect(await new ConsentStateRepository(db.asPool()).isGranted('emp-1')).toBe(false)
  })
})

describe('ConsentEventHandler.handleWithdrawn — triggers verified template deletion (PDPA §7)', () => {
  it('marks consent withdrawn AND deletes the face template, verified against the engine', async () => {
    const db = new FakeAttendanceDb()
    const engine = new FakeFaceEngine()
    const fixedDeletionTime = () => new Date('2026-01-05T00:03:00.000Z')
    const { handler, enrolmentRepo } = buildHandler(db, engine, fixedDeletionTime)
    const subjectRef = await enrolFace(db, engine, 'emp-1')

    const tx = db.connect()
    await tx.query('BEGIN')
    // The withdrawal decision itself was recorded at `at` (onboarding);
    // template deletion happens moments later when this event is
    // processed — `template_deleted_at` is stamped with the ACTUAL
    // deletion time, not replayed from the triggering event's payload.
    await handler.handleWithdrawn(tx, 'evt-withdrawn-1', { employeeId: 'emp-1', purpose: 'biometric', formVersion: 1, at: '2026-01-05T00:00:00.000Z' })
    await tx.query('COMMIT')

    expect(await new ConsentStateRepository(db.asPool()).isGranted('emp-1')).toBe(false)
    const enrolment = await enrolmentRepo.findByEmployeeId(db.asPool(), 'emp-1')
    expect(enrolment).toMatchObject({ status: 'deleted', templateDeletedAt: '2026-01-05T00:03:00.000Z' })
    expect(engine.isPresent(subjectRef)).toBe(false)
  })

  it('a fake engine that reports the subject still present makes the WHOLE event handling fail — consent state is NOT recorded either, so a retry re-attempts everything', async () => {
    const db = new FakeAttendanceDb()
    const engine = new FakeFaceEngine()
    const { handler } = buildHandler(db, engine)
    const subjectRef = await enrolFace(db, engine, 'emp-1')
    engine.simulateStubbornDeletion(subjectRef)

    const tx = db.connect()
    await tx.query('BEGIN')
    await expect(
      handler.handleWithdrawn(tx, 'evt-withdrawn-2', { employeeId: 'emp-1', purpose: 'biometric', formVersion: 1, at: '2026-01-05T00:00:00.000Z' }),
    ).rejects.toThrow(/ATT-060|not_verified/i)
    await tx.query('ROLLBACK')

    // Nothing committed — including the biometric_consent upsert, which ran
    // inside the same idempotent() handler and transaction.
    expect(await new ConsentStateRepository(db.asPool()).find('emp-1')).toBeNull()
  })

  it('triple delivery of the same withdrawal event id deletes the template exactly once', async () => {
    const db = new FakeAttendanceDb()
    const engine = new FakeFaceEngine()
    const { handler } = buildHandler(db, engine)
    let deleteCalls = 0
    const originalDelete = engine.deleteSubject.bind(engine)
    engine.deleteSubject = async (ref: string) => {
      deleteCalls += 1
      return originalDelete(ref)
    }
    await enrolFace(db, engine, 'emp-1')

    for (let i = 0; i < 3; i++) {
      const tx = db.connect()
      await tx.query('BEGIN')
      await handler.handleWithdrawn(tx, 'evt-withdrawn-dup', { employeeId: 'emp-1', purpose: 'biometric', formVersion: 1, at: '2026-01-05T00:00:00.000Z' })
      await tx.query('COMMIT')
    }

    // idempotent() only ever runs the handler body once for a given event id.
    expect(deleteCalls).toBe(1)
  })
})

describe('ConsentEventHandler — punch history survives consent withdrawal', () => {
  it('withdrawing biometric consent (and deleting the template) leaves punch_event rows completely untouched', async () => {
    const db = new FakeAttendanceDb()
    const engine = new FakeFaceEngine()
    const { handler } = buildHandler(db, engine)
    await enrolFace(db, engine, 'emp-1')

    // A pre-existing punch for this employee (device row not required for
    // this test — the fake DB stores punch_event independently).
    db.seedPunch({
      id: randomUUID(), idem_key: 'device-1:seq-1', employee_id: 'emp-1', device_id: 'device-1',
      punched_at: new Date('2026-01-04T08:00:00.000Z'), direction: 'in', method: 'face',
      match_score: 0.97, liveness_passed: true, site_code: 'BKK-HQ', geo: null,
    })

    const tx = db.connect()
    await tx.query('BEGIN')
    await handler.handleWithdrawn(tx, 'evt-withdrawn-survive', { employeeId: 'emp-1', purpose: 'biometric', formVersion: 1, at: '2026-01-05T00:00:00.000Z' })
    await tx.query('COMMIT')

    expect(db.debugPunches()).toHaveLength(1)
    expect(db.debugPunches()[0]).toMatchObject({ employee_id: 'emp-1', idem_key: 'device-1:seq-1' })
  })
})
