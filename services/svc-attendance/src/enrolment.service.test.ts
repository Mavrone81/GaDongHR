import { AuditEmitter } from '@gadong/kernel'
import { ConsentStateRepository } from './consent-state.repository'
import { EnrolmentRepository } from './enrolment.repository'
import { AlternativeCredentialRepository } from './alternative-credential.repository'
import { EnrolmentService } from './enrolment.service'
import { FakeFaceEngine } from './testing/fake-face-engine'
import { FakeAttendanceDb } from './testing/fake-attendance-db'

const PEPPER = 'test-pepper-not-for-production'

function buildService(db: FakeAttendanceDb, engine: FakeFaceEngine = new FakeFaceEngine()) {
  return new EnrolmentService(
    new ConsentStateRepository(db.asPool()),
    new EnrolmentRepository(db.asPool()),
    new AlternativeCredentialRepository(db.asPool()),
    engine,
    new AuditEmitter(),
    PEPPER,
  )
}

async function grantConsent(db: FakeAttendanceDb, employeeId: string): Promise<void> {
  const tx = db.connect()
  await tx.query('BEGIN')
  await new ConsentStateRepository(db.asPool()).upsert(tx, employeeId, 'granted', '2026-01-01T00:00:00.000Z')
  await tx.query('COMMIT')
}

describe('EnrolmentService — M4-1: enrolment requires explicit biometric consent', () => {
  it('startEnrolment is REFUSED (ATT-001) for an employee with no consent on file', async () => {
    const db = new FakeAttendanceDb()
    const service = buildService(db)
    await expect(service.startEnrolment('emp-never-consented', db.asPool())).rejects.toThrow(/ATT-001|enrolment_requires_consent/i)
  })

  it('startEnrolment is REFUSED for an employee whose consent was withdrawn', async () => {
    const db = new FakeAttendanceDb()
    await grantConsent(db, 'emp-1')
    const tx = db.connect()
    await tx.query('BEGIN')
    await new ConsentStateRepository(db.asPool()).upsert(tx, 'emp-1', 'withdrawn', '2026-01-02T00:00:00.000Z')
    await tx.query('COMMIT')

    const service = buildService(db)
    await expect(service.startEnrolment('emp-1', db.asPool())).rejects.toThrow(/ATT-001/)
  })

  it('startEnrolment SUCCEEDS for an employee with granted biometric consent', async () => {
    const db = new FakeAttendanceDb()
    await grantConsent(db, 'emp-1')
    const service = buildService(db)
    const result = await service.startEnrolment('emp-1', db.asPool())
    expect(typeof result.session).toBe('string')
    expect(result.session.length).toBeGreaterThan(0)
  })

  it('completeEnrolment re-checks consent and is refused if consent was withdrawn mid-capture', async () => {
    const db = new FakeAttendanceDb()
    await grantConsent(db, 'emp-1')
    const service = buildService(db)
    const { session } = await service.startEnrolment('emp-1', db.asPool())

    // Withdrawn AFTER the session started, BEFORE it completes.
    const tx0 = db.connect()
    await tx0.query('BEGIN')
    await new ConsentStateRepository(db.asPool()).upsert(tx0, 'emp-1', 'withdrawn', '2026-01-03T00:00:00.000Z')
    await tx0.query('COMMIT')

    const tx = db.connect()
    await tx.query('BEGIN')
    await expect(
      service.completeEnrolment(tx, { session, images: [Buffer.from('emp-1-face')] }, 'hr-1', 'hr_admin'),
    ).rejects.toThrow(/ATT-001/)
  })

  it('completeEnrolment succeeds end-to-end when consent remains granted: creates an active enrolment with an opaque subject ref, no raw image persisted anywhere in the DB', async () => {
    const db = new FakeAttendanceDb()
    await grantConsent(db, 'emp-1')
    const service = buildService(db)
    const { session } = await service.startEnrolment('emp-1', db.asPool())

    const tx = db.connect()
    await tx.query('BEGIN')
    const row = await service.completeEnrolment(tx, { session, images: [Buffer.from('emp-1-face')] }, 'hr-1', 'hr_admin')
    await tx.query('COMMIT')

    expect(row).toMatchObject({ employeeId: 'emp-1', method: 'face', status: 'active' })
    expect(typeof row.faceSubjectRef).toBe('string')

    // No raw image anywhere in the stored rows.
    const serialized = JSON.stringify(db.debugEnrolments())
    expect(serialized).not.toContain('emp-1-face')
  })

  it('addFrame buffers frames that completeEnrolment consumes when no explicit images are given', async () => {
    const db = new FakeAttendanceDb()
    await grantConsent(db, 'emp-1')
    const service = buildService(db)
    const { session } = await service.startEnrolment('emp-1', db.asPool())

    service.addFrame(session, Buffer.from('frame-1'))
    service.addFrame(session, Buffer.from('frame-2'))

    const tx = db.connect()
    await tx.query('BEGIN')
    const row = await service.completeEnrolment(tx, { session }, 'hr-1', 'hr_admin')
    await tx.query('COMMIT')

    expect(row).toMatchObject({ employeeId: 'emp-1', status: 'active' })
  })

  it('completing a session with no buffered frames and no explicit images is refused (ATT-010)', async () => {
    const db = new FakeAttendanceDb()
    await grantConsent(db, 'emp-1')
    const service = buildService(db)
    const { session } = await service.startEnrolment('emp-1', db.asPool())

    const tx = db.connect()
    await tx.query('BEGIN')
    await expect(service.completeEnrolment(tx, { session }, 'hr-1', 'hr_admin')).rejects.toThrow(/ATT-010|capture_quality/i)
  })

  it('a completed session cannot be completed twice', async () => {
    const db = new FakeAttendanceDb()
    await grantConsent(db, 'emp-1')
    const service = buildService(db)
    const { session } = await service.startEnrolment('emp-1', db.asPool())

    const tx1 = db.connect()
    await tx1.query('BEGIN')
    await service.completeEnrolment(tx1, { session, images: [Buffer.from('img')] }, 'hr-1', 'hr_admin')
    await tx1.query('COMMIT')

    const tx2 = db.connect()
    await tx2.query('BEGIN')
    await expect(service.completeEnrolment(tx2, { session, images: [Buffer.from('img')] }, 'hr-1', 'hr_admin')).rejects.toThrow(
      /ATT-052|enrolment_session_not_found/i,
    )
  })
})

