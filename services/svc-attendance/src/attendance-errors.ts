import { GadongError } from '@gadong/kernel'

/** M4-ATTENDANCE.md §3's `ATT-*` error extract, plus a small number of additional codes this implementation needs (documented at each call site). */

/**
 * `POST /enrolments/start` (and defence-in-depth in `complete`) without a
 * currently-`granted` biometric consent on file. This is THE compliance
 * gate: PDPA-BIOMETRIC-COMPLIANCE.md §4.1 — enrolment is "technically
 * impossible" without explicit consent, not merely discouraged.
 */
export function enrolmentRequiresConsent(): GadongError {
  return new GadongError('ATT-001', 'attendance.error.enrolment_requires_consent', 409)
}

/** Guided capture quality check failed (pose/lighting/single-face) before any frame reaches the face engine. */
export function captureQualityInsufficient(reason: string): GadongError {
  return new GadongError('ATT-010', 'attendance.error.capture_quality_insufficient', 422, [{ reason }])
}

/** M4-3: passive/active liveness check failed — photo/video replay defeated. No punch is recorded; a security event is. */
export function livenessCheckFailed(): GadongError {
  return new GadongError('ATT-020', 'attendance.error.liveness_failed', 422)
}

/** 1:N (kiosk) or 1:1 (mobile) match score fell below the configured threshold. */
export function noMatchAboveThreshold(): GadongError {
  return new GadongError('ATT-021', 'attendance.error.no_match', 404)
}

/** M4-9: kiosk anti-tailgating — more than one face in frame. Logged, no punch. */
export function multipleFacesDetected(): GadongError {
  return new GadongError('ATT-022', 'attendance.error.multiple_faces', 422)
}

/** Device HMAC signature invalid, or the device is not (yet, or no longer) `active`. */
export function deviceNotApproved(): GadongError {
  return new GadongError('ATT-030', 'attendance.error.device_not_approved', 401)
}

/** `POST /devices/:id/approve` by the same actor who registered the device — segregation of duties (kernel `sodViolation` is for the same-actor-both-sides shape; this is the attendance-specific instance of it). */
export function deviceApprovalRequiresSecondPerson(): GadongError {
  return new GadongError('ATT-031', 'attendance.error.device_approval_requires_second_person', 409)
}

export function enrolmentNotFound(employeeId: string): GadongError {
  return new GadongError('ATT-050', 'attendance.error.enrolment_not_found', 404, [{ employeeId }])
}

/** DATABASE-DESIGN §2.2 models one enrolment per employee — `enrollment_employee_id_key UNIQUE` is the belt; this is the brace. */
export function enrolmentAlreadyExists(employeeId: string): GadongError {
  return new GadongError('ATT-051', 'attendance.error.enrolment_already_exists', 409, [{ employeeId }])
}

export function enrolmentSessionNotFound(session: string): GadongError {
  return new GadongError('ATT-052', 'attendance.error.enrolment_session_not_found', 404, [{ session }])
}

/**
 * The engine's own DELETE succeeded (or was called), but the follow-up
 * existence check still reports the subject present — PDPA §7 requires
 * VERIFIED deletion, not an assumed one. This must fail the whole
 * operation (the caller's transaction rolls back, `processed_events` is
 * never committed, and the triggering event is redelivered for retry) —
 * never be swallowed into a silent success.
 */
export function templateDeletionNotVerified(employeeId: string): GadongError {
  return new GadongError('ATT-060', 'attendance.error.template_deletion_not_verified', 502, [{ employeeId }])
}

/** Face engine (CompreFace) unreachable — kiosks/mobile must fall back to the alternative method (M4-5), never lose a punch. */
export function faceEngineUnavailable(): GadongError {
  return new GadongError('ATT-070', 'attendance.error.face_engine_unavailable', 503)
}

/** `POST /punches/code` (or `/enrolments/alternative` verification) with a PIN/QR/badge that does not match what is on file. */
export function invalidAlternativeCredential(): GadongError {
  return new GadongError('ATT-080', 'attendance.error.invalid_alternative_credential', 401)
}

export function deviceNotFound(id: string): GadongError {
  return new GadongError('ATT-090', 'attendance.error.device_not_found', 404, [{ id }])
}
