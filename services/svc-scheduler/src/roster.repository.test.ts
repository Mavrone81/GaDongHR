import { RosterRepository } from './roster.repository'
import { FakeSchedulerDb } from './testing/fake-db'

const EMP = 'emp-1'
const SHIFT = 'shift-1'

describe('RosterRepository', () => {
  it('inserts a planned entry and finds it by employee+date', async () => {
    const db = new FakeSchedulerDb()
    const repo = new RosterRepository(db.asPool())
    const tx = db.connect()
    await tx.query('BEGIN')
    const created = await repo.insert(tx, { employeeId: EMP, shiftId: SHIFT, workDate: '2026-08-05', overrideReason: null, hazardous: false })
    await tx.query('COMMIT')

    expect(created.status).toBe('planned')
    const found = await repo.findByEmployeeAndDate(EMP, '2026-08-05')
    expect(found).toHaveLength(1)
    expect(found[0]?.id).toBe(created.id)
  })

  it('findByEmployeeAndDateRange sums the right week', async () => {
    const db = new FakeSchedulerDb()
    const repo = new RosterRepository(db.asPool())
    const tx = db.connect()
    await tx.query('BEGIN')
    await repo.insert(tx, { employeeId: EMP, shiftId: SHIFT, workDate: '2026-08-03', overrideReason: null, hazardous: false })
    await repo.insert(tx, { employeeId: EMP, shiftId: SHIFT, workDate: '2026-08-09', overrideReason: null, hazardous: false })
    await repo.insert(tx, { employeeId: EMP, shiftId: SHIFT, workDate: '2026-08-10', overrideReason: null, hazardous: false })
    await tx.query('COMMIT')

    const week = await repo.findByEmployeeAndDateRange(EMP, '2026-08-03', '2026-08-09')
    expect(week).toHaveLength(2)
  })

  it('setOverrideReason updates the row, publishRange flips status and filters by employeeIds', async () => {
    const db = new FakeSchedulerDb()
    const repo = new RosterRepository(db.asPool())
    const tx = db.connect()
    await tx.query('BEGIN')
    const a = await repo.insert(tx, { employeeId: 'emp-a', shiftId: SHIFT, workDate: '2026-08-05', overrideReason: null, hazardous: false })
    await repo.insert(tx, { employeeId: 'emp-b', shiftId: SHIFT, workDate: '2026-08-05', overrideReason: null, hazardous: false })
    await tx.query('COMMIT')

    const tx2 = db.connect()
    await tx2.query('BEGIN')
    const overridden = await repo.setOverrideReason(tx2, a.id, 'covering approved leave')
    const published = await repo.publishRange(tx2, '2026-08-01', '2026-08-31', ['emp-a'])
    await tx2.query('COMMIT')

    expect(overridden?.overrideReason).toBe('covering approved leave')
    expect(published).toHaveLength(1)
    expect(published[0]?.employeeId).toBe('emp-a')
    expect(published[0]?.status).toBe('published')

    const grid = await repo.findByDateRange('2026-08-01', '2026-08-31', null)
    const empB = grid.find((r) => r.employeeId === 'emp-b')
    expect(empB?.status).toBe('planned') // untouched — not in the employeeIds filter
  })

  it('rolls back on ROLLBACK — an inserted entry never becomes visible', async () => {
    const db = new FakeSchedulerDb()
    const repo = new RosterRepository(db.asPool())
    const tx = db.connect()
    await tx.query('BEGIN')
    await repo.insert(tx, { employeeId: EMP, shiftId: SHIFT, workDate: '2026-08-05', overrideReason: null, hazardous: false })
    await tx.query('ROLLBACK')

    const found = await repo.findByEmployeeAndDate(EMP, '2026-08-05')
    expect(found).toHaveLength(0)
  })
})
