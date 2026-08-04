import { GadongError } from '@gadong/kernel'
import { minutesToHoursString } from './hours'

/**
 * M3-2 — the highest-stakes logic in this module (Task brief: "the OT
 * classification you write here is multiplied directly into pay"). Pure
 * function, zero I/O, so it can be driven to 100% branch coverage directly —
 * every number it compares against (`regularThresholdMinutes`, the
 * hourly-base divisor) is a caller-supplied parameter resolved from
 * `svc-config` upstream (`ConfigClient`), never a literal in this file
 * (brief CONSTRAINTS: "No multiplier or divisor hard-coded in a `.ts` file
 * outside a test fixture").
 *
 * `employmentType` drives exactly one branch: whether this employee is
 * "entitled to paid holidays" (LPA s.62) — `monthly` staff already receive
 * their normal day's wage for a holiday whether or not they work it, so the
 * law only owes them a further +1× for hours actually worked; `daily`/
 * `hourly`/`contract` staff receive nothing for an unworked holiday, so the
 * law owes them the full 2× for hours worked. Every other employment type is
 * treated as the NOT-entitled (2×) case — Thai practice extends the
 * paid-holiday entitlement to monthly-rated staff specifically, not as a
 * general default (Statutory Spec §4, `ot.holiday_work.multiplier`).
 */
export type EmploymentType = 'monthly' | 'daily' | 'hourly' | 'contract'

export interface OtClassifierInput {
  /** Total minutes actually worked this employee-day (from paired punches), already floored at 0. */
  workedMinutes: number
  /**
   * The regular-hours ceiling for this day, in minutes — resolved from
   * `svc-config`'s `hours.regular.max_per_day` (or the scheduled shift's
   * paid duration if shorter; the caller decides which, this function only
   * takes the number). Minutes worked beyond this are the OT candidate pool.
   */
  regularThresholdMinutes: number
  /** Whether `workDate` is a public holiday (resolved from the scheduler's holiday calendar). */
  isHoliday: boolean
  employmentType: EmploymentType
  /**
   * Minutes of OT pre-approved for this employee-day, from `ot.approved`
   * events (any rate class — a given day has at most one active OT bucket,
   * see the class-invariant note on `ot15xMinutes`/`ot3xMinutes` below).
   */
  approvedOtMinutes: number
}

export interface OtClassifierResult {
  /** Workday OT (1.5×) — only ever non-zero on a non-holiday day. */
  ot15xMinutes: number
  /**
   * Holiday-WORK premium (LPA s.62), always paid regardless of approval —
   * this is not overtime consent-gated the way OT is (M2-5/LPA s.24 governs
   * OT consent specifically); it is the statutory premium owed simply for
   * being rostered onto a scheduled holiday shift and showing up.
   *
   * INVARIANT this column encodes: `ot2xMinutes` is always "minutes payable
   * at exactly 2× the hourly base" — the same fixed rate `ot_2x` is named
   * for and that payroll (M7) multiplies it by uniformly. For a monthly
   * (paid-holiday-entitled) employee the LAW only owes a further +1×
   * (they already keep their normal day's wage), so this function stores
   * HALF the regular holiday-work minutes here: `half × 2× = 1×`, the
   * correct additional amount. For a daily/hourly/contract employee the law
   * owes the full 2×, so the full regular holiday-work minutes are stored.
   * `worked_hours` (a separate `day_record` column, untouched by this
   * function) always carries the true, unscaled minutes actually worked —
   * nothing about the real hours worked is lost or hidden by this scaling,
   * only the PAYABLE-AT-2× equivalent is derived. See `ot-classifier.test.ts`
   * for the worked TC-M3-007 example (8h monthly → 4.00; 8h daily → 8.00).
   */
  ot2xMinutes: number
  /** Holiday OT (3×) — the portion of a holiday's worked minutes beyond the regular threshold. Flat 3× for every employment type (LPA s.63 draws no monthly/daily distinction here). */
  ot3xMinutes: number
  /**
   * M3-2 AC, verbatim: "worked OT without pre-approval is flagged for
   * manager regularisation — never silently paid, never silently dropped."
   * Minutes of OT actually worked beyond what was pre-approved. These
   * minutes are EXCLUDED from `ot15xMinutes`/`ot3xMinutes` (not silently
   * paid) but are returned here, not discarded (not silently dropped) — the
   * caller (`ConsolidationService`) is responsible for turning a positive
   * value into an `unapproved_ot` exception queued for manager
   * regularisation, carrying this exact figure.
   */
  unapprovedOtMinutes: number
}

