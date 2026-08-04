import { randomUUID } from 'node:crypto'
import { AuditEmitter } from '@gadong/kernel'
import { EnrolmentRepository } from './enrolment.repository'
import { EmployeeEventHandler } from './employee-event.handler'
import { TemplateDeletionService } from './template-deletion.service'
import { FakeFaceEngine } from './testing/fake-face-engine'
import { FakeAttendanceDb } from './testing/fake-attendance-db'

describe('EmployeeEventHandler.handleTerminated — the OTHER PDPA §7 deletion trigger', () => {
  it('deletes the face template on termination even when biometric consent was never withdrawn', async () => {
    const db = new FakeAttendanceDb()
    const engine = new FakeFaceEngine()
    const enrolmentRepo = new EnrolmentRepository(db.asPool())
    const { subjectRef } = await engine.enrol('emp-1', [Buffer.from('emp-1-face')])
    const tx0 = db.connect()
    await tx0.query('BEGIN')
    await enrolmentRepo.insert(tx0, { id: randomUUID(), employeeId: 'emp-1', method: 'face', faceSubjectRef: subjectRef })
    await tx0.query('COMMIT')

    const handler = new EmployeeEventHandler(new TemplateDeletionService(enrolmentRepo, engine, new AuditEmitter()))
    const tx = db.connect()
    await tx.query('BEGIN')
    await handler.handleTerminated(tx, 'evt-terminated-1', { id: 'emp-1', terminationDate: '2026-02-01', reasonCategory: 'resignation' })
    await tx.query('COMMIT')

    const enrolment = await enrolmentRepo.findByEmployeeId(db.asPool(), 'emp-1')
    expect(enrolment?.status).toBe('deleted')
    expect(engine.isPresent(subjectRef)).toBe(false)
  })

  it('is a no-op for a terminated employee with no face enrolment', async () => {
    const db = new FakeAttendanceDb()
    const engine = new FakeFaceEngine()
    const enrolmentRepo = new EnrolmentRepository(db.asPool())
    const handler = new EmployeeEventHandler(new TemplateDeletionService(enrolmentRepo, engine, new AuditEmitter()))

    const tx = db.connect()
    await tx.query('BEGIN')
    await expect(
      handler.handleTerminated(tx, 'evt-terminated-2', { id: 'emp-alt-only', terminationDate: '2026-02-01', reasonCategory: 'resignation' }),
    ).resolves.toBeUndefined()
    await tx.query('COMMIT')
  })
})
