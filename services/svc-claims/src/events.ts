import type { ClaimRow } from './claims.repository'

/**
 * Pure event-payload builders, deliberately factored out of
 * `claims.service.ts` so `events.test.ts` can assert their shape directly
 * without standing up a database or transaction.
 *
 * Task 14 brief, the safety property this file exists to guarantee:
 * "approved claims route into payroll as a non-taxable reimbursement line
 * kept out of the tax and Social Security wage base — misclassify one as
 * earnings and the employee is over-taxed and the employer's SSO filing is
 * wrong." The roadmap event catalog's minimum shape for
 * `claim.approved_for_payroll` is `{claimId, employeeId, amountThb,
 * claimType}` — this ADDS `taxable: false` and `ssoWageBase: false`
 * explicitly (a superset, not a breaking change) so M7's payroll-line
 * classification cannot miss it by omission. `events.test.ts` proves both
 * that the real builder sets them and that the "carries the flag" assertion
 * genuinely fails against a payload with the flag stripped — the
 * demonstration the Task 14 brief asks for.
 */

export interface ApprovedForPayrollPayload {
  claimId: string
  employeeId: string
  amountThb: string
  claimType: string
  /** Never `true` — an expense reimbursement is never taxable income. Explicit rather than implied so a consumer cannot default it the wrong way. */
  taxable: false
  /** Never `true` — kept out of the Social Security Office wage base. */
  ssoWageBase: false
}

export function buildApprovedForPayrollPayload(claim: ClaimRow): ApprovedForPayrollPayload {
  return {
    claimId: claim.id,
    employeeId: claim.employeeId,
    amountThb: claim.amountThb,
    claimType: claim.claimType,
    taxable: false,
    ssoWageBase: false,
  }
}

export interface PaidOffcyclePayload {
  claimId: string
  employeeId: string
  paidAt: string
  amountThb: string
  claimType: string
  /** Same reasoning as `ApprovedForPayrollPayload.taxable` — an off-cycle bank payment of an approved expense claim is equally a non-taxable reimbursement, not earnings. */
  taxable: false
}

export function buildPaidOffcyclePayload(claim: ClaimRow): PaidOffcyclePayload {
  if (claim.paidAt === null) {
    throw new Error('events.ts: buildPaidOffcyclePayload requires claim.paidAt to be set')
  }
  return {
    claimId: claim.id,
    employeeId: claim.employeeId,
    paidAt: claim.paidAt,
    amountThb: claim.amountThb,
    claimType: claim.claimType,
    taxable: false,
  }
}
