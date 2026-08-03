import { GadongError } from '@gadong/kernel'

/** M1-ONBOARDING.md §3.3 — the `ONB-*` error extract, plus a small number of
 * additional codes this implementation needs that the extract table did not
 * enumerate (each documented at its call site with why). */

/** `POST /employees` with a national ID that fails the 13-digit checksum (`national-id.ts`). Real algorithm, never a length check. */
export function invalidNationalId(): GadongError {
  return new GadongError('ONB-001', 'onboarding.error.invalid_national_id', 422)
}

/** `POST /employees`/`PATCH /employees/:id` whose national-ID blind index already matches another row — `employee_national_id_bidx_key UNIQUE` is the belt; this is the braces, checked before the INSERT is attempted. */
export function duplicateNationalId(): GadongError {
  return new GadongError('ONB-002', 'onboarding.error.duplicate_national_id', 409)
}

export function employeeNotFound(id: string): GadongError {
  return new GadongError('ONB-003', 'onboarding.error.employee_not_found', 404, [{ id }])
}

/** `POST /employees/:id/transition` — the state diagram's guard (M1-ONBOARDING §1.2) failed: e.g. `onboarding→active` attempted with the checklist incomplete, or an unrecognised `to` state. */
export function lifecycleGuardFailed(reason: string): GadongError {
  return new GadongError('ONB-010', 'onboarding.error.lifecycle_guard_failed', 409, [{ reason }])
}

/**
 * M1-3, the compliance-critical code: biometric consent submitted bundled
 * with (i.e. in the same call as, or under the same purpose as) the general
 * HR-processing notice. PDPA-BIOMETRIC-COMPLIANCE.md §4.1 requires the
 * biometric notice to be a SEPARATE, dedicated submission — never implied by
 * accepting a different consent.
 */
export function biometricConsentMustBeSeparate(): GadongError {
  return new GadongError('ONB-020', 'onboarding.error.biometric_consent_must_be_separate', 422)
}

/**
 * `GET /employees/:id/sensitive` with a missing/blank `purpose` — the same
 * "blank" definition kernel's `isBlankPurpose`/`AuditEmitter` use (one
 * definition of "satisfies the mandatory-purpose rule" for the whole
 * system). Not in the M1-ONBOARDING §3.3 extract table (which is explicitly
 * "an extract"); `ONB-021` is the next free code in the same series.
 */
export function purposeRequired(): GadongError {
  return new GadongError('ONB-021', 'onboarding.error.purpose_required', 400)
}

/** A `fields=` entry on `GET /employees/:id/sensitive` that does not name a real S2/S3 employee column. */
export function unknownSensitiveField(field: string): GadongError {
  return new GadongError('ONB-022', 'onboarding.error.unknown_sensitive_field', 400, [{ field }])
}

/** `POST /employees/:id/consents` naming a `{purpose, formVersion, lang}` combination with no matching `consent_form` row — there is no text to show/record as "shown". */
export function consentFormNotFound(purpose: string, lang: string, formVersion: number): GadongError {
  return new GadongError('ONB-023', 'onboarding.error.consent_form_not_found', 404, [{ purpose, lang, formVersion }])
}

/** `DELETE /employees/:id/consents/biometric` (one-tap withdrawal) when there is no currently-granted biometric consent to withdraw. */
export function noGrantedConsentToWithdraw(purpose: string): GadongError {
  return new GadongError('ONB-024', 'onboarding.error.no_granted_consent', 409, [{ purpose }])
}

/** `POST /checklist/tasks/:taskId/complete` on the `sso_registration` task before the employee's SSO number is on file — M1-ONBOARDING §3.1 row 7: "SSO task cannot be completed without SSO number present". */
export function ssoTaskBlockedWithoutSsoNumber(): GadongError {
  return new GadongError('ONB-030', 'onboarding.error.sso_task_blocked', 409)
}

export function checklistTaskNotFound(taskId: string): GadongError {
  return new GadongError('ONB-031', 'onboarding.error.checklist_task_not_found', 404, [{ taskId }])
}

/** `POST /employees/:id/probation/decision` for an employee with no open probation record, or one already decided. */
export function noOpenProbation(employeeId: string): GadongError {
  return new GadongError('ONB-040', 'onboarding.error.no_open_probation', 409, [{ employeeId }])
}

/** `outcome: 'extend'` without a `newEndDate` — there is nothing to extend TO. */
export function extendRequiresNewEndDate(): GadongError {
  return new GadongError('ONB-041', 'onboarding.error.extend_requires_new_end_date', 422)
}

/** `POST /employees/:id/transition` to `terminated` without a termination reason category (M1-ONBOARDING §1.2 guard). */
export function terminationReasonRequired(): GadongError {
  return new GadongError('ONB-011', 'onboarding.error.termination_reason_required', 422)
}
