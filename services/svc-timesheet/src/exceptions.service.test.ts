import { withTransaction } from '@gadong/kernel'
import { ConsolidationService } from './consolidation.service'
import { CorrectionAuditRepository } from './correction-audit.repository'
import { DayRecordRepository } from './day-record.repository'
import { EmployeeRefRepository } from './employee-ref.repository'
import { ExceptionRepository } from './exception.repository'
import { ExceptionsService } from './exceptions.service'
import { LeaveRefRepository } from './leave-ref.repository'
import { OtApprovalRefRepository } from './ot-approval-ref.repository'
import { PeriodRepository } from './period.repository'
import { RosterRefRepository } from './roster-ref.repository'
import { defaultTimesheetConfig } from './testing/fake-config-client'
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
  const rosterRefs = new RosterRefRepository(db.asPool())
  const leaveRefs = new LeaveRefRepository(db.asPool())
  const otApprovalRefs = new OtApprovalRefRepository(db.asPool())
  const employeeRefs = new EmployeeRefRepository(db.asPool())
  const correctionAudits = new CorrectionAuditRepository(db.asPool())
  const periods = new PeriodRepository(db.asPool())
  const { client: configClient } = defaultTimesheetConfig()
  const consolidation = new ConsolidationService(dayRecords, exceptions, rosterRefs, leaveRefs, otApprovalRefs, employeeRefs, correctionAudits, configClient, () => new Date('2026-08-20T00:00:00Z'))
  const service = new ExceptionsService(exceptions, dayRecords, periods, correctionAudits, consolidation)
  return { db, pool, dayRecords, exceptions, rosterRefs, leaveRefs, otApprovalRefs, employeeRefs, correctionAudits, periods, consolidation, service }
}

