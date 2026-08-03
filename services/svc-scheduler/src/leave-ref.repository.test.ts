import { LeaveRefRepository } from './leave-ref.repository'
import { FakeSchedulerDb } from './testing/fake-db'

describe('LeaveRefRepository', () => {
  it('upsertApproved then findApprovedCovering finds a date within range, not outside it', async () => {
    const db = new FakeSchedulerDb()
    const repo = new LeaveRefRepository(db.asPool())
    const tx = db.connect()
    await tx.query('BEGIN')
    await repo.upsertApproved(tx, { employeeId: 'emp-1', leaveRequestId: 'req-1', dateFrom: '2026-08-10', dateTo: '2026-08-12' })
    await tx.query('COMMIT')

    expect(await repo.findApprovedCovering('emp-1', '2026-08-11')).toHaveLength(1)
    expect(await repo.findApprovedCovering('emp-1', '2026-08-10')).toHaveLength(1)
    expect(await repo.findApprovedCovering('emp-1', '2026-08-12')).toHaveLength(1)
    expect(await repo.findApprovedCovering('emp-1', '2026-08-13')).toHaveLength(0)
  })

  it('markCancelled removes it from the approved read model', async () => {
    const db = new FakeSchedulerDb()
    const repo = new LeaveRefRepository(db.asPool())
    const tx = db.connect()
    await tx.query('BEGIN')
    await repo.upsertApproved(tx, { employeeId: 'emp-1', leaveRequestId: 'req-1', dateFrom: '2026-08-10', dateTo: '2026-08-12' })
    await tx.query('COMMIT')

    const tx2 = db.connect()
    await tx2.query('BEGIN')
    const cancelled = await repo.markCancelled(tx2, 'req-1')
    await tx2.query('COMMIT')

    expect(cancelled?.status).toBe('cancelled')
    expect(await repo.findApprovedCovering('emp-1', '2026-08-11')).toHaveLength(0)
  })

  it('upsertApproved on the same leaveRequestId a second time replaces the dates (idempotent-ish natural key)', async () => {
    const db = new FakeSchedulerDb()
    const repo = new LeaveRefRepository(db.asPool())
    const tx = db.connect()
    await tx.query('BEGIN')
    await repo.upsertApproved(tx, { employeeId: 'emp-1', leaveRequestId: 'req-1', dateFrom: '2026-08-10', dateTo: '2026-08-10' })
    await repo.upsertApproved(tx, { employeeId: 'emp-1', leaveRequestId: 'req-1', dateFrom: '2026-08-20', dateTo: '2026-08-20' })
    await tx.query('COMMIT')

    expect(await repo.findApprovedCovering('emp-1', '2026-08-10')).toHaveLength(0)
    expect(await repo.findApprovedCovering('emp-1', '2026-08-20')).toHaveLength(1)
  })
})