function nonNegative(label: string, minutes: number): number {
  if (minutes < 0) throw new Error(`ot-classifier: ${label} must not be negative, got ${minutes}`)
  return minutes
}

/**
 * `MergeEngine`/`ConsolidationService`'s core: splits a day's worked minutes
 * into the three statutory rate-class buckets plus an unapproved-OT residue.
 * Every branch is deliberately independent and total (no fallthrough), which
 * is what makes 100% branch coverage on this function a meaningful
 * guarantee rather than an artefact of a lucky test order.
 */
export function classifyOt(input: OtClassifierInput): OtClassifierResult {
  const workedMinutes = nonNegative('workedMinutes', input.workedMinutes)
  const regularThresholdMinutes = nonNegative('regularThresholdMinutes', input.regularThresholdMinutes)
  const approvedOtMinutes = nonNegative('approvedOtMinutes', input.approvedOtMinutes)

  const regularMinutes = Math.min(workedMinutes, regularThresholdMinutes)
  const otCandidateMinutes = Math.max(0, workedMinutes - regularThresholdMinutes)

  // Only the OT candidate pool is approval-gated — LPA s.24 governs consent
  // for OVERTIME specifically, not for merely working a scheduled holiday
  // shift within the regular-hours ceiling (that premium, ot2xMinutes below,
  // is never gated on approval).
  const approvedPortionMinutes = Math.min(otCandidateMinutes, approvedOtMinutes)
  const unapprovedOtMinutes = otCandidateMinutes - approvedPortionMinutes

  if (input.isHoliday) {
    const entitledToPaidHoliday = input.employmentType === 'monthly'
    const holidayWorkMinutes = entitledToPaidHoliday ? regularMinutes / 2 : regularMinutes
    return {
      ot15xMinutes: 0,
      ot2xMinutes: holidayWorkMinutes,
      ot3xMinutes: approvedPortionMinutes,
      unapprovedOtMinutes,
    }
  }

  return {
    ot15xMinutes: approvedPortionMinutes,
    ot2xMinutes: 0,
    ot3xMinutes: 0,
    unapprovedOtMinutes,
  }
}

/** `classifyOt`'s result, converted to the fixed 2-decimal `numeric` hour strings `day_record`'s `ot_15x`/`ot_2x`/`ot_3x` columns store. */
export function classifyOtHours(input: OtClassifierInput): {
  ot15x: string
  ot2x: string
  ot3x: string
  unapprovedOtHours: string
} {
  const result = classifyOt(input)
  return {
    ot15x: minutesToHoursString(Math.round(result.ot15xMinutes)),
    ot2x: minutesToHoursString(Math.round(result.ot2xMinutes)),
    ot3x: minutesToHoursString(Math.round(result.ot3xMinutes)),
    unapprovedOtHours: minutesToHoursString(Math.round(result.unapprovedOtMinutes)),
  }
}

function otFormulaBelowFloor(divisor: number, statutoryDivisor: number, citation: string): GadongError {
  // TSH-040 (M3-TIMESHEET.md error catalog): "OT formula config would
  // underpay statutory floor (rejected at config layer, surfaced here)".
  // svc-config's own write-time floor validation is the primary gate; this
  // is defense-in-depth so a value that slipped through (or an
  // effective-dated rule that was valid on write but is being read for a
  // date it should no longer apply to) can never silently produce an
  // underpaying hourly base here.
  return new GadongError('TSH-040', 'timesheet.error.ot_formula_below_floor', 422, [
    { divisor, statutoryDivisor, citation },
  ])
}

/**
 * `hourlyBase = monthly ÷ 30 ÷ 8` by default (Statutory Spec §4
 * `ot.hourly_base.formula`), expressed here as a single divisor
 * (`30 × 8 = 240`) resolved from `svc-config`'s `ot.hourly_base.divisor` —
 * never hard-coded (brief CONSTRAINTS). A company may configure a SMALLER
 * divisor (e.g. 26 working days × 8h = 208), which raises the hourly base —
 * more generous, always allowed. A LARGER divisor lowers the hourly base
 * below the statutory floor, which this function rejects with TSH-040
 * BEFORE computing a result, rather than returning an underpaying number for
 * the caller to (maybe) notice later.
 */
export function hourlyBase(
  monthlyWage: number,
  divisor: number,
  statutoryDivisor: number,
  citation: string,
): number {
  if (divisor > statutoryDivisor) {
    throw otFormulaBelowFloor(divisor, statutoryDivisor, citation)
  }
  return monthlyWage / divisor
}
