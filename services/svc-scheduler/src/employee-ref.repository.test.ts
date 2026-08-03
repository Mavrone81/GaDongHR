import { EmployeeRefRepository } from './employee-ref.repository'
import { FakeSchedulerDb } from './testing/fake-db'

describe('EmployeeRefRepository', () => {
  it('upsert() creates then updates the same row, preserving fields not provided in the second call', async () => {
    const db = new FakeSchedulerDb()
    const repo = new EmployeeRefRepository(db.asPool())
    const tx = db.connect()
    await tx.query('BEGIN')
    await repo.upsert(tx, { employeeId: 'emp-1', empCode: 'E001', status: 'active', orgUnitId: 'org-1' })
    await tx.query('COMMIT')

    const tx2 = db.connect()
    await tx2.query('BEGIN')
    await repo.upsert(tx2, { employeeId: 'emp-1', empCode: null, status: 'terminated', orgUnitId: null })
    await tx2.query('COMMIT')

    const found = await repo.findById('emp-1')
    expect(found?.status).toBe('terminated')
    expect(found?.empCode).toBe('E001') // preserved — the update didn't overwrite it with null
    expect(found?.orgUnitId).toBe('org-1')
  })

  it('findByOrgUnit filters to the right org unit', async () => {
    const db = new FakeSchedulerDb()
    const repo = new EmployeeRefRepository(db.asPool())
    const tx = db.connect()
    await tx.query('BEGIN')
    await repo.upsert(tx, { employeeId: 'emp-1', empCode: 'E001', status: 'active', orgUnitId: 'org-1' })
    await repo.upsert(tx, { employeeId: 'emp-2', empCode: 'E002', status: 'active', orgUnitId: 'org-2' })
    await tx.query('COMMIT')

    const found = await repo.findByOrgUnit('org-1')
    expect(found.map((r) => r.employeeId)).toEqual(['emp-1'])
  })
})
