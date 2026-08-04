import type { Queryable } from '@gadong/kernel'
import { ConfigClient } from './config-client'
import { CorrectionAuditRepository } from './correction-audit.repository'
import type { DayRecordRow, DayStatus } from './day-record.repository'
import { DayRecordRepository } from './day-record.repository'
import { EmployeeRefRepository } from './employee-ref.repository'
import type { EmploymentType } from './ot-classifier'
import { classifyOtHours } from './ot-classifier'
import { ExceptionRepository } from './exception.repository'
import { addDays, dateOf, dateRange, hoursStringToMinutes, minutesBetween, minutesToHoursString } from './hours'
import { LeaveRefRepository } from './leave-ref.repository'
import { OtApprovalRefRepository } from './ot-approval-ref.repository'
import type { UpsertRosterRef } from './roster-ref.repository'
import { RosterRefRepository } from './roster-ref.repository'

/** How far back an OUT punch may reach to find the OPEN (actual_in set, actual_out null) day_record it closes — long enough to cover any real night shift, short enough that a genuinely separate day's stray IN punch is never mistaken for the same shift. */
export const PUNCH_PAIR_LOOKBACK_MINUTES = 20 * 60

export type PunchDirection = 'in' | 'out'

export interface PunchInput {
  employeeId: string
  punchedAt: string
  direction: PunchDirection
}

export interface RosterEntryInput {
  employeeId: string
  workDate: string
  scheduledStart: string
  scheduledEnd: string
  graceMin: number
  hazardous: boolean
  isHoliday: boolean
  rosterEntryId: string
}

export interface LeaveApprovedInput {
  employeeId: string
  leaveRequestId: string
  dateFrom: string
  dateTo: string
  leaveTypeCode: string
  payMode: string
}

export interface OtApprovedInput {
  employeeId: string
  otDate: string
  hours: string
  rateClass: string
  approvedBy: string
}

function toEmploymentType(v: string | undefined): EmploymentType {
  if (v === 'monthly' || v === 'daily' || v === 'hourly' || v === 'contract') return v
  // No employee_ref row yet (employee.* event not yet consumed) — treat as
  // the NOT-entitled-to-paid-holiday case, the more conservative of the two
  // holiday-work multipliers (2x, never the lesser +1x), so a race between
  // `employee.created` and this employee's first punch never under-pays.
  return 'daily'
}

/**
 * M3-1/M3-2 — `MergeEngine` (M3-TIMESHEET.md class diagram): merges
 * attendance punches, roster entries, approved leave and approved OT into
 * one `day_record` per employee-day, and drives `OtClassifier`. Every
 * `apply*` method is the single place a `day_record` for that employee-day
 * is created if it does not exist yet (via `DayRecordRepository.ensureExists`)
 * and always ends by calling `recomputeDay`, so no matter which of the four
 * event kinds arrives first, the resulting row is always fully consistent
 * with whatever inputs are known so far.
 */
