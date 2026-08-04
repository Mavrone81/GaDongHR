import { withTransaction } from '@gadong/kernel'
import { ConsolidationService } from './consolidation.service'
import { CorrectionAuditRepository } from './correction-audit.repository'
import { DayRecordRepository } from './day-record.repository'
import { EmployeeRefRepository } from './employee-ref.repository'
import { EventsConsumer } from './events.consumer'
import { ExceptionRepository } from './exception.repository'
import { LeaveRefRepository } from './leave-ref.repository'
import { OtApprovalRefRepository } from './ot-approval-ref.repository'
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
  const { client: configClient } = defaultTimesheetConfig()
  const consolidation = new ConsolidationService(dayRecords, exceptions, rosterRefs, leaveRefs, otApprovalRefs, employeeRefs, correctionAudits, configClient, () => new Date('2026-08-20T00:00:00Z'))
  const consumer = new EventsConsumer(consolidation, employeeRefs)
  return { db, pool, dayRecords, exceptions, rosterRefs, leaveRefs, otApprovalRefs, employeeRefs, correctionAudits, consumer }
}

describe('EventsConsumer — idempotency: triple delivery of the same event produces exactly one effect', () => {
  it('attendance.punch: three identical deliveries (same idemKey) → one actual_in write, not three', async () => {
    const h = harness()
    const payload = { idemKey: 'punch-abc-123', employeeId: 'emp-1', punchedAt: '2026-08-10T09:00:00Z', direction: 'in' }

    const results = await withTransaction(h.pool, async (tx) => [
      await h.consumer.handleAttendancePunch(tx, payload),
      await h.consumer.handleAttendancePunch(tx, payload),
      await h.consumer.handleAttendancePunch(tx, payload),
    ])

    expect(results[0]).not.toBe('duplicate')
    expect(results[1]).toBe('duplicate')
    expect(results[2]).toBe('duplicate')
    const day = await h.dayRecords.findOne('emp-1', '2026-08-10')
    expect(day?.actualIn).toBe('2026-08-10T09:00:00Z')
    // Only one day_record exists for this employee-day — the effect ran once.
    const all = await h.dayRecords.findByEmployeesAndRange(['emp-1'], '2026-01-01', '2026-12-31')
    expect(all).toHaveLength(1)
  })

  it('roster.published (per entry): three identical deliveries → one roster_ref write', async () => {
    const h = harness()
    const payload = {
      employeeId: 'emp-1',
      workDate: '2026-08-10',
      scheduledStart: '2026-08-10T09:00:00Z',
      scheduledEnd: '2026-08-10T17:00:00Z',
      graceMin: 5,
      hazardous: false,
      isHoliday: false,
      rosterEntryId: 'roster-entry-1',
    }

    const results = await withTransaction(h.pool, async (tx) => [
      await h.consumer.handleRosterEntryPublished(tx, 'evt-roster-1', payload),
      await h.consumer.handleRosterEntryPublished(tx, 'evt-roster-1', payload),
      await h.consumer.handleRosterEntryPublished(tx, 'evt-roster-1', payload),
    ])

    expect(results[0]).not.toBe('duplicate')
    expect(results[1]).toBe('duplicate')
    expect(results[2]).toBe('duplicate')
    const roster = await h.rosterRefs.findOne('emp-1', '2026-08-10')
    expect(roster?.rosterEntryId).toBe('roster-entry-1')
  })

  it('leave.approved: three identical deliveries → one leave_ref write, day_record.leave_code set once (not toggled/reapplied)', async () => {
    const h = harness()
    const payload = {
      requestId: 'leave-req-1',
      employeeId: 'emp-1',
      leaveTypeCode: 'annual',
      dates: { from: '2026-08-10', to: '2026-08-10' },
      payMode: 'full',
    }

    const results = await withTransaction(h.pool, async (tx) => [
      await h.consumer.handleLeaveApproved(tx, 'evt-leave-1', payload),
      await h.consumer.handleLeaveApproved(tx, 'evt-leave-1', payload),
      await h.consumer.handleLeaveApproved(tx, 'evt-leave-1', payload),
    ])

    expect(results[0]).not.toBe('duplicate')
    expect(results[1]).toBe('duplicate')
    expect(results[2]).toBe('duplicate')
    const day = await h.dayRecords.findOne('emp-1', '2026-08-10')
    expect(day?.leaveCode).toBe('annual')
    const all = await h.dayRecords.findByEmployeesAndRange(['emp-1'], '2026-01-01', '2026-12-31')
    expect(all).toHaveLength(1)
  })

  it('ot.approved: three identical deliveries accumulate hours only ONCE (idempotent(), not the repository-level upsertAdd alone)', async () => {
    const h = harness()
    const payload = { employeeId: 'emp-1', otDate: '2026-08-10', hours: '2.00', rateClass: 'workday', approvedBy: 'mgr-1' }

    await withTransaction(h.pool, async (tx) => {
      await h.consumer.handleOtApproved(tx, 'evt-ot-1', payload)
      await h.consumer.handleOtApproved(tx, 'evt-ot-1', payload)
      await h.consumer.handleOtApproved(tx, 'evt-ot-1', payload)
    })

    const approvals = await h.otApprovalRefs.findByEmployeeAndDate('emp-1', '2026-08-10')
    expect(approvals).toHaveLength(1)
    expect(Number.parseFloat(approvals[0]?.hours ?? '0')).toBeCloseTo(2.0) // NOT 6.0 — a naive repo-level accumulate without idempotent() would triple-count
  })

  it('employee.created/updated: three identical deliveries → one upsert', async () => {
    const h = harness()
    const payload = { id: 'emp-1', empCode: 'E1', orgUnitId: 'org-a', employmentType: 'monthly', status: 'active' }

    const results = await withTransaction(h.pool, async (tx) => [
      await h.consumer.handleEmployeeUpsert(tx, 'evt-emp-1', payload),
      await h.consumer.handleEmployeeUpsert(tx, 'evt-emp-1', payload),
      await h.consumer.handleEmployeeUpsert(tx, 'evt-emp-1', payload),
    ])

    expect(results[0]).not.toBe('duplicate')
    expect(results[1]).toBe('duplicate')
    expect(results[2]).toBe('duplicate')
    expect(await h.employeeRefs.findById('emp-1')).toMatchObject({ empCode: 'E1', orgUnitId: 'org-a' })
  })

  it('a DIFFERENT idemKey for a second, genuinely distinct punch is NOT deduped against the first', async () => {
    const h = harness()
    const first = { idemKey: 'punch-1', employeeId: 'emp-1', punchedAt: '2026-08-10T09:00:00Z', direction: 'in' }
    const second = { idemKey: 'punch-2', employeeId: 'emp-1', punchedAt: '2026-08-10T17:00:00Z', direction: 'out' }

    await withTransaction(h.pool, async (tx) => {
      await h.consumer.handleAttendancePunch(tx, first)
      await h.consumer.handleAttendancePunch(tx, second)
    })

    const day = await h.dayRecords.findOne('emp-1', '2026-08-10')
    expect(day?.actualIn).toBe('2026-08-10T09:00:00Z')
    expect(day?.actualOut).toBe('2026-08-10T17:00:00Z')
  })
})

