import { OtRepository } from './ot.repository'
import { ConstraintViolation, FakeSchedulerDb } from './testing/fake-db'

describe('OtRepository', () => {
  it('inserts a pending request and rejects an invalid rate class', async () => {
    const db = new FakeSchedulerDb()
    const repo = new OtRepository(db.asPool())
    const tx = db.connect()
    await tx.query('BEGIN')
    const created = await repo.insert(tx, {
      employeeId: 'emp-1',
      otDate: '2026-08-05',
      hours: '4.00',
      rateClass: 'holiday_ot',
      reason: 'urgent shipment',
      employeeConsent: true,
    })
    await tx.query('COMMIT')
    expect(created.status).toBe('pending')
    expect(created.rateClass).toBe('holiday_ot')

    const tx2 = db.connect()
    await tx2.query('BEGIN')
    await expect(
      repo.insert(tx2, {
        employeeId: 'emp-1',
        otDate: '2026-08-05',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately an invalid rate class to prove the CHECK constraint fires
        rateClass: 'bogus' as any,
        hours: '1.00',
        reason: 'x',
        employeeConsent: true,
      }),
    ).rejects.toThrow(ConstraintViolation)
  })

  it('rejects non-positive hours', async () => {
    const db = new FakeSchedulerDb()
    const repo = new OtRepository(db.asPool())
    const tx = db.connect()
    await tx.query('BEGIN')
    await expect(
      repo.insert(tx, { employeeId: 'emp-1', otDate: '2026-08-05', hours: '0', rateClass: 'workday', reason: 'x', employeeConsent: true }),
    ).rejects.toThrow(ConstraintViolation)
  })

  it('decide() moves a pending request to approved and is a no-op for an already-decided one', async () => {
    const db = new FakeSchedulerDb()
    const repo = new OtRepository(db.asPool())
    const tx = db.connect()
    await tx.query('BEGIN')
    const created = await repo.insert(tx, { employeeId: 'emp-1', otDate: '2026-08-05', hours: '2.00', rateClass: 'workday', reason: 'x', employeeConsent: true })
    await tx.query('COMMIT')

    const tx2 = db.connect()
    await tx2.query('BEGIN')
    const approved = await repo.decide(tx2, created.id, 'approved', 'mgr-1', null)
    await tx2.query('COMMIT')
    expect(approved?.status).toBe('approved')
    expect(approved?.approvedBy).toBe('mgr-1')

    const tx3 = db.connect()
    await tx3.query('BEGIN')
    const second = await repo.decide(tx3, created.id, 'rejected', 'mgr-2', 'too late')
    expect(second).toBeNull()
  })

  it('findApprovedForEmployeeInRange only returns approved rows within the date window', async () => {
    const db = new FakeSchedulerDb()
    const repo = new OtRepository(db.asPool())
    const tx = db.connect()
    await tx.query('BEGIN')
    const a = await repo.insert(tx, { employeeId: 'emp-1', otDate: '2026-08-04', hours: '2.00', rateClass: 'workday', reason: 'x', employeeConsent: true })
    await repo.insert(tx, { employeeId: 'emp-1', otDate: '2026-08-20', hours: '2.00', rateClass: 'workday', reason: 'x', employeeConsent: true })
    await tx.query('COMMIT')

    const tx2 = db.connect()
    await tx2.query('BEGIN')
    await repo.decide(tx2, a.id, 'approved', 'mgr-1', null)
    await tx2.query('COMMIT')

    const found = await repo.findApprovedForEmployeeInRange('emp-1', '2026-08-03', '2026-08-09')
    expect(found).toHaveLength(1)
    expect(found[0]?.id).toBe(a.id)
  })
})
