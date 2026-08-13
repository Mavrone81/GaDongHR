import { GadongError, withTransaction } from '@gadong/kernel'
import { DayRecordRepository } from './day-record.repository'
import { ExceptionRepository } from './exception.repository'
import { PeriodRepository } from './period.repository'
import { PeriodService } from './period.service'
import { FakeTimesheetDb } from './testing/fake-db'

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

function harness() {
  const db = new FakeTimesheetDb()
  const pool = fakePool(db)
  const dayRecords = new DayRecordRepository(db.asPool())
  const exceptions = new ExceptionRepository(db.asPool())
  const periods = new PeriodRepository(db.asPool())
  const service = new PeriodService(periods, exceptions, dayRecords)
  return { db, pool, dayRecords, exceptions, periods, service }
}

describe('PeriodService.lock — TC-M3-011/012', () => {
  it('TC-M3-011: refuses to lock a period with an open blocking exception → 409 TSH-030', async () => {
    const h = harness()
    const period = await withTransaction(h.pool, (tx) => h.periods.create(tx, '2026-08-01', '2026-08-31'))
    const day = await withTransaction(h.pool, (tx) => h.dayRecords.ensureExists(tx, 'emp-1', '2026-08-10', null))
    await withTransaction(h.pool, (tx) => h.exceptions.raise(tx, day.id, 'late', '15 minutes late'))

    await expect(withTransaction(h.pool, (tx) => h.service.lock(tx, period.id, 'hr-1'))).rejects.toMatchObject({
      code: 'TSH-030',
    })
  })

  it('TC-M3-012: locks a clean period → timesheet.locked published with lockVersion 1', async () => {
    const h = harness()
    const period = await withTransaction(h.pool, (tx) => h.periods.create(tx, '2026-08-01', '2026-08-31'))

    const result = await withTransaction(h.pool, (tx) => h.service.lock(tx, period.id, 'hr-1'))

    expect(result.period.status).toBe('locked')
    expect(result.period.lockVersion).toBe(1)
    const outboxRows = h.db.debugOutboxRows()
    const lockedEvent = outboxRows.find((r) => r.topic === 'timesheet.locked')
    expect(lockedEvent?.payload).toMatchObject({ periodId: period.id, lockVersion: 1, lockedBy: 'hr-1' })
  })

  it('a RESOLVED exception (not open) does not block locking', async () => {
    const h = harness()
    const period = await withTransaction(h.pool, (tx) => h.periods.create(tx, '2026-08-01', '2026-08-31'))
    const day = await withTransaction(h.pool, (tx) => h.dayRecords.ensureExists(tx, 'emp-1', '2026-08-10', null))
    const exc = await withTransaction(h.pool, (tx) => h.exceptions.raise(tx, day.id, 'late', '15 minutes late'))
    await withTransaction(h.pool, (tx) => h.exceptions.autoResolve(tx, exc.id, 'auto_resolved_no_longer_late'))

    const result = await withTransaction(h.pool, (tx) => h.service.lock(tx, period.id, 'hr-1'))
    expect(result.period.status).toBe('locked')
  })

  it('an exception outside the period range does not block locking', async () => {
    const h = harness()
    const period = await withTransaction(h.pool, (tx) => h.periods.create(tx, '2026-08-01', '2026-08-31'))
    const day = await withTransaction(h.pool, (tx) => h.dayRecords.ensureExists(tx, 'emp-1', '2026-09-05', null))
    await withTransaction(h.pool, (tx) => h.exceptions.raise(tx, day.id, 'late', '15 minutes late'))

    const result = await withTransaction(h.pool, (tx) => h.service.lock(tx, period.id, 'hr-1'))
    expect(result.period.status).toBe('locked')
  })

  it('locking a nonexistent period throws TSH-050', async () => {
    const h = harness()
    await expect(withTransaction(h.pool, (tx) => h.service.lock(tx, 'nope', 'hr-1'))).rejects.toMatchObject({ code: 'TSH-050' })
  })

  it('create rejects an overlapping range with TSH-054', async () => {
    const h = harness()
    await withTransaction(h.pool, (tx) => h.service.create(tx, '2026-08-01', '2026-08-31'))
    await expect(withTransaction(h.pool, (tx) => h.service.create(tx, '2026-08-15', '2026-09-15'))).rejects.toBeInstanceOf(GadongError)
  })
})

