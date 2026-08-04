import { withTransaction } from '@gadong/kernel'
import { CorrectionAuditRepository } from './correction-audit.repository'
import { DayRecordRepository } from './day-record.repository'
import { EmployeeRefRepository } from './employee-ref.repository'
import { ExceptionRepository } from './exception.repository'
import { LeaveRefRepository } from './leave-ref.repository'
import { OtApprovalRefRepository } from './ot-approval-ref.repository'
import { PeriodRepository } from './period.repository'
import { RosterRefRepository } from './roster-ref.repository'
import { FakeTimesheetDb, ConstraintViolation } from './testing/fake-db'

/**
 * A trivial `pg.Pool`-shaped fake — `withTransaction` calls `pool.connect()`,
 * runs the callback against the returned client, and issues BEGIN/COMMIT/
 * ROLLBACK on it; `FakeTimesheetConnection` implements all of that.
 */
function fakePool(db: FakeTimesheetDb) {
  return {
    connect: async () => {
      const conn = db.connect()
      return {
        query: (sql: string, params?: unknown[]) => conn.query(sql, params),
        release: (err?: Error) => conn.release(err),
      }
    },
  } as unknown as import('pg').Pool
}

describe('DayRecordRepository', () => {
  it('ensureExists creates a row, is idempotent, and never overwrites an already-set roster_entry_id', async () => {
    const db = new FakeTimesheetDb()
    const repo = new DayRecordRepository(db.asPool())
    const pool = fakePool(db)

    const first = await withTransaction(pool, (tx) => repo.ensureExists(tx, 'emp-1', '2026-08-10', 'roster-a'))
    expect(first.rosterEntryId).toBe('roster-a')

    const second = await withTransaction(pool, (tx) => repo.ensureExists(tx, 'emp-1', '2026-08-10', 'roster-b'))
    expect(second.id).toBe(first.id)
    expect(second.rosterEntryId).toBe('roster-a') // not overwritten
  })

  it('setActualInIfAbsent is first-in-wins', async () => {
    const db = new FakeTimesheetDb()
    const repo = new DayRecordRepository(db.asPool())
    const pool = fakePool(db)
    const created = await withTransaction(pool, (tx) => repo.ensureExists(tx, 'emp-1', '2026-08-10', null))

    const first = await withTransaction(pool, (tx) => repo.setActualInIfAbsent(tx, created.id, '2026-08-10T09:00:00Z'))
    expect(first.actualIn).toBe('2026-08-10T09:00:00Z')

    const second = await withTransaction(pool, (tx) => repo.setActualInIfAbsent(tx, created.id, '2026-08-10T09:05:00Z'))
    expect(second.actualIn).toBe('2026-08-10T09:00:00Z') // unchanged
  })

  it('findOpenForEmployee finds a night-shift in-punch across a lookback window even when actual_out would fall on the next calendar date', async () => {
    const db = new FakeTimesheetDb()
    const repo = new DayRecordRepository(db.asPool())
    const pool = fakePool(db)
    const created = await withTransaction(pool, (tx) => repo.ensureExists(tx, 'emp-1', '2026-08-10', null))
    await withTransaction(pool, (tx) => repo.setActualInIfAbsent(tx, created.id, '2026-08-10T21:55:00Z'))

    const found = await repo.findOpenForEmployee('emp-1', '2026-08-11T06:10:00Z', 16 * 60)
    expect(found?.id).toBe(created.id)
    expect(found?.workDate).toBe('2026-08-10')
  })

  it('findByEmployeesAndRange scopes to the given employee ids, and null means every employee', async () => {
    const db = new FakeTimesheetDb()
    const repo = new DayRecordRepository(db.asPool())
    const pool = fakePool(db)
    await withTransaction(pool, (tx) => repo.ensureExists(tx, 'emp-1', '2026-08-10', null))
    await withTransaction(pool, (tx) => repo.ensureExists(tx, 'emp-2', '2026-08-10', null))

    const scoped = await repo.findByEmployeesAndRange(['emp-1'], '2026-08-01', '2026-08-31')
    expect(scoped.map((r) => r.employeeId)).toEqual(['emp-1'])

    const all = await repo.findByEmployeesAndRange(null, '2026-08-01', '2026-08-31')
    expect(all.map((r) => r.employeeId).sort()).toEqual(['emp-1', 'emp-2'])
  })
})

