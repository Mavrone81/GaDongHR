import { randomUUID } from 'node:crypto'
import { EnrolmentRepository } from './enrolment.repository'
import { FakeAttendanceDb } from './testing/fake-attendance-db'

describe('EnrolmentRepository', () => {
  it('inserts a face enrolment with an opaque subject ref, active status, no deletion timestamp', async () => {
    const db = new FakeAttendanceDb()
    const repo = new EnrolmentRepository(db.asPool())
    const tx = db.connect()
    await tx.query('BEGIN')
    const row = await repo.insert(tx, { id: randomUUID(), employeeId: 'emp-1', method: 'face', faceSubjectRef: 'subj-emp-1-1' })
    await tx.query('COMMIT')

    expect(row).toMatchObject({ employeeId: 'emp-1', method: 'face', faceSubjectRef: 'subj-emp-1-1', status: 'active', templateDeletedAt: null })
    expect(typeof row.faceSubjectRef).toBe('string')
  })

  it('a second enrolment for the same employee is rejected — one enrolment per person', async () => {
    const db = new FakeAttendanceDb()
    const repo = new EnrolmentRepository(db.asPool())

    const tx1 = db.connect()
    await tx1.query('BEGIN')
    await repo.insert(tx1, { id: randomUUID(), employeeId: 'emp-1', method: 'face', faceSubjectRef: 'subj-1' })
    await tx1.query('COMMIT')

    const tx2 = db.connect()
    await tx2.query('BEGIN')
    await expect(repo.insert(tx2, { id: randomUUID(), employeeId: 'emp-1', method: 'face', faceSubjectRef: 'subj-2' })).rejects.toThrow(
      /enrollment_employee_id_key/,
    )
  })

  it('findByEmployeeId returns null when no enrolment exists', async () => {
    const db = new FakeAttendanceDb()
    const repo = new EnrolmentRepository(db.asPool())
    expect(await repo.findByEmployeeId(db.asPool(), 'nobody')).toBeNull()
  })

  it('markTemplateDeleted stamps template_deleted_at and flips status to deleted, leaving the opaque ref intact', async () => {
    const db = new FakeAttendanceDb()
    const repo = new EnrolmentRepository(db.asPool())

    const tx1 = db.connect()
    await tx1.query('BEGIN')
    await repo.insert(tx1, { id: randomUUID(), employeeId: 'emp-1', method: 'face', faceSubjectRef: 'subj-1' })
    await tx1.query('COMMIT')

    const tx2 = db.connect()
    await tx2.query('BEGIN')
    const deleted = await repo.markTemplateDeleted(tx2, 'emp-1', '2026-02-01T00:00:00.000Z')
    await tx2.query('COMMIT')

    expect(deleted).toMatchObject({ status: 'deleted', templateDeletedAt: '2026-02-01T00:00:00.000Z', faceSubjectRef: 'subj-1' })

    const found = await repo.findByEmployeeId(db.asPool(), 'emp-1')
    expect(found?.status).toBe('deleted')
  })

  it('an unrecognised method is rejected via the CHECK constraint', async () => {
    const db = new FakeAttendanceDb()
    const repo = new EnrolmentRepository(db.asPool())
    const tx = db.connect()
    await tx.query('BEGIN')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately bypassing the type system to prove the fake enforces the DB-level CHECK.
    await expect(repo.insert(tx, { id: randomUUID(), employeeId: 'emp-1', method: 'retina' as any, faceSubjectRef: null })).rejects.toThrow(
      /enrollment_method_check/,
    )
  })
})