export class ConsolidationService {
  constructor(
    private readonly dayRecords: DayRecordRepository,
    private readonly exceptions: ExceptionRepository,
    private readonly rosterRefs: RosterRefRepository,
    private readonly leaveRefs: LeaveRefRepository,
    private readonly otApprovalRefs: OtApprovalRefRepository,
    private readonly employeeRefs: EmployeeRefRepository,
    private readonly correctionAudits: CorrectionAuditRepository,
    private readonly configClient: ConfigClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // ---------- attendance.punch ----------

  async applyPunch(tx: Queryable, input: PunchInput): Promise<DayRecordRow> {
    if (input.direction === 'out') {
      const open = await this.dayRecords.findOpenForEmployee(input.employeeId, input.punchedAt, PUNCH_PAIR_LOOKBACK_MINUTES, tx)
      if (open) {
        await this.dayRecords.setActualOut(tx, open.id, input.punchedAt)
        return this.recomputeDay(tx, input.employeeId, open.workDate)
      }
      // An OUT punch with no matching OPEN day_record — a genuine missing-IN
      // case. Attribute it to its own calendar date (best available guess)
      // and let recompute raise `missed_punch` for the absent actual_in.
      const workDate = await this.resolveWorkDateForNewPunch(tx, input.employeeId, input.punchedAt)
      const day = await this.dayRecords.ensureExists(tx, input.employeeId, workDate, null)
      await this.dayRecords.setActualOut(tx, day.id, input.punchedAt)
      return this.recomputeDay(tx, input.employeeId, workDate)
    }

    const workDate = await this.resolveWorkDateForNewPunch(tx, input.employeeId, input.punchedAt)
    const day = await this.dayRecords.ensureExists(tx, input.employeeId, workDate, null)
    await this.dayRecords.setActualInIfAbsent(tx, day.id, input.punchedAt)
    return this.recomputeDay(tx, input.employeeId, workDate)
  }

  /** Roster-aware work-date resolution for a NEW punch (the day_record-open lookup in `applyPunch` already handles a night shift's OUT punch without needing this at all): checks yesterday's and today's scheduled shift window before falling back to the punch's own calendar date. */
  private async resolveWorkDateForNewPunch(tx: Queryable, employeeId: string, punchedAt: string): Promise<string> {
    const today = dateOf(punchedAt)
    const yesterday = addDays(today, -1)
    for (const candidate of [yesterday, today]) {
      const roster = await this.rosterRefs.findOne(employeeId, candidate, tx)
      if (roster?.scheduledStart && roster.scheduledEnd) {
        const graceMs = roster.graceMin * 60_000
        const windowStart = Date.parse(roster.scheduledStart) - graceMs
        const windowEnd = Date.parse(roster.scheduledEnd) + graceMs
        const punchMs = Date.parse(punchedAt)
        if (punchMs >= windowStart && punchMs <= windowEnd) return candidate
      }
    }
    return today
  }

  // ---------- roster.published (per-entry) ----------

  async applyRosterEntry(tx: Queryable, input: RosterEntryInput): Promise<DayRecordRow> {
    const upsert: UpsertRosterRef = {
      employeeId: input.employeeId,
      workDate: input.workDate,
      scheduledStart: input.scheduledStart,
      scheduledEnd: input.scheduledEnd,
      graceMin: input.graceMin,
      hazardous: input.hazardous,
      isHoliday: input.isHoliday,
      rosterEntryId: input.rosterEntryId,
    }
    await this.rosterRefs.upsert(tx, upsert)
    await this.dayRecords.ensureExists(tx, input.employeeId, input.workDate, input.rosterEntryId)
    return this.recomputeDay(tx, input.employeeId, input.workDate)
  }

  // ---------- leave.approved / leave.cancelled ----------

  async applyLeaveApproved(tx: Queryable, input: LeaveApprovedInput): Promise<DayRecordRow[]> {
    await this.leaveRefs.upsertApproved(tx, input)
    const results: DayRecordRow[] = []
    for (const workDate of dateRange(input.dateFrom, input.dateTo)) {
      const day = await this.dayRecords.ensureExists(tx, input.employeeId, workDate, null)
      await this.dayRecords.setLeaveCode(tx, day.id, input.leaveTypeCode)
      results.push(await this.recomputeDay(tx, input.employeeId, workDate))
    }
    return results
  }

  async applyLeaveCancelled(tx: Queryable, leaveRequestId: string): Promise<DayRecordRow[]> {
    const existing = await this.leaveRefs.findByRequestId(leaveRequestId, tx)
    if (!existing) return []
    await this.leaveRefs.markCancelled(tx, leaveRequestId)
    const results: DayRecordRow[] = []
    for (const workDate of dateRange(existing.dateFrom, existing.dateTo)) {
      const day = await this.dayRecords.findOne(existing.employeeId, workDate, tx)
      if (!day) continue
      await this.dayRecords.setLeaveCode(tx, day.id, null)
      results.push(await this.recomputeDay(tx, existing.employeeId, workDate))
    }
    return results
  }

  // ---------- ot.approved ----------

  async applyOtApproval(tx: Queryable, input: OtApprovedInput): Promise<DayRecordRow> {
    await this.otApprovalRefs.upsertAdd(tx, {
      employeeId: input.employeeId,
      otDate: input.otDate,
      rateClass: input.rateClass,
      hours: input.hours,
      approvedBy: input.approvedBy,
    })
    await this.dayRecords.ensureExists(tx, input.employeeId, input.otDate, null)
    return this.recomputeDay(tx, input.employeeId, input.otDate)
  }

  // ---------- recompute ----------

  /**
   * Rebuilds worked hours / late minutes / the three OT buckets for one
   * employee-day from whatever inputs are currently known (punches, roster,
   * leave, OT approvals), and reconciles the exception queue: raises
   * `unapproved_ot` when the classifier reports unapproved minutes and no
   * such exception is already open, auto-resolves one that no longer
   * applies, and raises `late`/`absence`/`missed_punch` once (never
   * duplicated — `findOpenByDayRecordAndKind` guards every raise).
   */
  async recomputeDay(tx: Queryable, employeeId: string, workDate: string): Promise<DayRecordRow> {
    const day = await this.dayRecords.ensureExists(tx, employeeId, workDate, null)
    const roster = await this.rosterRefs.findOne(employeeId, workDate, tx)
    const employeeRef = await this.employeeRefs.findById(employeeId, tx)
    const employmentType = toEmploymentType(employeeRef?.employmentType)

    const workedMinutes = day.actualIn && day.actualOut ? minutesBetween(day.actualIn, day.actualOut) : 0

    const regularThreshold = await this.configClient.getNumber('hours.regular.max_per_day')
    const regularThresholdMinutes = Math.round(regularThreshold.value * 60)

    const approvals = await this.otApprovalRefs.findByEmployeeAndDate(employeeId, workDate, tx)
    const approvedOtMinutes = approvals.reduce((sum, a) => sum + hoursStringToMinutes(a.hours), 0)

    const isHoliday = roster?.isHoliday ?? false
    const classified = classifyOtHours({
      workedMinutes,
      regularThresholdMinutes,
      isHoliday,
      employmentType,
      approvedOtMinutes,
    })

    // late_min is a plain minute COUNT (an int-shaped `numeric` column,
    // Task 14 migration), never an hours-formatted string.
    let lateMinutes = 0
    if (roster?.scheduledStart && day.actualIn) {
      const graceMs = roster.graceMin * 60_000
      const lateMs = Date.parse(day.actualIn) - (Date.parse(roster.scheduledStart) + graceMs)
      if (lateMs > 0) lateMinutes = Math.round(lateMs / 60_000)
    }

    const withComputed = await this.dayRecords.updateComputed(tx, day.id, {
      workedHours: minutesToHoursString(workedMinutes),
      lateMin: String(lateMinutes),
      ot15x: classified.ot15x,
      ot2x: classified.ot2x,
      ot3x: classified.ot3x,
      status: 'ok', // provisional; the exception reconciliation below may flip this to 'exception' or 'corrected'
    })

    const dayHasEnded = roster?.scheduledEnd ? Date.parse(roster.scheduledEnd) < this.now().getTime() : false
    const unapprovedOtMinutes = hoursStringToMinutes(classified.unapprovedOtHours)

    // Every open-check below reads through `tx` — the SAME connection a
    // `raise()`/`autoResolve()` call just wrote through in this same,
    // still-uncommitted transaction. Reading through the repository's own
    // plain (non-tx) connection here would miss an insert this very
    // transaction just made (it is not committed yet, so a different
    // connection cannot see it) — exactly the bug that let a freshly-raised
    // `absence` exception fail to flip `day_record.status` to `'exception'`
    // in the same recompute call that raised it.
    //
    // All four exception kinds are DYNAMIC here in the same sense
    // `unapproved_ot` is: `reconcile` re-evaluates the live condition on
    // every recompute and raises/auto-resolves accordingly — a `missed_punch`
    // raised because an out-punch had not arrived yet self-resolves the
    // moment that punch DOES arrive (PRD M4-4 AC: a punch can queue during
    // broker downtime and deliver late; the exception it briefly caused must
    // not outlive the data that made it stale). This is distinct from a
    // MANUAL correction (M3-3's audited who/when/why path, `ExceptionsService.
    // propose`/`confirm`) — that flow is for a human fixing a fact the system
    // cannot resolve on its own (e.g. a genuinely forgotten punch that will
    // never arrive), and always wins: `reconcile` never touches a `proposed:`
    // or already-resolved row (`findOpenByDayRecordAndKindTx` only ever
    // returns a row with `resolution IS NULL`, so a resolved/proposed
    // exception is simply invisible to this reconciliation and left alone).
    let anyOpenException = false

    const reconcile = async (kind: Parameters<ExceptionRepository['raise']>[2], active: boolean, raiseReason: string, autoResolveReason: string): Promise<void> => {
      const open = await this.exceptions.findOpenByDayRecordAndKindTx(tx, day.id, kind)
      if (active) {
        anyOpenException = true
        if (!open) await this.exceptions.raise(tx, day.id, kind, raiseReason)
      } else if (open) {
        await this.exceptions.autoResolve(tx, open.id, autoResolveReason)
      }
    }

    await reconcile(
      'unapproved_ot',
      unapprovedOtMinutes > 0,
      `${minutesToHoursString(unapprovedOtMinutes)}h worked OT without pre-approval — queued for manager regularisation`,
      'auto_resolved_by_approval',
    )

    await reconcile('late', lateMinutes > 0, `${lateMinutes} minutes late`, 'auto_resolved_no_longer_late')

    // missed_punch: exactly one of actual_in/actual_out set.
    // "in but no out" only counts once the scheduled day has genuinely
    // ended (requires a roster entry to know that) — an in-progress shift
    // with no roster at all is never flagged mid-shift, since there is no
    // signal this service can use to tell "still working" apart from
    // "forgot to punch out". "out but no in" is unconditional: a punch
    // arriving with no preceding in-punch is already an unambiguous fact
    // the moment it happens, nothing to wait for.
    const missingOut = day.actualIn !== null && day.actualOut === null && dayHasEnded
    const missingIn = day.actualIn === null && day.actualOut !== null
    await reconcile(
      'missed_punch',
      (missingOut || missingIn) && day.leaveCode === null,
      missingIn ? 'no in-punch recorded' : 'no out-punch recorded',
      'auto_resolved_punch_arrived',
    )

    // absence: scheduled to work, day has ended, no punches at all, no leave.
    await reconcile(
      'absence',
      roster !== null && dayHasEnded && day.actualIn === null && day.actualOut === null && day.leaveCode === null,
      'scheduled shift, no punches, no approved leave',
      'auto_resolved_no_longer_absent',
    )

    // Status priority: an OPEN exception always wins (most actionable);
    // otherwise, a day_record that has EVER been manually corrected
    // (`correction_audit` has at least one row for it — M3-3's immutable
    // audit trail, not a mutable flag on this row) reports `'corrected'`
    // rather than reverting to plain `'ok'` — that distinction (never had an
    // issue, vs. had one and it was fixed) is exactly what a wage dispute
    // needs this table to keep showing, permanently, not just until the
    // next recompute papers over it.
    const finalStatus: DayStatus = anyOpenException
      ? 'exception'
      : (await this.correctionAudits.hasAnyCorrection(day.id, tx))
        ? 'corrected'
        : 'ok'

    if (finalStatus === withComputed.status) return withComputed
    return this.dayRecords.updateComputed(tx, day.id, {
      workedHours: withComputed.workedHours,
      lateMin: withComputed.lateMin,
      ot15x: withComputed.ot15x,
      ot2x: withComputed.ot2x,
      ot3x: withComputed.ot3x,
      status: finalStatus,
    })
  }
}