describe('ExceptionRepository', () => {
  it('raise → propose → confirm workflow, and findOpenByDayRecordAndKind stops finding it once resolved', async () => {
    const db = new FakeTimesheetDb()
    const dayRepo = new DayRecordRepository(db.asPool())
    const repo = new ExceptionRepository(db.asPool())
    const pool = fakePool(db)
    const day = await withTransaction(pool, (tx) => dayRepo.ensureExists(tx, 'emp-1', '2026-08-10', null))

    const raised = await withTransaction(pool, (tx) => repo.raise(tx, day.id, 'late', 'stuck in traffic'))
    expect(await repo.findOpenByDayRecordAndKind(day.id, 'late')).toMatchObject({ id: raised.id })

    await withTransaction(pool, (tx) => repo.propose(tx, raised.id, 'apply corrected in-time', 'manager-1'))
    expect(await repo.findOpenByDayRecordAndKind(day.id, 'late')).toBeNull() // proposed = no longer "open" in resolution terms... actually resolution is now proposed:*, not null, so this IS resolved from findOpen's perspective

    await withTransaction(pool, (tx) => repo.confirm(tx, raised.id, 'hr-1', 'apply corrected in-time'))
    const finalRow = await repo.findById(raised.id)
    expect(finalRow?.resolution).toBe('apply corrected in-time')
    expect(finalRow?.resolvedBy).toBe('hr-1')
  })

  it('findOpenInDateRange only returns exceptions whose day_record falls in range and are still open', async () => {
    const db = new FakeTimesheetDb()
    const dayRepo = new DayRecordRepository(db.asPool())
    const repo = new ExceptionRepository(db.asPool())
    const pool = fakePool(db)
    const inRange = await withTransaction(pool, (tx) => dayRepo.ensureExists(tx, 'emp-1', '2026-08-10', null))
    const outOfRange = await withTransaction(pool, (tx) => dayRepo.ensureExists(tx, 'emp-1', '2026-09-01', null))
    await withTransaction(pool, (tx) => repo.raise(tx, inRange.id, 'late', null))
    await withTransaction(pool, (tx) => repo.raise(tx, outOfRange.id, 'late', null))

    const found = await repo.findOpenInDateRange('2026-08-01', '2026-08-31')
    expect(found).toHaveLength(1)
    expect(found[0]?.dayRecordId).toBe(inRange.id)
  })
})

describe('PeriodRepository', () => {
  it('create rejects an overlapping range', async () => {
    const db = new FakeTimesheetDb()
    const repo = new PeriodRepository(db.asPool())
    const pool = fakePool(db)
    await withTransaction(pool, (tx) => repo.create(tx, '2026-08-01', '2026-08-31'))

    await expect(withTransaction(pool, (tx) => repo.create(tx, '2026-08-15', '2026-09-15'))).rejects.toThrow(ConstraintViolation)
  })

  it('lock increments lock_version, unlock preserves it, and a re-lock increments again (v1 → unlock → v2)', async () => {
    const db = new FakeTimesheetDb()
    const repo = new PeriodRepository(db.asPool())
    const pool = fakePool(db)
    const period = await withTransaction(pool, (tx) => repo.create(tx, '2026-08-01', '2026-08-31'))

    const locked = await withTransaction(pool, (tx) => repo.lock(tx, period.id, 'hr-1'))
    expect(locked?.lockVersion).toBe(1)
    expect(locked?.status).toBe('locked')

    const unlocked = await withTransaction(pool, (tx) => repo.unlock(tx, period.id))
    expect(unlocked?.lockVersion).toBe(1) // unchanged by unlock itself
    expect(unlocked?.status).toBe('open')

    const relocked = await withTransaction(pool, (tx) => repo.lock(tx, period.id, 'hr-1'))
    expect(relocked?.lockVersion).toBe(2)
  })

  it('lock returns null (not an error) if the period is not open', async () => {
    const db = new FakeTimesheetDb()
    const repo = new PeriodRepository(db.asPool())
    const pool = fakePool(db)
    const period = await withTransaction(pool, (tx) => repo.create(tx, '2026-08-01', '2026-08-31'))
    await withTransaction(pool, (tx) => repo.lock(tx, period.id, 'hr-1'))

    const second = await withTransaction(pool, (tx) => repo.lock(tx, period.id, 'hr-1'))
    expect(second).toBeNull()
  })

  it('findContaining resolves the period whose range covers a date', async () => {
    const db = new FakeTimesheetDb()
    const repo = new PeriodRepository(db.asPool())
    const pool = fakePool(db)
    const period = await withTransaction(pool, (tx) => repo.create(tx, '2026-08-01', '2026-08-31'))

    const found = await repo.findContaining('2026-08-20')
    expect(found?.id).toBe(period.id)
    expect(await repo.findContaining('2026-09-01')).toBeNull()
  })
})