describe('ExceptionsService.propose → confirm (TC-M3-010)', () => {
  it('manager proposes a fix; HR confirms → day recomputed; audit stores who/when/why + before/after', async () => {
    const h = harness()
    // A missed-punch day: only an in-punch, no roster (so it flags immediately as "out but no in" is false; instead simulate via manual correction scenario).
    const day = await withTransaction(h.pool, (tx) => h.dayRecords.ensureExists(tx, 'emp-1', '2026-08-10', null))
    const exc = await withTransaction(h.pool, (tx) => h.exceptions.raise(tx, day.id, 'missed_punch', 'no out-punch recorded'))

    await withTransaction(h.pool, (tx) =>
      h.service.propose(tx, exc.id, 'mgr-1', {
        actualIn: '2026-08-10T09:00:00Z',
        actualOut: '2026-08-10T17:00:00Z',
        resolutionNote: 'employee forgot to tap out, confirmed by security footage',
        reason: 'security footage confirms 09:00-17:00 attendance',
      }),
    )

    const { exception, dayRecord } = await withTransaction(h.pool, (tx) => h.service.confirm(tx, exc.id, 'hr-1'))

    expect(exception.resolution).toBe('security footage confirms 09:00-17:00 attendance')
    expect(exception.resolvedBy).toBe('hr-1')
    expect(dayRecord.actualIn).toBe('2026-08-10T09:00:00Z')
    expect(dayRecord.actualOut).toBe('2026-08-10T17:00:00Z')
    expect(dayRecord.status).toBe('corrected')

    const audit = await h.correctionAudits.findByDayRecord(day.id)
    expect(audit).toHaveLength(1)
    expect(audit[0]?.actor).toBe('hr-1')
    expect(audit[0]?.reason).toBe('security footage confirms 09:00-17:00 attendance')
    expect(audit[0]?.before.actualIn).toBeNull()
    expect(audit[0]?.after.actualIn).toBe('2026-08-10T09:00:00Z')

    const outboxRows = h.db.debugOutboxRows()
    const correctedEvent = outboxRows.find((r) => r.topic === 'timesheet.corrected')
    expect(correctedEvent?.payload).toMatchObject({ dayRecordId: day.id, correctedBy: 'hr-1' })
  })

  it('status stays "corrected" even after a later recompute finds nothing wrong (a corrected day never silently reverts to "ok" — the audit history persists)', async () => {
    const h = harness()
    const day = await withTransaction(h.pool, (tx) => h.dayRecords.ensureExists(tx, 'emp-1', '2026-08-10', null))
    const exc = await withTransaction(h.pool, (tx) => h.exceptions.raise(tx, day.id, 'missed_punch', 'no out-punch recorded'))
    await withTransaction(h.pool, (tx) => h.service.propose(tx, exc.id, 'mgr-1', { actualIn: '2026-08-10T09:00:00Z', actualOut: '2026-08-10T17:00:00Z', resolutionNote: 'fix', reason: 'confirmed by manager' }))
    const { dayRecord } = await withTransaction(h.pool, (tx) => h.service.confirm(tx, exc.id, 'hr-1'))
    expect(dayRecord.status).toBe('corrected')

    // A later, unrelated recompute (e.g. triggered by a leave event elsewhere) re-evaluates this day and finds no open exception.
    const recomputedAgain = await withTransaction(h.pool, (tx) => h.consolidation.recomputeDay(tx, 'emp-1', '2026-08-10'))
    expect(recomputedAgain.status).toBe('corrected')
  })

  it('confirm on a period that has since been locked is refused with TSH-010 ("use unlock flow")', async () => {
    const h = harness()
    const day = await withTransaction(h.pool, (tx) => h.dayRecords.ensureExists(tx, 'emp-1', '2026-08-10', null))
    const exc = await withTransaction(h.pool, (tx) => h.exceptions.raise(tx, day.id, 'missed_punch', 'no out-punch recorded'))
    await withTransaction(h.pool, (tx) => h.service.propose(tx, exc.id, 'mgr-1', { actualIn: '2026-08-10T09:00:00Z', actualOut: '2026-08-10T17:00:00Z', resolutionNote: 'fix', reason: 'confirmed' }))

    // A period covering this date gets created and locked BEFORE HR confirms — the correction attempt must not silently sneak into a locked period.
    const period = await withTransaction(h.pool, (tx) => h.periods.create(tx, '2026-08-01', '2026-08-31'))
    await withTransaction(h.pool, (tx) => h.periods.lock(tx, period.id, 'hr-2'))

    await expect(withTransaction(h.pool, (tx) => h.service.confirm(tx, exc.id, 'hr-1'))).rejects.toMatchObject({ code: 'TSH-010' })
  })

  it('propose on an already-resolved exception is refused', async () => {
    const h = harness()
    const day = await withTransaction(h.pool, (tx) => h.dayRecords.ensureExists(tx, 'emp-1', '2026-08-10', null))
    const exc = await withTransaction(h.pool, (tx) => h.exceptions.raise(tx, day.id, 'late', '10 minutes late'))
    await withTransaction(h.pool, (tx) => h.exceptions.autoResolve(tx, exc.id, 'auto_resolved_no_longer_late'))

    await expect(
      withTransaction(h.pool, (tx) => h.service.propose(tx, exc.id, 'mgr-1', { resolutionNote: 'x', reason: 'y' })),
    ).rejects.toMatchObject({ code: 'TSH-061' })
  })

  it('confirm on an exception that was never proposed is refused', async () => {
    const h = harness()
    const day = await withTransaction(h.pool, (tx) => h.dayRecords.ensureExists(tx, 'emp-1', '2026-08-10', null))
    const exc = await withTransaction(h.pool, (tx) => h.exceptions.raise(tx, day.id, 'late', '10 minutes late'))

    await expect(withTransaction(h.pool, (tx) => h.service.confirm(tx, exc.id, 'hr-1'))).rejects.toMatchObject({ code: 'TSH-062' })
  })

  it('confirm on a nonexistent exception throws TSH-060', async () => {
    const h = harness()
    await expect(withTransaction(h.pool, (tx) => h.service.confirm(tx, 'nope', 'hr-1'))).rejects.toMatchObject({ code: 'TSH-060' })
  })

  it('a partial correction (only actualOut supplied) leaves actualIn untouched', async () => {
    const h = harness()
    const day = await withTransaction(h.pool, (tx) => {
      return h.dayRecords.ensureExists(tx, 'emp-1', '2026-08-10', null).then(async (d) => {
        await h.dayRecords.setActualInIfAbsent(tx, d.id, '2026-08-10T09:00:00Z')
        return d
      })
    })
    const exc = await withTransaction(h.pool, (tx) => h.exceptions.raise(tx, day.id, 'missed_punch', 'no out-punch recorded'))
    await withTransaction(h.pool, (tx) => h.service.propose(tx, exc.id, 'mgr-1', { actualOut: '2026-08-10T17:00:00Z', resolutionNote: 'fix', reason: 'confirmed' }))

    const { dayRecord } = await withTransaction(h.pool, (tx) => h.service.confirm(tx, exc.id, 'hr-1'))
    expect(dayRecord.actualIn).toBe('2026-08-10T09:00:00Z')
    expect(dayRecord.actualOut).toBe('2026-08-10T17:00:00Z')
  })
})

describe('ExceptionsService.manualPunch', () => {
  it('routes through the same event pipeline as a device punch', async () => {
    const h = harness()
    const day = await withTransaction(h.pool, (tx) => h.service.manualPunch(tx, 'emp-1', '2026-08-10T09:00:00Z', 'in'))
    expect(day.actualIn).toBe('2026-08-10T09:00:00Z')
  })
})

describe('ExceptionsService.queue', () => {
  it('returns only exceptions matching the requested status, scoped to the given employees', async () => {
    const h = harness()
    const dayA = await withTransaction(h.pool, (tx) => h.dayRecords.ensureExists(tx, 'emp-1', '2026-08-10', null))
    const dayB = await withTransaction(h.pool, (tx) => h.dayRecords.ensureExists(tx, 'emp-2', '2026-08-10', null))
    await withTransaction(h.pool, (tx) => h.exceptions.raise(tx, dayA.id, 'late', '10 min'))
    await withTransaction(h.pool, (tx) => h.exceptions.raise(tx, dayB.id, 'late', '10 min'))

    const scoped = await h.service.queue('open', ['emp-1'])
    expect(scoped).toHaveLength(1)

    const all = await h.service.queue('open', null)
    expect(all).toHaveLength(2)
  })
})
