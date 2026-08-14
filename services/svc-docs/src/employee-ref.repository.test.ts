import { EmployeeRefRepository } from './employee-ref.repository'
import { FakeDocsDb } from './testing/fake-db'

describe('EmployeeRefRepository', () => {
  it('upsert then findById round-trips the org unit', async () => {
    const db = new FakeDocsDb()
    const repo = new EmployeeRefRepository(db.asPool())

    await repo.upsert(db.asPool(), { employeeId: 'emp-1', orgUnitId: 'org-a' })

    await expect(repo.findById('emp-1')).resolves.toMatchObject({ employeeId: 'emp-1', orgUnitId: 'org-a' })
  })

  it('findById returns null for an employee with no synced ref row', async () => {
    const db = new FakeDocsDb()
    const repo = new EmployeeRefRepository(db.asPool())
    await expect(repo.findById('never-synced')).resolves.toBeNull()
  })

  it('a second upsert for the same employee_id overwrites the org unit (an employee.updated after a transfer)', async () => {
    const db = new FakeDocsDb()
    const repo = new EmployeeRefRepository(db.asPool())

    await repo.upsert(db.asPool(), { employeeId: 'emp-1', orgUnitId: 'org-a' })
    await repo.upsert(db.asPool(), { employeeId: 'emp-1', orgUnitId: 'org-b' })

    await expect(repo.findById('emp-1')).resolves.toMatchObject({ orgUnitId: 'org-b' })
    expect(db.debugEmployeeRefs()).toHaveLength(1)
  })
})
