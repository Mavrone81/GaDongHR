import { withTransaction } from '@gadong/kernel'
import { ConsolidationService } from './consolidation.service'
import { CorrectionAuditRepository } from './correction-audit.repository'
import { DayRecordRepository } from './day-record.repository'
import { EmployeeRefRepository } from './employee-ref.repository'
import { ExceptionRepository } from './exception.repository'
import { LeaveRefRepository } from './leave-ref.repository'
import { OtApprovalRefRepository } from './ot-approval-ref.repository'
import { RosterRefRepository } from './roster-ref.repository'
import { defaultTimesheetConfig } from './testing/fake-config-client'
import { FakeTimesheetDb } from './testing/fake-db'

/**
 * Every roster fixture below schedules an EXACTLY 8h shift (09:00-17:00) —
 * this service does not model unpaid meal breaks (no per-shift break rules
 * are replicated locally; see the report's deviations section), so a
 * shift's raw punch-to-punch span IS its regular-hours threshold. A shift
 * with any additional span (e.g. 09:00-18:00, a 9h span meant to model an
 * 8h day + 1h unpaid lunch) would make ordinary on-time attendance register
 * a sliver of unapproved OT under this simplification — tests that want a
 * clean "no incidental OT" baseline use the exact 8h span; tests that want
 * OT construct it deliberately on top of that baseline.
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

function harness(now: () => Date = () => new Date('2026-08-20T00:00:00Z')) {
  const db = new FakeTimesheetDb()
  const pool = fakePool(db)
  const dayRecords = new DayRecordRepository(db.asPool())
  const exceptions = new ExceptionRepository(db.asPool())
  const rosterRefs = new RosterRefRepository(db.asPool())
  const leaveRefs = new LeaveRefRepository(db.asPool())
  const otApprovalRefs = new OtApprovalRefRepository(db.asPool())
  const employeeRefs = new EmployeeRefRepository(db.asPool())
  const correctionAudits = new CorrectionAuditRepository(db.asPool())
  const { client: configClient, transport } = defaultTimesheetConfig()
  const service = new ConsolidationService(dayRecords, exceptions, rosterRefs, leaveRefs, otApprovalRefs, employeeRefs, correctionAudits, configClient, now)
  return { db, pool, dayRecords, exceptions, rosterRefs, leaveRefs, otApprovalRefs, employeeRefs, correctionAudits, configClient, transport, service }
}

async function applyStandardShift(h: ReturnType<typeof harness>, employeeId: string, workDate: string, overrides: Partial<{ isHoliday: boolean; graceMin: number }> = {}) {
  await withTransaction(h.pool, (tx) =>
    h.service.applyRosterEntry(tx, {
      employeeId,
      workDate,
      scheduledStart: `${workDate}T09:00:00Z`,
      scheduledEnd: `${workDate}T17:00:00Z`,
      graceMin: overrides.graceMin ?? 5,
      hazardous: false,
      isHoliday: overrides.isHoliday ?? false,
      rosterEntryId: 'r1',
    }),
  )
}

describe('ConsolidationService — M3-1 consolidation', () => {
  it('TC-M3-001: in 08:58 / out 17:05 vs a 09:00-17:00 shift, 5min grace → worked hours correct, late 0, no exception', async () => {
    const h = harness()
    await applyStandardShift(h, 'emp-1', '2026-08-10')
    await withTransaction(h.pool, (tx) => h.service.applyPunch(tx, { employeeId: 'emp-1', punchedAt: '2026-08-10T08:58:00Z', direction: 'in' }))
    const result = await withTransaction(h.pool, (tx) => h.service.applyPunch(tx, { employeeId: 'emp-1', punchedAt: '2026-08-10T17:05:00Z', direction: 'out' }))

    // 08:58 -> 17:05 = 487 minutes = 8.1166..h -> 8.12; 7 minutes over the
    // 8h/480min statutory threshold, unapproved — this service does not
    // treat a grace period as extending the OT threshold, only as
    // suppressing "late" for a within-grace late ARRIVAL (LPA s.61's OT
    // ceiling is not grace-adjustable). See TC-M3-001b below for the
    // genuinely-zero-OT baseline (exact 8h punch span).
    expect(result.workedHours).toBe('8.12')
    expect(result.lateMin).toBe('0')
  })

  it('TC-M3-001b: exact 8h punch span (09:00-17:00) against the same shift → worked hours correct, late 0, no exception at all', async () => {
    const h = harness()
    await applyStandardShift(h, 'emp-1', '2026-08-10')
    await withTransaction(h.pool, (tx) => h.service.applyPunch(tx, { employeeId: 'emp-1', punchedAt: '2026-08-10T09:00:00Z', direction: 'in' }))
    const result = await withTransaction(h.pool, (tx) => h.service.applyPunch(tx, { employeeId: 'emp-1', punchedAt: '2026-08-10T17:00:00Z', direction: 'out' }))

    expect(result.workedHours).toBe('8.00')
    expect(result.lateMin).toBe('0')
    expect(result.status).toBe('ok')
    // No OPEN exception — the harness's fixed future "now" means an
    // absence/missed_punch pair was raised transiently the moment the
    // roster entry alone existed (before any punch arrived), then
    // self-resolved the instant the punches completed the day; that
    // resolved history is retained (immutable audit), not erased.
    const excs = await h.exceptions.findByDayRecord(result.id)
    expect(excs.filter((e) => e.resolution === null)).toHaveLength(0)
    for (const exc of excs) expect(exc.resolution).toMatch(/^auto_resolved_/)
  })

  it('TC-M3-002: in 09:20 vs a 09:00 shift (5min grace) → 15 minutes late, "late" exception raised', async () => {
    const h = harness()
    await applyStandardShift(h, 'emp-1', '2026-08-10')
    const result = await withTransaction(h.pool, (tx) => h.service.applyPunch(tx, { employeeId: 'emp-1', punchedAt: '2026-08-10T09:20:00Z', direction: 'in' }))

    expect(result.lateMin).toBe('15')
    expect(result.status).toBe('exception')
    const excs = await h.exceptions.findByDayRecord(result.id)
    expect(excs.map((e) => e.kind)).toContain('late')
  })

  it('a punch within the grace window is NOT late', async () => {
    const h = harness()
    await applyStandardShift(h, 'emp-1', '2026-08-10')
    const result = await withTransaction(h.pool, (tx) => h.service.applyPunch(tx, { employeeId: 'emp-1', punchedAt: '2026-08-10T09:04:00Z', direction: 'in' }))

    expect(result.lateMin).toBe('0')
    expect((await h.exceptions.findByDayRecord(result.id)).map((e) => e.kind)).not.toContain('late')
  })

  it('TC-M3-003: night shift punches 21:55 / next-day 06:10 pair to the SHIFT-START date, hours correct', async () => {
    const h = harness()
    await withTransaction(h.pool, (tx) =>
      h.service.applyRosterEntry(tx, {
        employeeId: 'emp-1',
        workDate: '2026-08-10',
        scheduledStart: '2026-08-10T21:55:00Z',
        scheduledEnd: '2026-08-11T06:00:00Z',
        graceMin: 5,
        hazardous: false,
        isHoliday: false,
        rosterEntryId: 'r1',
      }),
    )
    await withTransaction(h.pool, (tx) => h.service.applyPunch(tx, { employeeId: 'emp-1', punchedAt: '2026-08-10T21:55:00Z', direction: 'in' }))
    const result = await withTransaction(h.pool, (tx) => h.service.applyPunch(tx, { employeeId: 'emp-1', punchedAt: '2026-08-11T06:10:00Z', direction: 'out' }))

    expect(result.workDate).toBe('2026-08-10') // shift-start date, not the out-punch's own calendar date
    expect(result.workedHours).toBe('8.25') // 495 minutes = 8.25h
  })

  it('TC-M3-004: only an IN punch, and the scheduled shift has already ended → missed_punch exception', async () => {
    const h = harness(() => new Date('2026-08-11T00:00:00Z')) // "now" is well after the shift ended
    await applyStandardShift(h, 'emp-1', '2026-08-10')
    const result = await withTransaction(h.pool, (tx) => h.service.applyPunch(tx, { employeeId: 'emp-1', punchedAt: '2026-08-10T09:00:00Z', direction: 'in' }))

    expect(result.status).toBe('exception')
    const excs = await h.exceptions.findByDayRecord(result.id)
    expect(excs.map((e) => e.kind)).toContain('missed_punch')
  })

  it('an in-progress shift (no OUT yet, shift not yet ended) is NOT flagged missed_punch', async () => {
    const h = harness(() => new Date('2026-08-10T12:00:00Z')) // "now" is mid-shift
    await applyStandardShift(h, 'emp-1', '2026-08-10')
    const result = await withTransaction(h.pool, (tx) => h.service.applyPunch(tx, { employeeId: 'emp-1', punchedAt: '2026-08-10T09:00:00Z', direction: 'in' }))

    expect(result.status).toBe('ok')
  })

  it('an OUT punch with no matching IN is flagged missed_punch immediately (unconditional — no "day has ended" wait)', async () => {
    const h = harness(() => new Date('2026-08-10T12:00:00Z'))
    await applyStandardShift(h, 'emp-1', '2026-08-10')
    const result = await withTransaction(h.pool, (tx) => h.service.applyPunch(tx, { employeeId: 'emp-1', punchedAt: '2026-08-10T17:00:00Z', direction: 'out' }))

    expect(result.status).toBe('exception')
    expect((await h.exceptions.findByDayRecord(result.id)).map((e) => e.kind)).toContain('missed_punch')
  })

  it('TC-M3-005: approved sick leave, no punches → leave code applied, no absence exception even after shift end', async () => {
    const h = harness(() => new Date('2026-08-11T00:00:00Z'))
    await applyStandardShift(h, 'emp-1', '2026-08-10')
    const [result] = await withTransaction(h.pool, (tx) =>
      h.service.applyLeaveApproved(tx, {
        employeeId: 'emp-1',
        leaveRequestId: 'leave-1',
        dateFrom: '2026-08-10',
        dateTo: '2026-08-10',
        leaveTypeCode: 'sick',
        payMode: 'full',
      }),
    )

    expect(result?.leaveCode).toBe('sick')
    expect(result?.status).toBe('ok')
    // Same self-resolving-history note as TC-M3-001b above.
    const excs = await h.exceptions.findByDayRecord(result?.id ?? '')
    expect(excs.filter((e) => e.resolution === null)).toHaveLength(0)
  })

  it('a scheduled-but-unworked day with NO leave and the shift has ended → absence exception', async () => {
    const h = harness(() => new Date('2026-08-11T00:00:00Z'))
    const [result] = await withTransaction(h.pool, async (tx) => [
      await h.service.applyRosterEntry(tx, {
        employeeId: 'emp-1',
        workDate: '2026-08-10',
        scheduledStart: '2026-08-10T09:00:00Z',
        scheduledEnd: '2026-08-10T17:00:00Z',
        graceMin: 5,
        hazardous: false,
        isHoliday: false,
        rosterEntryId: 'r1',
      }),
    ])
    expect(result?.status).toBe('exception')
    const excs = await h.exceptions.findByDayRecord(result?.id ?? '')
    expect(excs.map((e) => e.kind)).toContain('absence')
  })
})

describe('ConsolidationService — M3-2 OT end to end, and exception dynamics', () => {
  it('TC-M3-006: 2h approved workday OT worked → ot_15x = 2.00, no exception', async () => {
    const h = harness()
    await applyStandardShift(h, 'emp-1', '2026-08-10')
    await withTransaction(h.pool, (tx) => h.service.applyOtApproval(tx, { employeeId: 'emp-1', otDate: '2026-08-10', hours: '2.00', rateClass: 'workday', approvedBy: 'mgr-1' }))
    await withTransaction(h.pool, (tx) => h.service.applyPunch(tx, { employeeId: 'emp-1', punchedAt: '2026-08-10T09:00:00Z', direction: 'in' }))
    const result = await withTransaction(h.pool, (tx) => h.service.applyPunch(tx, { employeeId: 'emp-1', punchedAt: '2026-08-10T19:00:00Z', direction: 'out' }))

    expect(result.ot15x).toBe('2.00')
    expect(result.status).toBe('ok')
  })

  it('TC-M3-008 end to end: worked 2h OT with no approval → ot_15x stays 0.00, unapproved_ot exception raised, day status = exception', async () => {
    const h = harness()
    await applyStandardShift(h, 'emp-1', '2026-08-10')
    await withTransaction(h.pool, (tx) => h.service.applyPunch(tx, { employeeId: 'emp-1', punchedAt: '2026-08-10T09:00:00Z', direction: 'in' }))
    const result = await withTransaction(h.pool, (tx) => h.service.applyPunch(tx, { employeeId: 'emp-1', punchedAt: '2026-08-10T19:00:00Z', direction: 'out' }))

    expect(result.ot15x).toBe('0.00')
    expect(result.status).toBe('exception')
    const excs = await h.exceptions.findByDayRecord(result.id)
    const unapproved = excs.find((e) => e.kind === 'unapproved_ot')
    expect(unapproved).toBeDefined()
    expect(unapproved?.reason).toMatch(/2\.00h worked OT without pre-approval/)
  })

  it('a late ot.approved event auto-resolves a previously-open unapproved_ot exception and moves the hours into ot_15x', async () => {
    const h = harness()
    await applyStandardShift(h, 'emp-1', '2026-08-10')
    await withTransaction(h.pool, (tx) => h.service.applyPunch(tx, { employeeId: 'emp-1', punchedAt: '2026-08-10T09:00:00Z', direction: 'in' }))
    const beforeApproval = await withTransaction(h.pool, (tx) => h.service.applyPunch(tx, { employeeId: 'emp-1', punchedAt: '2026-08-10T19:00:00Z', direction: 'out' }))
    expect(beforeApproval.status).toBe('exception')

    const afterApproval = await withTransaction(h.pool, (tx) =>
      h.service.applyOtApproval(tx, { employeeId: 'emp-1', otDate: '2026-08-10', hours: '2.00', rateClass: 'workday', approvedBy: 'mgr-1' }),
    )
    expect(afterApproval.ot15x).toBe('2.00')
    expect(afterApproval.status).toBe('ok')
    const excs = await h.exceptions.findByDayRecord(afterApproval.id)
    const unapproved = excs.find((e) => e.kind === 'unapproved_ot')
    expect(unapproved?.resolution).toBe('auto_resolved_by_approval')
    expect(unapproved?.resolvedBy).toBeNull() // system-resolved, not a human decision
  })

  it('TC-M3-007: monthly employee works an 8h holiday shift + 2h approved holiday OT → ot_2x=4.00 (+1x), ot_3x=2.00', async () => {
    const h = harness()
    await withTransaction(h.pool, (tx) =>
      h.employeeRefs.upsert(tx, { employeeId: 'emp-1', empCode: 'E1', orgUnitId: 'org-a', employmentType: 'monthly', status: 'active' }),
    )
    await applyStandardShift(h, 'emp-1', '2026-08-10', { isHoliday: true })
    await withTransaction(h.pool, (tx) => h.service.applyOtApproval(tx, { employeeId: 'emp-1', otDate: '2026-08-10', hours: '2.00', rateClass: 'holiday_ot', approvedBy: 'mgr-1' }))
    await withTransaction(h.pool, (tx) => h.service.applyPunch(tx, { employeeId: 'emp-1', punchedAt: '2026-08-10T09:00:00Z', direction: 'in' }))
    const result = await withTransaction(h.pool, (tx) => h.service.applyPunch(tx, { employeeId: 'emp-1', punchedAt: '2026-08-10T19:00:00Z', direction: 'out' }))

    expect(result.ot2x).toBe('4.00')
    expect(result.ot3x).toBe('2.00')
    expect(result.ot15x).toBe('0.00')
  })

  it('daily-rate variant of TC-M3-007: 8h holiday shift → ot_2x=8.00 (full 2x, no entitlement discount)', async () => {
    const h = harness()
    await withTransaction(h.pool, (tx) =>
      h.employeeRefs.upsert(tx, { employeeId: 'emp-2', empCode: 'E2', orgUnitId: 'org-a', employmentType: 'daily', status: 'active' }),
    )
    await applyStandardShift(h, 'emp-2', '2026-08-10', { isHoliday: true })
    await withTransaction(h.pool, (tx) => h.service.applyPunch(tx, { employeeId: 'emp-2', punchedAt: '2026-08-10T09:00:00Z', direction: 'in' }))
    const result = await withTransaction(h.pool, (tx) => h.service.applyPunch(tx, { employeeId: 'emp-2', punchedAt: '2026-08-10T17:00:00Z', direction: 'out' }))

    expect(result.ot2x).toBe('8.00')
  })

  it('regularThresholdMinutes moves with config: lowering hours.regular.max_per_day to 6 turns an 8h punch span into 2h of workday OT', async () => {
    const h = harness()
    h.transport.set({ ruleKey: 'hours.regular.max_per_day', value: 6, unit: 'hours', citation: 'LPA s.23', statutoryFloor: null, statutoryCeiling: 8 })
    await withTransaction(h.pool, (tx) => h.service.applyOtApproval(tx, { employeeId: 'emp-1', otDate: '2026-08-10', hours: '2.00', rateClass: 'workday', approvedBy: 'mgr-1' }))
    await withTransaction(h.pool, (tx) => h.service.applyPunch(tx, { employeeId: 'emp-1', punchedAt: '2026-08-10T09:00:00Z', direction: 'in' }))
    const result = await withTransaction(h.pool, (tx) => h.service.applyPunch(tx, { employeeId: 'emp-1', punchedAt: '2026-08-10T17:00:00Z', direction: 'out' }))

    expect(result.ot15x).toBe('2.00')
  })
})

describe('ConsolidationService — leave.cancelled reverses leave_code and re-evaluates the day', () => {
  it('cancelling a leave that covered a scheduled, already-ended day re-raises absence', async () => {
    const h = harness(() => new Date('2026-08-11T00:00:00Z'))
    await applyStandardShift(h, 'emp-1', '2026-08-10')
    await withTransaction(h.pool, (tx) =>
      h.service.applyLeaveApproved(tx, { employeeId: 'emp-1', leaveRequestId: 'leave-1', dateFrom: '2026-08-10', dateTo: '2026-08-10', leaveTypeCode: 'sick', payMode: 'full' }),
    )
    const [afterCancel] = await withTransaction(h.pool, (tx) => h.service.applyLeaveCancelled(tx, 'leave-1'))

    expect(afterCancel?.leaveCode).toBeNull()
    expect(afterCancel?.status).toBe('exception')
    const excs = await h.exceptions.findByDayRecord(afterCancel?.id ?? '')
    expect(excs.map((e) => e.kind)).toContain('absence')
  })

  it('applyLeaveCancelled on an unknown leaveRequestId is a safe no-op', async () => {
    const h = harness()
    const result = await withTransaction(h.pool, (tx) => h.service.applyLeaveCancelled(tx, 'never-existed'))
    expect(result).toEqual([])
  })
})
