import { GadongError } from '@gadong/kernel'

/**
 * `LVE-*` error codes — the "Error codes (extract)" table in
 * `docs/05-modules/M5-LEAVE.md` §3, plus the 404/403/409 shapes every
 * sibling service's error module carries for "not found"/"forbidden"/
 * "already decided" that the module doc's extract doesn't itemise.
 *
 * `belowStatutoryFloor` is the single most important one (Task brief: "the
 * rejection is the single most important interaction in this module"): its
 * `details[0]` always carries the `citation` the caller passed in — never a
 * literal string here — because that citation comes from `svc-config` at
 * request time, not from this file (see `config-client.ts` / `leave-types.service.ts`).
 */

export function insufficientBalance(employeeId: string, leaveTypeId: string, requested: string, available: string): GadongError {
  return new GadongError('LVE-010', 'leave.error.insufficient_balance', 422, [
    { employeeId, leaveTypeId, requested, available },
  ])
}

export function medicalCertificateRequired(triggerDays: string): GadongError {
  return new GadongError('LVE-011', 'leave.error.medical_certificate_required', 422, [{ triggerDays }])
}

export function datesOverlap(employeeId: string): GadongError {
  return new GadongError('LVE-020', 'leave.error.dates_overlap', 409, [{ employeeId }])
}

/** The response MUST carry the citation (module doc §1.3, "LVE-030") — an HR admin who cannot see which law blocked them will just try again. */
export function belowStatutoryFloor(ruleKey: string, value: unknown, floor: unknown, citation: string): GadongError {
  return new GadongError('LVE-030', 'leave.error.below_statutory_floor', 422, [{ ruleKey, value, statutoryFloor: floor, citation }])
}

export function cancelWindowPassed(requestId: string): GadongError {
  return new GadongError('LVE-040', 'leave.error.cancel_window_passed', 409, [{ requestId }])
}

export function leaveTypeNotFound(id: string): GadongError {
  return new GadongError('LVE-404', 'leave.error.type_not_found', 404, [{ id }])
}

export function leaveRequestNotFound(id: string): GadongError {
  return new GadongError('LVE-404', 'leave.error.request_not_found', 404, [{ id }])
}

export function approvalStepNotFound(id: string): GadongError {
  return new GadongError('LVE-404', 'leave.error.approval_step_not_found', 404, [{ id }])
}

export function approvalStepAlreadyDecided(id: string): GadongError {
  return new GadongError('LVE-409', 'leave.error.approval_step_already_decided', 409, [{ id }])
}

export function notRequestOwner(requestId: string): GadongError {
  return new GadongError('LVE-403', 'leave.error.not_request_owner', 403, [{ requestId }])
}

export function notAuthorizedApprover(stepId: string): GadongError {
  return new GadongError('LVE-403', 'leave.error.not_authorized_approver', 403, [{ stepId }])
}

export function halfDayMustBeSingleDate(): GadongError {
  return new GadongError('LVE-053', 'leave.error.half_day_must_be_single_date', 422, [])
}

export function requestAlreadyDecided(requestId: string): GadongError {
  return new GadongError('LVE-041', 'leave.error.request_already_decided', 409, [{ requestId }])
}

export function halfDayNotAllowed(leaveTypeId: string): GadongError {
  return new GadongError('LVE-050', 'leave.error.half_day_not_allowed', 422, [{ leaveTypeId }])
}

export function hourlyNotAllowed(leaveTypeId: string): GadongError {
  return new GadongError('LVE-051', 'leave.error.hourly_not_allowed', 422, [{ leaveTypeId }])
}

export function leaveTypeInactive(id: string): GadongError {
  return new GadongError('LVE-052', 'leave.error.type_inactive', 422, [{ id }])
}

/** The `config.statutory_rule` key resolved to no active row at all — a real gap (a floor-governed type with no floor to check against), never a bypass. */
export function statutoryRuleNotResolved(ruleKey: string): GadongError {
  return new GadongError('LVE-503', 'leave.error.statutory_rule_not_resolved', 503, [{ ruleKey }])
}
