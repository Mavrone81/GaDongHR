import { GadongError, writeOutbox } from '@gadong/kernel'
import type { Queryable } from '@gadong/kernel'
import { ExceptionRepository } from './exception.repository'
import type { PeriodRow } from './period.repository'
import { PeriodRepository } from './period.repository'

function lockBlockedByOpenExceptions(periodId: string, openCount: number): GadongError {
  // M3-TIMESHEET.md error catalog: TSH-030 "lock blocked by open exceptions".
  return new GadongError('TSH-030', 'timesheet.error.lock_blocked_by_open_exceptions', 409, [{ periodId, openExceptionCount: openCount }])
}

function periodNotFound(periodId: string): GadongError {
  return new GadongError('TSH-050', 'timesheet.error.period_not_found', 404, [{ periodId }])
}

function periodNotOpen(periodId: string): GadongError {
  return new GadongError('TSH-051', 'timesheet.error.period_not_open', 409, [{ periodId }])
}

function periodNotLocked(periodId: string): GadongError {
  return new GadongError('TSH-052', 'timesheet.error.period_not_locked', 409, [{ periodId }])
}

function unlockReasonRequired(periodId: string): GadongError {
  return new GadongError('TSH-053', 'timesheet.error.unlock_reason_required', 422, [{ periodId }])
}

function periodRangeOverlap(from: string, to: string): GadongError {
  return new GadongError('TSH-054', 'timesheet.error.period_range_overlap', 409, [{ from, to }])
}

export interface LockResult {
  period: PeriodRow
}

export interface UnlockResult {
  period: PeriodRow
  /** M3-4 AC: "a later unlock forces a variance report" — this is the explicit signal `timesheet.unlocked`'s consumer (M7/payroll) must act on; svc-timesheet's own job ends at publishing the event, the report itself is payroll's. */
  varianceReportRequired: true
}

/**
 * M3-4 — HR locks a period before payroll pulls; a subsequent unlock+correct
 * cycle re-locks at an incremented `lock_version`, which is exactly what
 * lets a payroll run pin itself to one immutable set of hours
 * (M3-TIMESHEET.md §1.3 sequence diagram).
 */
export class PeriodService {
  constructor(
    private readonly periods: PeriodRepository,
    private readonly exceptions: ExceptionRepository,
  ) {}

  async create(tx: Queryable, from: string, to: string): Promise<PeriodRow> {
    try {
      return await this.periods.create(tx, from, to)
    } catch {
      // The migration's `EXCLUDE USING gist (range WITH &&)` constraint is
      // what actually prevents two periods from ever claiming an overlapping
      // date (see the migration's own header for why a bare UNIQUE cannot
      // do this) — this catch turns that low-level constraint violation
      // into a typed, i18n-able `GadongError` rather than leaking a raw
      // Postgres error to an HTTP caller.
      throw periodRangeOverlap(from, to)
    }
  }

  async list(): Promise<PeriodRow[]> {
    return this.periods.list()
  }

  /**
   * Guard, explicit per M3-2/M3-4 AC: a period with an open blocking
   * exception (any `time_exception` row with `resolution IS NULL` whose
   * `day_record.work_date` falls in the period's range — missed punch,
   * late, absence, or worked-but-UNAPPROVED OT) refuses to lock (`TSH-030`).
   * This is the mechanical enforcement of "worked OT without pre-approval
   * is flagged for manager regularisation — never silently paid" reaching
   * all the way to payroll: an unresolved `unapproved_ot` exception cannot
   * simply ride along into a locked, payroll-consumed period.
   */
  async lock(tx: Queryable, periodId: string, lockedBy: string): Promise<LockResult> {
    const period = await this.periods.findById(periodId)
    if (!period) throw periodNotFound(periodId)

    const openExceptions = await this.exceptions.findOpenInDateRange(period.from, period.to)
    if (openExceptions.length > 0) throw lockBlockedByOpenExceptions(periodId, openExceptions.length)

    const locked = await this.periods.lock(tx, periodId, lockedBy)
    if (!locked) throw periodNotOpen(periodId) // lost a race, or already locked

    await writeOutbox(tx, 'timesheet', 'timesheet.locked', {
      periodId: locked.id,
      dateRange: { from: locked.from, to: locked.to },
      lockVersion: locked.lockVersion,
      lockedBy,
    })

    return { period: locked }
  }

  /**
   * Requires a non-empty `reason` and (per M3-TIMESHEET.md API #9)
   * `payroll.run.approve` — the PERMISSION check itself is the controller's
   * job (`@RequirePermission`), not this service's; this service enforces
   * the reason and always publishes `timesheet.unlocked`, which forces a
   * payroll variance report (M3-4 AC, verbatim). `lock_version` is left
   * untouched here (see `PeriodRepository.unlock`'s doc) — it advances on
   * the NEXT `lock` call, not on unlock itself.
   */
  async unlock(tx: Queryable, periodId: string, unlockedBy: string, reason: string): Promise<UnlockResult> {
    if (!reason || reason.trim().length === 0) throw unlockReasonRequired(periodId)

    const period = await this.periods.findById(periodId)
    if (!period) throw periodNotFound(periodId)

    const unlocked = await this.periods.unlock(tx, periodId)
    if (!unlocked) throw periodNotLocked(periodId)

    await writeOutbox(tx, 'timesheet', 'timesheet.unlocked', {
      periodId: unlocked.id,
      dateRange: { from: unlocked.from, to: unlocked.to },
      lockVersion: unlocked.lockVersion,
      unlockedBy,
      reason,
    })

    return { period: unlocked, varianceReportRequired: true }
  }
}