describe('EnrolmentService — M4-5: alternative method (no consent required)', () => {
  it('enrolAlternative succeeds for an employee with NO biometric consent on file at all', async () => {
    const db = new FakeAttendanceDb()
    const service = buildService(db)
    const tx = db.connect()
    await tx.query('BEGIN')
    await expect(service.enrolAlternative(tx, { employeeId: 'emp-refused', kind: 'pin', code: '1234' }, 'hr-1', 'hr_admin')).resolves.toBeUndefined()
    await tx.query('COMMIT')

    const enrolment = await new EnrolmentRepository(db.asPool()).findByEmployeeId(db.asPool(), 'emp-refused')
    expect(enrolment).toMatchObject({ method: 'pin', faceSubjectRef: null, status: 'active' })
  })

  it('stores a hash, never the raw PIN', async () => {
    const db = new FakeAttendanceDb()
    const service = buildService(db)
    const tx = db.connect()
    await tx.query('BEGIN')
    await service.enrolAlternative(tx, { employeeId: 'emp-1', kind: 'pin', code: 'secret-pin' }, 'hr-1', 'hr_admin')
    await tx.query('COMMIT')

    const cred = await new AlternativeCredentialRepository(db.asPool()).findByEmployeeId(db.asPool(), 'emp-1')
    expect(cred?.credentialHash.toString('utf8')).not.toContain('secret-pin')
  })
})