describe('RosterRefRepository', () => {
  it('upsert overwrites the whole row (unlike day_record.ensureExists) — a re-published roster entry replaces prior scheduling data', async () => {
    const db = new FakeTimesheetDb()
    const repo = new RosterRefRepository(db.asPool())
    const pool = fakePool(db)
    await withTransaction(pool, (tx) =>
      repo.upsert(tx, {
        employeeId: 'emp-1',
        workDate: '2026-08-10',
        scheduledStart: '2026-08-10T09:00:00Z',
        scheduledEnd: '2026-08-10T18:00:00Z',
        graceMin: 5,
        hazardous: false,
        isHoliday: false,
        rosterEntryId: 'r1',
      }),
    )
    const updated = await withTransaction(pool, (tx) =>
      repo.upsert(tx, {
        employeeId: 'emp-1',
        workDate: '2026-08-10',
        scheduledStart: '2026-08-10T10:00:00Z',
        scheduledEnd: '2026-08-10T19:00:00Z',
        graceMin: 10,
        hazardous: true,
        isHoliday: true,
        rosterEntryId: 'r2',
      }),
    )
    expect(updated.scheduledStart).toBe('2026-08-10T10:00:00Z')
    expect(updated.isHoliday).toBe(true)

    const found = await repo.findOne('emp-1', '2026-08-10')
    expect(found?.rosterEntryId).toBe('r2')
  })
})

describe('LeaveRefRepository', () => {
  it('upsertApproved then markCancelled', async () => {
    const db = new FakeTimesheetDb()
    const repo = new LeaveRefRepository(db.asPool())
    const pool = fakePool(db)
    await withTransaction(pool, (tx) =>
      repo.upsertApproved(tx, {
        employeeId: 'emp-1',
        leaveRequestId: 'req-1',
        dateFrom: '2026-08-10',
        dateTo: '2026-08-12',
        leaveTypeCode: 'sick',
        payMode: 'full',
      }),
    )
    expect(await repo.findApprovedCovering('emp-1', '2026-08-11')).toMatchObject({ leaveRequestId: 'req-1' })

    await withTransaction(pool, (tx) => repo.markCancelled(tx, 'req-1'))
    expect(await repo.findApprovedCovering('emp-1', '2026-08-11')).toBeNull()
  })
})

describe('OtApprovalRefRepository', () => {
  it('upsertAdd accumulates hours across multiple approvals for the same employee-day, never replaces', async () => {
    const db = new FakeTimesheetDb()
    const repo = new OtApprovalRefRepository(db.asPool())
    const pool = fakePool(db)
    await withTransaction(pool, (tx) =>
      repo.upsertAdd(tx, { employeeId: 'emp-1', otDate: '2026-08-10', rateClass: 'workday', hours: '1.00', approvedBy: 'mgr-1' }),
    )
    await withTransaction(pool, (tx) =>
      repo.upsertAdd(tx, { employeeId: 'emp-1', otDate: '2026-08-10', rateClass: 'workday', hours: '0.50', approvedBy: 'mgr-1' }),
    )
    const found = await repo.findByEmployeeAndDate('emp-1', '2026-08-10')
    expect(found).toHaveLength(1)
    expect(Number.parseFloat(found[0]?.hours ?? '0')).toBeCloseTo(1.5)
  })
})

describe('EmployeeRefRepository', () => {
  it('findByOrgUnits scopes to exactly the given org units (the row-scoping building block)', async () => {
    const db = new FakeTimesheetDb()
    const repo = new EmployeeRefRepository(db.asPool())
    const pool = fakePool(db)
    await withTransaction(pool, (tx) => repo.upsert(tx, { employeeId: 'emp-1', empCode: 'E1', orgUnitId: 'org-a', employmentType: 'monthly', status: 'active' }))
    await withTransaction(pool, (tx) => repo.upsert(tx, { employeeId: 'emp-2', empCode: 'E2', orgUnitId: 'org-b', employmentType: 'daily', status: 'active' }))

    const scoped = await repo.findByOrgUnits(['org-a'])
    expect(scoped.map((r) => r.employeeId)).toEqual(['emp-1'])
  })
})

describe('CorrectionAuditRepository', () => {
  it('records an immutable before/after snapshot with actor and reason', async () => {
    const db = new FakeTimesheetDb()
    const dayRepo = new DayRecordRepository(db.asPool())
    const repo = new CorrectionAuditRepository(db.asPool())
    const pool = fakePool(db)
    const before = await withTransaction(pool, (tx) => dayRepo.ensureExists(tx, 'emp-1', '2026-08-10', null))
    const after = await withTransaction(pool, (tx) => dayRepo.setActualInIfAbsent(tx, before.id, '2026-08-10T09:00:00Z'))

    const recorded = await withTransaction(pool, (tx) => repo.record(tx, before.id, 'hr-1', 'employee forgot to punch', before, after))
    expect(recorded.actor).toBe('hr-1')
    expect(recorded.reason).toBe('employee forgot to punch')
    expect(recorded.before.actualIn).toBeNull()
    expect(recorded.after.actualIn).toBe('2026-08-10T09:00:00Z')

    const history = await repo.findByDayRecord(before.id)
    expect(history).toHaveLength(1)
  })
})
