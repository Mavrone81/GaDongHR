import { GadongError } from '@gadong/kernel'

/**
 * `PAY-*` error codes — `docs/05-modules/M7-PAYROLL.md` §3's "Error codes
 * (extract)" table, plus the 404/409 shapes every sibling service's error
 * module carries that the module doc's extract does not itemise.
 *
 * TWO DELIBERATE DIVERGENCES from that table, both documented in this
 * module's report:
 *
 *  1. The segregation-of-duties rejection is the kernel's `sodViolation()`
 *     (`AUZ-409`), NOT the module doc's `PAY-020`/403. The roadmap's error
 *     envelope section reserves `AUZ-409` "segregation-of-duties violation"
 *     ACROSS ALL SERVICES, and `svc-config`'s proposer≠approver control
 *     already uses it. One code for one control, everywhere, beats a
 *     per-module synonym: an auditor grepping for SoD refusals must not
 *     have to know each module's private spelling.
 *  2. No literal statutory figure appears in this file. `belowMinimumWage`
 *     takes the province, the floor and the citation as ARGUMENTS, because
 *     all three come from `svc-config` at request time. An HR officer who
 *     cannot see which notification blocked them will simply try again.
 */

/** PAY-010 — pay below the employee's provincial daily minimum wage. Carries the province, the floor and its citation, all resolved from config. */
export function belowMinimumWage(provinceCode: string, dailyEquivalent: string, floor: string, citation: string): GadongError {
  return new GadongError('PAY-010', 'payroll.error.below_minimum_wage', 422, [
    { provinceCode, dailyEquivalent, statutoryFloor: floor, citation },
  ])
}

/** PAY-011 — the provident-fund rate on a profile is outside the statutory 2–15% band (bounds from config, never from here). */
export function providentFundRateOutOfBand(rate: string, min: string, max: string, citation: string): GadongError {
  return new GadongError('PAY-011', 'payroll.error.pf_rate_out_of_band', 422, [{ rate, min, max, citation }])
}

/** PAY-021 — commit attempted on a run that has not been approved. */
export function commitWithoutApproval(runId: string, status: string): GadongError {
  return new GadongError('PAY-021', 'payroll.error.commit_without_approval', 409, [{ runId, status }])
}

/**
 * PAY-022 — a committed run is evidence in a wage dispute. Every service-level
 * write path checks this before touching the row; the DB triggers from
 * `1754700100000_payroll-child-immutability.js` are the second layer, and the
 * point of having both is that either alone can be defeated by a future bug.
 */
export function committedRunImmutable(runId: string): GadongError {
  return new GadongError('PAY-022', 'payroll.error.committed_run_immutable', 409, [{ runId }])
}

/** PAY-023 — an illegal lifecycle transition (e.g. approve from `draft`). */
export function invalidRunTransition(runId: string, from: string, to: string): GadongError {
  return new GadongError('PAY-023', 'payroll.error.invalid_run_transition', 409, [{ runId, from, to }])
}

/** PAY-024 — an adjustment run must name the committed run it corrects. */
export function adjustmentTargetNotCommitted(runId: string, status: string): GadongError {
  return new GadongError('PAY-024', 'payroll.error.adjustment_target_not_committed', 409, [{ runId, status }])
}

/** PAY-030 — the timesheet lock moved under a calculated run (an unlock happened): recalculation is required before this run can proceed. */
export function timesheetLockStale(runId: string, boundVersion: number, currentVersion: number): GadongError {
  return new GadongError('PAY-030', 'payroll.error.timesheet_lock_stale', 409, [{ runId, boundVersion, currentVersion }])
}

/** PAY-031 — no locked timesheet exists for this period, so there are no hours a run may legitimately bind to. */
export function timesheetNotLocked(period: string): GadongError {
  return new GadongError('PAY-031', 'payroll.error.timesheet_not_locked', 409, [{ period }])
}

/** PAY-040 — no ล.ย.01-equivalent tax declaration on file. Not fatal: the engine falls back to the personal allowance alone and flags the payslip. */
export function taxDeclarationMissing(employeeId: string): GadongError {
  return new GadongError('PAY-040', 'payroll.error.tax_declaration_missing', 422, [{ employeeId }])
}

/** PAY-050 — an export or bank file was requested for a run that is not committed. */
export function exportBeforeCommit(runId: string, status: string): GadongError {
  return new GadongError('PAY-050', 'payroll.error.export_before_commit', 409, [{ runId, status }])
}

/** PAY-051 — an unknown bank format was requested. */
export function unsupportedBankFormat(format: string, supported: readonly string[]): GadongError {
  return new GadongError('PAY-051', 'payroll.error.unsupported_bank_format', 422, [{ format, supported }])
}

/** PAY-052 — a bank file was requested but an in-scope employee has no bank account on file; paying some and silently skipping others is worse than refusing. */
export function bankAccountMissing(employeeId: string): GadongError {
  return new GadongError('PAY-052', 'payroll.error.bank_account_missing', 422, [{ employeeId }])
}

/** PAY-060 — severance withheld under LPA s.119 without the cause and its citation recorded. The DB CHECK is the second layer. */
export function statutoryCauseCitationRequired(employeeId: string): GadongError {
  return new GadongError('PAY-060', 'payroll.error.statutory_cause_citation_required', 422, [{ employeeId }])
}

/** PAY-061 — a final-pay run for an employee with no termination record. */
export function terminationNotRecorded(employeeId: string): GadongError {
  return new GadongError('PAY-061', 'payroll.error.termination_not_recorded', 409, [{ employeeId }])
}

export function payProfileNotFound(employeeId: string): GadongError {
  return new GadongError('PAY-404', 'payroll.error.profile_not_found', 404, [{ employeeId }])
}

export function runNotFound(runId: string): GadongError {
  return new GadongError('PAY-404', 'payroll.error.run_not_found', 404, [{ runId }])
}

export function payslipNotFound(payslipId: string): GadongError {
  return new GadongError('PAY-404', 'payroll.error.payslip_not_found', 404, [{ payslipId }])
}

export function employeeRefNotFound(employeeId: string): GadongError {
  return new GadongError('PAY-404', 'payroll.error.employee_not_found', 404, [{ employeeId }])
}

/**
 * PAY-503 — a required statutory rule resolved to nothing at all for the
 * period being calculated. This FAILS THE RUN. There is deliberately no
 * fallback default: a missing SSO ceiling or missing PIT bracket table is a
 * configuration gap, and computing a payslip anyway — with a guessed figure
 * baked into this codebase — is precisely the defect the "statutory values
 * are data, never code" rule exists to prevent.
 *
 * The EWF date gate is NOT this error. A rule with no version effective on
 * the period date is a legitimate "not yet in force" answer for an
 * optional rule (see `StatutoryResolver.optionalPercent`); only rules the
 * engine declares REQUIRED raise PAY-503.
 */
export function statutoryRuleNotResolved(ruleKey: string, on: string): GadongError {
  return new GadongError('PAY-503', 'payroll.error.statutory_rule_not_resolved', 503, [{ ruleKey, on }])
}

/** PAY-504 — the rule resolved, but its value is not the shape the engine needs (e.g. a bracket table that is not an array). */
export function statutoryRuleMalformed(ruleKey: string, detail: string): GadongError {
  return new GadongError('PAY-504', 'payroll.error.statutory_rule_malformed', 503, [{ ruleKey, detail }])
}
