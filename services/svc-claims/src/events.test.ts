import { buildApprovedForPayrollPayload, buildPaidOffcyclePayload } from './events'
import type { ClaimRow } from './claims.repository'

/**
 * Task 14 brief: "the payroll line must be flagged non-taxable and outside
 * the SSO wage base — carry that explicitly in the event payload so M7
 * cannot get it wrong" and "demonstrate that the non-taxable-flag test
 * FAILS when the flag is dropped from the event payload." This suite does
 * both: proves the real builder sets the flags, and proves the assertion is
 * load-bearing by inverting it against a payload with the flag stripped
 * (same technique `claims-schema.test.ts` uses for the migration's
 * assertions).
 */

function approvedClaim(overrides: Partial<ClaimRow> = {}): ClaimRow {
  return {
    id: 'claim-1',
    employeeId: 'emp-1',
    claimType: 'travel',
    amountThb: '1999.00',
    status: 'for_payroll',
    dupHash: 'hash',
    claimDate: '2026-08-01',
    vendor: 'Acme Taxi',
    mileageKm: null,
    vatAmount: null,
    reimbursementRoute: 'payroll',
    rejectionReason: null,
    round: 1,
    softLimitWarning: false,
    submittedAt: '2026-08-01T00:00:00.000Z',
    decidedAt: '2026-08-01T00:00:00.000Z',
    routedAt: '2026-08-01T00:00:00.000Z',
    paidAt: null,
    fields: {},
    ...overrides,
  }
}

describe('events.ts — claim.approved_for_payroll carries the non-taxable flag (Task 14 brief, THE test)', () => {
  it('the real payload sets taxable: false and ssoWageBase: false', () => {
    const payload = buildApprovedForPayrollPayload(approvedClaim())
    expect(payload).toMatchObject({
      claimId: 'claim-1',
      employeeId: 'emp-1',
      amountThb: '1999.00',
      claimType: 'travel',
      taxable: false,
      ssoWageBase: false,
    })
  })

  it('DEMONSTRATION: the "carries the non-taxable flag" assertion genuinely fails when the flag is dropped from the payload', () => {
    const payload = buildApprovedForPayrollPayload(approvedClaim())
    // Simulate "a future edit deleted the flag from events.ts" by deleting
    // it from a copy of the real payload, then re-running the SAME
    // assertion the test above relies on.
    const mutated: Record<string, unknown> = { ...payload }
    delete mutated['taxable']

    expect(() => {
      expect(mutated).toMatchObject({ taxable: false })
    }).toThrow()

    // Sanity: the real (un-mutated) payload does NOT throw against the
    // identical assertion — proving the failure above comes from the
    // mutation, not from a broken matcher.
    expect(() => {
      expect(payload).toMatchObject({ taxable: false })
    }).not.toThrow()
  })

  it('DEMONSTRATION: flipping taxable to true also fails the assertion — a payload that mis-declares the line as taxable is caught, not just a missing key', () => {
    const payload = buildApprovedForPayrollPayload(approvedClaim())
    const mutated = { ...payload, taxable: true }

    expect(() => {
      expect(mutated).toMatchObject({ taxable: false })
    }).toThrow()
  })

  it('claimId/employeeId/amountThb/claimType match the roadmap event catalog minimum shape', () => {
    const payload = buildApprovedForPayrollPayload(approvedClaim({ id: 'claim-9', employeeId: 'emp-9', amountThb: '500.00', claimType: 'meal' }))
    expect(Object.keys(payload).sort()).toEqual(['amountThb', 'claimId', 'claimType', 'employeeId', 'ssoWageBase', 'taxable'])
  })
})

describe('events.ts — claim.paid_offcycle', () => {
  it('carries paidAt and the same non-taxable framing', () => {
    const payload = buildPaidOffcyclePayload(
      approvedClaim({ status: 'paid_offcycle', reimbursementRoute: 'offcycle', paidAt: '2026-08-03T00:00:00.000Z' }),
    )
    expect(payload).toMatchObject({ claimId: 'claim-1', employeeId: 'emp-1', paidAt: '2026-08-03T00:00:00.000Z', taxable: false })
  })

  it('throws if paidAt is not set — a paid_offcycle event must never be built for an unpaid claim', () => {
    expect(() => buildPaidOffcyclePayload(approvedClaim({ paidAt: null }))).toThrow()
  })
})
