import { GadongError } from '@gadong/kernel'

/** Error codes per `docs/05-modules/M6-CLAIMS.md` §3 ("Error codes (extract)"), plus a small number this service needs beyond that extract (not-found / state-conflict / validation) that the module doc did not enumerate. */

export function claimTypeNotFound(code: string): GadongError {
  return new GadongError('CLM-404', 'claims.error.type_not_found', 404, [{ code }])
}

export function claimTypeInactive(code: string): GadongError {
  return new GadongError('CLM-409', 'claims.error.type_inactive', 409, [{ code }])
}

export function mileageRateNotConfigured(code: string): GadongError {
  return new GadongError('CLM-013', 'claims.error.mileage_rate_not_configured', 422, [{ code }])
}

export function claimNotFound(id: string): GadongError {
  return new GadongError('CLM-404', 'claims.error.claim_not_found', 404, [{ id }])
}

export function receiptRequired(claimTypeCode: string): GadongError {
  return new GadongError('CLM-012', 'claims.error.receipt_required', 400, [{ claimTypeCode }])
}

export function requiredFieldMissing(field: string): GadongError {
  return new GadongError('CLM-014', 'claims.error.required_field_missing', 400, [{ field }])
}

export function duplicateReceiptSuspected(dupHash: string): GadongError {
  return new GadongError('CLM-011', 'claims.error.duplicate_receipt_suspected', 409, [{ dupHash }])
}

export function hardLimitExceeded(tier: 'per_claim' | 'monthly' | 'annual', limit: string, attempted: string): GadongError {
  return new GadongError('CLM-010', 'claims.error.hard_limit_exceeded', 422, [{ tier, limit, attempted }])
}

/** M6-3: a decision was submitted on a level whose required approver role does not match the caller's route (e.g. a finance decision on a claim with no pending finance-level step). */
export function approverOutsideBand(claimId: string, expectedRole: string | null): GadongError {
  return new GadongError('CLM-020', 'claims.error.approver_outside_band', 403, [{ claimId, expectedRole }])
}

/** M6-3: attempted a route/route-change after the claim already left `approved` (for_payroll/paid_offcycle are locked — see module doc "route change after payroll pull (locked)"). */
export function routeLocked(claimId: string, status: string): GadongError {
  return new GadongError('CLM-030', 'claims.error.route_locked', 409, [{ claimId, status }])
}

export function claimNotPending(claimId: string, status: string): GadongError {
  return new GadongError('CLM-409', 'claims.error.claim_not_pending', 409, [{ claimId, status }])
}

export function claimNotRejected(claimId: string, status: string): GadongError {
  return new GadongError('CLM-409', 'claims.error.claim_not_rejected', 409, [{ claimId, status }])
}

export function claimNotApproved(claimId: string, status: string): GadongError {
  return new GadongError('CLM-409', 'claims.error.claim_not_approved', 409, [{ claimId, status }])
}

export function rejectionReasonRequired(claimId: string): GadongError {
  return new GadongError('CLM-015', 'claims.error.rejection_reason_required', 400, [{ claimId }])
}

export function notClaimOwner(claimId: string): GadongError {
  return new GadongError('CLM-403', 'claims.error.not_claim_owner', 403, [{ claimId }])
}

export function invalidApprovalBandConfig(reason: string): GadongError {
  return new GadongError('CLM-016', 'claims.error.invalid_approval_band_config', 400, [{ reason }])
}