describe('PeriodService.unlock — TC-M3-013', () => {
  it('requires a non-empty reason', async () => {
    const h = harness()
    const period = await withTransaction(h.pool, (tx) => h.periods.create(tx, '2026-08-01', '2026-08-31'))
    await withTransaction(h.pool, (tx) => h.service.lock(tx, period.id, 'hr-1'))

    await expect(withTransaction(h.pool, (tx) => h.service.unlock(tx, period.id, 'payroll-approver-1', ''))).rejects.toMatchObject({
      code: 'TSH-053',
    })
  })

  it('TC-M3-013: unlock (with reason) → correct → re-lock publishes v2, and unlock always signals a required variance report', async () => {
    const h = harness()
    const period = await withTransaction(h.pool, (tx) => h.periods.create(tx, '2026-08-01', '2026-08-31'))
    await withTransaction(h.pool, (tx) => h.service.lock(tx, period.id, 'hr-1'))

    const unlockResult = await withTransaction(h.pool, (tx) => h.service.unlock(tx, period.id, 'payroll-approver-1', 'wrong OT class applied'))
    expect(unlockResult.period.status).toBe('open')
    expect(unlockResult.period.lockVersion).toBe(1) // unchanged by unlock itself
    expect(unlockResult.varianceReportRequired).toBe(true)
    const unlockedEvent = h.db.debugOutboxRows().find((r) => r.topic === 'timesheet.unlocked')
    expect(unlockedEvent?.payload).toMatchObject({ periodId: period.id, lockVersion: 1, reason: 'wrong OT class applied' })

    // "correct" (M3-3 correction workflow) happens here in a real flow;
    // this test only needs to prove the re-lock version bump.
    const relockResult = await withTransaction(h.pool, (tx) => h.service.lock(tx, period.id, 'hr-1'))
    expect(relockResult.period.lockVersion).toBe(2)
    const lockedEvents = h.db.debugOutboxRows().filter((r) => r.topic === 'timesheet.locked')
    expect(lockedEvents).toHaveLength(2)
    expect(lockedEvents[1]?.payload).toMatchObject({ lockVersion: 2 })
  })

  it('unlocking a period that is not currently locked throws TSH-052', async () => {
    const h = harness()
    const period = await withTransaction(h.pool, (tx) => h.periods.create(tx, '2026-08-01', '2026-08-31'))
    await expect(withTransaction(h.pool, (tx) => h.service.unlock(tx, period.id, 'payroll-approver-1', 'reason'))).rejects.toMatchObject({
      code: 'TSH-052',
    })
  })

  it('unlocking a nonexistent period throws TSH-050', async () => {
    const h = harness()
    await expect(withTransaction(h.pool, (tx) => h.service.unlock(tx, 'nope', 'payroll-approver-1', 'reason'))).rejects.toMatchObject({
      code: 'TSH-050',
    })
  })
})

