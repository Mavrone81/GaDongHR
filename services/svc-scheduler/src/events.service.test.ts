import { EmployeeRefRepository } from './employee-ref.repository'
import { EventsService } from './events.service'
import { LeaveRefRepository } from './leave-ref.repository'
import { FakeSchedulerDb } from './testing/fake-db'

function service(db: FakeSchedulerDb): EventsService {
  return new EventsService(new EmployeeRefRepository(db.asPool()), new LeaveRefRepository(db.asPool()))
}

describe('EventsService — employee.* into scheduler_employee_ref', () => {
  it('handleEmployeeCreatedOrUpdated upserts the read model', async () => {
    const db = new FakeSchedulerDb()
    const svc = service(db)
    const tx = db.connect()
    await tx.query('BEGIN')
    await svc.handleEmployeeCreatedOrUpdated(tx, 'evt-1', { id: 'emp-1', empCode: 'E001', orgUnitId: 'org-1', status: 'active' })
    await tx.query('COMMIT')

    const found = await new EmployeeRefRepository(db.asPool()).findById('emp-1')
    expect(found).toMatchObject({ employeeId: 'emp-1', empCode: 'E001', orgUnitId: 'org-1', status: 'active' })
  })

  it('handleEmployeeTerminated marks status terminated without erasing the row', async () => {
    const db = new FakeSchedulerDb()
    const svc = service(db)
    const tx = db.connect()
    await tx.query('BEGIN')
    await svc.handleEmployeeCreatedOrUpdated(tx, 'evt-1', { id: 'emp-1', empCode: 'E001', orgUnitId: 'org-1', status: 'active' })
    await tx.query('COMMIT')

    const tx2 = db.connect()
    await tx2.query('BEGIN')
    await svc.handleEmployeeTerminated(tx2, 'evt-2', { id: 'emp-1', terminationDate: '2026-08-01', reasonCategory: 'resignation' })
    await tx2.query('COMMIT')

    const found = await new EmployeeRefRepository(db.asPool()).findById('emp-1')
    expect(found?.status).toBe('terminated')
    expect(found?.empCode).toBe('E001') // preserved, not erased
  })

  it('TRIPLE DELIVERY of employee.created produces exactly one effect (XC-EVENTS)', async () => {
    const db = new FakeSchedulerDb()
    const svc = service(db)
    const payload = { id: 'emp-1', empCode: 'E001', orgUnitId: 'org-1', status: 'active' }

    for (let i = 0; i < 3; i++) {
      const tx = db.connect()
      await tx.query('BEGIN')
      await svc.handleEmployeeCreatedOrUpdated(tx, 'evt-dup', payload)
      await tx.query('COMMIT')
    }

    // Effect happened (once) — provable by the read model existing at all
    // with exactly the values from the single application, and by there
    // being exactly one row for this employee.
    const repo = new EmployeeRefRepository(db.asPool())
    const found = await repo.findById('emp-1')
    expect(found).toMatchObject({ employeeId: 'emp-1', empCode: 'E001' })
    expect(db.employeeRefs.size).toBe(1)
  })
})

describe('EventsService — leave.approved/leave.cancelled into scheduler.leave_ref', () => {
  it('handleLeaveApproved derives date_from/date_to from the dates[] array', async () => {
    const db = new FakeSchedulerDb()
    const svc = service(db)
    const tx = db.connect()
    await tx.query('BEGIN')
    await svc.handleLeaveApproved(tx, 'evt-1', { requestId: 'req-1', employeeId: 'emp-1', dates: ['2026-08-12', '2026-08-10', '2026-08-11'] })
    await tx.query('COMMIT')

    const leaveRepo = new LeaveRefRepository(db.asPool())
    const covering = await leaveRepo.findApprovedCovering('emp-1', '2026-08-11')
    expect(covering).toHaveLength(1)
    expect(covering[0]).toMatchObject({ dateFrom: '2026-08-10', dateTo: '2026-08-12' })
  })

  it('handleLeaveCancelled removes the request from the approved read model', async () => {
    const db = new FakeSchedulerDb()
    const svc = service(db)
    const tx = db.connect()
    await tx.query('BEGIN')
    await svc.handleLeaveApproved(tx, 'evt-1', { requestId: 'req-1', employeeId: 'emp-1', dates: ['2026-08-10'] })
    await tx.query('COMMIT')

    const tx2 = db.connect()
    await tx2.query('BEGIN')
    await svc.handleLeaveCancelled(tx2, 'evt-2', { requestId: 'req-1' })
    await tx2.query('COMMIT')

    const leaveRepo = new LeaveRefRepository(db.asPool())
    expect(await leaveRepo.findApprovedCovering('emp-1', '2026-08-10')).toHaveLength(0)
  })

  it('TRIPLE DELIVERY of leave.approved produces exactly one effect (XC-EVENTS)', async () => {
    const db = new FakeSchedulerDb()
    const svc = service(db)
    const payload = { requestId: 'req-1', employeeId: 'emp-1', dates: ['2026-08-10'] }

    for (let i = 0; i < 3; i++) {
      const tx = db.connect()
      await tx.query('BEGIN')
      await svc.handleLeaveApproved(tx, 'evt-dup-leave', payload)
      await tx.query('COMMIT')
    }

    expect(db.leaveRefsByRequestId.size).toBe(1)
    const leaveRepo = new LeaveRefRepository(db.asPool())
    expect(await leaveRepo.findApprovedCovering('emp-1', '2026-08-10')).toHaveLength(1)
  })
})