describe('EventsConsumer — payload validation', () => {
  it('rejects a punch with an invalid direction', async () => {
    const h = harness()
    await expect(
      withTransaction(h.pool, (tx) => h.consumer.handleAttendancePunch(tx, { idemKey: 'x', employeeId: 'e', punchedAt: '2026-08-10T09:00:00Z', direction: 'sideways' })),
    ).rejects.toThrow(/direction/)
  })

  it('rejects a leave.approved payload missing dates', async () => {
    const h = harness()
    await expect(
      withTransaction(h.pool, (tx) => h.consumer.handleLeaveApproved(tx, 'evt-1', { requestId: 'r', employeeId: 'e', leaveTypeCode: 'sick', payMode: 'full' })),
    ).rejects.toThrow(/dates/)
  })

  it('rejects an employee.* payload with an invalid employmentType', async () => {
    const h = harness()
    await expect(
      withTransaction(h.pool, (tx) => h.consumer.handleEmployeeUpsert(tx, 'evt-1', { id: 'e', empCode: 'E1', orgUnitId: 'org-a', employmentType: 'freelance', status: 'active' })),
    ).rejects.toThrow(/employmentType/)
  })

  it('ot.approved accepts a numeric hours field, not only a string', async () => {
    const h = harness()
    await withTransaction(h.pool, (tx) => h.consumer.handleOtApproved(tx, 'evt-1', { employeeId: 'e', otDate: '2026-08-10', hours: 2, rateClass: 'workday', approvedBy: 'm' }))
    const approvals = await h.otApprovalRefs.findByEmployeeAndDate('e', '2026-08-10')
    expect(Number.parseFloat(approvals[0]?.hours ?? '0')).toBeCloseTo(2)
  })
})
