import { PayslipRefRepository } from './payslip-ref.repository'
import { FakeDocsDb } from './testing/fake-db'

describe('PayslipRefRepository', () => {
  it('upsert then findById round-trips the owning employee id', async () => {
    const db = new FakeDocsDb()
    const repo = new PayslipRefRepository(db.asPool())

    await repo.upsert(db.asPool(), { payslipId: 'payslip-1', employeeId: 'emp-1' })

    await expect(repo.findById('payslip-1')).resolves.toMatchObject({ payslipId: 'payslip-1', employeeId: 'emp-1' })
  })

  it('findById returns null for a payslip with no synced ref row (payslip.issued not consumed yet)', async () => {
    const db = new FakeDocsDb()
    const repo = new PayslipRefRepository(db.asPool())
    await expect(repo.findById('never-synced')).resolves.toBeNull()
  })
})