describe('PeriodService.totals — the svc-payroll seam (ports.ts HttpTimesheetClient.getLockedTotals)', () => {
  it('aggregates worked hours/days and the three OT buckets per employee, for a locked period at its current lockVersion', async () => {
    const h = harness()
    const day1 = await withTransaction(h.pool, (tx) => h.dayRecords.ensureExists(tx, 'emp-1', '2026-08-03', null))
    await withTransaction(h.pool, (tx) =>
      h.dayRecords.updateComputed(tx, day1.id, { workedHours: '8', lateMin: '0', ot15x: '1.5', ot2x: '0', ot3x: '0', status: 'ok' }),
    )
    const day2 = await withTransaction(h.pool, (tx) => h.dayRecords.ensureExists(tx, 'emp-1', '2026-08-04', null))
    await withTransaction(h.pool, (tx) =>
      h.dayRecords.updateComputed(tx, day2.id, { workedHours: '8', lateMin: '0', ot15x: '0', ot2x: '4', ot3x: '2', status: 'ok' }),
    )
    // A leave day (no hours actually worked) must not count toward daysWorked.
    const day3 = await withTransaction(h.pool, (tx) => h.dayRecords.ensureExists(tx, 'emp-1', '2026-08-05', null))
    await withTransaction(h.pool, (tx) => h.dayRecords.setLeaveCode(tx, day3.id, 'AL'))
    // A second employee, outside the period's range, must not leak into emp-1's totals.
    const other = await withTransaction(h.pool, (tx) => h.dayRecords.ensureExists(tx, 'emp-2', '2026-08-03', null))
    await withTransaction(h.pool, (tx) =>
      h.dayRecords.updateComputed(tx, other.id, { workedHours: '8', lateMin: '0', ot15x: '0', ot2x: '0', ot3x: '0', status: 'ok' }),
    )

    const period = await withTransaction(h.pool, (tx) => h.periods.create(tx, '2026-08-01', '2026-08-31'))
    const { period: locked } = await withTransaction(h.pool, (tx) => h.service.lock(tx, period.id, 'hr-1'))

    const result = await h.service.totals(period.id, locked.lockVersion)

    expect(result.period.id).toBe(period.id)
    const emp1 = result.totals.find((t) => t.employeeId === 'emp-1')
    expect(emp1).toMatchObject({
      daysWorked: '2',
      hoursWorked: '16',
      otWorkdayHours: '1.5',
      otHolidayWorkHours: '4',
      otHolidayOtHours: '2',
    })
    const emp2 = result.totals.find((t) => t.employeeId === 'emp-2')
    expect(emp2).toMatchObject({ daysWorked: '1', hoursWorked: '8' })
  })

  it('TSH-050: a nonexistent period is not found', async () => {
    const h = harness()
    await expect(h.service.totals('nope', 1)).rejects.toMatchObject({ code: 'TSH-050' })
  })

  it('TSH-052: an OPEN period (never locked) refuses — there is no immutable hours-set to pin to', async () => {
    const h = harness()
    const period = await withTransaction(h.pool, (tx) => h.periods.create(tx, '2026-08-01', '2026-08-31'))
    await expect(h.service.totals(period.id, 0)).rejects.toMatchObject({ code: 'TSH-052' })
  })

  it('TSH-055: a STALE lockVersion (period unlocked + re-locked since) is refused, never silently answered with current hours', async () => {
    const h = harness()
    const period = await withTransaction(h.pool, (tx) => h.periods.create(tx, '2026-08-01', '2026-08-31'))
    const firstLock = await withTransaction(h.pool, (tx) => h.service.lock(tx, period.id, 'hr-1'))
    expect(firstLock.period.lockVersion).toBe(1)
    await withTransaction(h.pool, (tx) => h.service.unlock(tx, period.id, 'payroll-approver-1', 'correction'))
    const relock = await withTransaction(h.pool, (tx) => h.service.lock(tx, period.id, 'hr-1'))
    expect(relock.period.lockVersion).toBe(2)

    // Payroll last saw v1 — must be refused, not silently handed v2's hours.
    await expect(h.service.totals(period.id, 1)).rejects.toMatchObject({
      code: 'TSH-055',
      details: [{ periodId: period.id, requestedLockVersion: 1, currentLockVersion: 2 }],
    })
    // The CURRENT version succeeds.
    await expect(h.service.totals(period.id, 2)).resolves.toMatchObject({ period: { lockVersion: 2 } })
  })
})
