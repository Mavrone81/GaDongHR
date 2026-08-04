import { randomUUID } from 'node:crypto'
import { AuditEmitter } from '@gadong/kernel'
import { EnrolmentRepository } from './enrolment.repository'
import { TemplateDeletionService } from './template-deletion.service'
import { FakeFaceEngine } from './testing/fake-face-engine'
import { FakeAttendanceDb } from './testing/fake-attendance-db'

async function enrolEmployee(db: FakeAttendanceDb, engine: FakeFaceEngine, employeeId: string): Promise<string> {
  const { subjectRef } = await engine.enrol(employeeId, [Buffer.from(`${employeeId}-face`)])
  const repo = new EnrolmentRepository(db.asPool())
  const tx = db.connect()
  await tx.query('BEGIN')
  await repo.insert(tx, { id: randomUUID(), employeeId, method: 'face', faceSubjectRef: subjectRef })
  await tx.query('COMMIT')
  return subjectRef
}

describe('TemplateDeletionService — PDPA §7 verified deletion', () => {
  it('deletes the template, stamps template_deleted_at, and publishes biometric.template.deleted — only after the engine confirms', async () => {
    const db = new FakeAttendanceDb()
    const engine = new FakeFaceEngine()
    const enrolmentRepo = new EnrolmentRepository(db.asPool())
    const subjectRef = await enrolEmployee(db, engine, 'emp-1')

    const fixedNow = () => new Date('2026-03-01T00:00:00.000Z')
    const service = new TemplateDeletionService(enrolmentRepo, engine, new AuditEmitter(), fixedNow)

    const tx = db.connect()
    await tx.query('BEGIN')
    await service.deleteForEmployee(tx, 'emp-1', 'consent_withdrawn')
    await tx.query('COMMIT')

    const enrolment = await enrolmentRepo.findByEmployeeId(db.asPool(), 'emp-1')
    expect(enrolment).toMatchObject({ status: 'deleted', templateDeletedAt: '2026-03-01T00:00:00.000Z' })
    expect(engine.isPresent(subjectRef)).toBe(false)

    const published = db.debugOutboxRows().find((r) => r.topic === 'biometric.template.deleted')
    expect(published?.payload).toMatchObject({ employeeId: 'emp-1', verifiedAt: '2026-03-01T00:00:00.000Z' })
  })

  it('a fake engine reporting "still present" after delete FAILS the operation — no template_deleted_at, no outbox event', async () => {
    const db = new FakeAttendanceDb()
    const engine = new FakeFaceEngine()
    const enrolmentRepo = new EnrolmentRepository(db.asPool())
    const subjectRef = await enrolEmployee(db, engine, 'emp-1')
    engine.simulateStubbornDeletion(subjectRef)

    const service = new TemplateDeletionService(enrolmentRepo, engine, new AuditEmitter())

    const tx = db.connect()
    await tx.query('BEGIN')
    await expect(service.deleteForEmployee(tx, 'emp-1', 'consent_withdrawn')).rejects.toThrow(/ATT-060|template_deletion_not_verified/i)
    await tx.query('ROLLBACK')

    const enrolment = await enrolmentRepo.findByEmployeeId(db.asPool(), 'emp-1')
    expect(enrolment?.status).toBe('active')
    expect(enrolment?.templateDeletedAt).toBeNull()
    expect(db.debugOutboxRows().find((r) => r.topic === 'biometric.template.deleted')).toBeUndefined()
  })

  it('is idempotent: calling it again after a successful deletion is a safe no-op, not a re-delete attempt', async () => {
    const db = new FakeAttendanceDb()
    const engine = new FakeFaceEngine()
    const enrolmentRepo = new EnrolmentRepository(db.asPool())
    await enrolEmployee(db, engine, 'emp-1')
    const service = new TemplateDeletionService(enrolmentRepo, engine, new AuditEmitter())

    const tx1 = db.connect()
    await tx1.query('BEGIN')
    await service.deleteForEmployee(tx1, 'emp-1', 'consent_withdrawn')
    await tx1.query('COMMIT')

    const tx2 = db.connect()
    await tx2.query('BEGIN')
    await expect(service.deleteForEmployee(tx2, 'emp-1', 'consent_withdrawn')).resolves.toBeUndefined()
    await tx2.query('COMMIT')
  })

  it('an employee with no face enrolment (alternative-method only) is a no-op, not an error', async () => {
    const db = new FakeAttendanceDb()
    const engine = new FakeFaceEngine()
    const enrolmentRepo = new EnrolmentRepository(db.asPool())
    const service = new TemplateDeletionService(enrolmentRepo, engine, new AuditEmitter())

    const tx = db.connect()
    await tx.query('BEGIN')
    await expect(service.deleteForEmployee(tx, 'emp-never-enrolled', 'consent_withdrawn')).resolves.toBeUndefined()
    await tx.query('COMMIT')
  })
})
