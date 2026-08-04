import { AuditEmitter, writeOutbox } from '@gadong/kernel'
import type { Queryable } from '@gadong/kernel'
import { EnrolmentRepository } from './enrolment.repository'
import type { FaceEngineAdapter } from './face-engine.adapter'
import { templateDeletionNotVerified } from './attendance-errors'

/**
 * PDPA-BIOMETRIC-COMPLIANCE.md §7 / M4's "Retention" requirement: on
 * `consent.withdrawn` OR `employee.terminated`, the face template is
 * deleted from the engine within the SLA, `template_deleted_at` is
 * stamped as evidence, and — the load-bearing part — **the deletion is
 * verified against the engine, never assumed**.
 *
 * `deleteForEmployee` is meant to run as the `handler` argument to
 * kernel's `idempotent()`, inside the caller's transaction (see
 * `consent-event.handler.ts`/`employee-event.handler.ts`): if
 * `FaceEngineAdapter.deleteSubject` reports `verified: false`, this throws
 * — the caller's transaction rolls back, `processed_events` is never
 * committed for that event id, and the triggering event is redelivered on
 * the next consumer poll for another attempt. That is the entire
 * "verified, not assumed" guarantee: there is no code path here that
 * stamps `template_deleted_at` or publishes `biometric.template.deleted`
 * without a `verified: true` from the engine in hand first.
 */
export class TemplateDeletionService {
  constructor(
    private readonly enrolmentRepo: EnrolmentRepository,
    private readonly faceEngine: FaceEngineAdapter,
    private readonly audit: AuditEmitter,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async deleteForEmployee(tx: Queryable, employeeId: string, reason: 'consent_withdrawn' | 'employee_terminated'): Promise<void> {
    const enrolment = await this.enrolmentRepo.findByEmployeeId(tx, employeeId)

    // No enrolment, no face subject, or already deleted: nothing to do —
    // NOT an error. An employee who was always alternative-method-only, or
    // whose template was already deleted by an earlier delivery of this
    // same trigger, must not fail this handler (it must stay idempotent).
    if (!enrolment || enrolment.faceSubjectRef === null || enrolment.status === 'deleted') return

    const { verified } = await this.faceEngine.deleteSubject(enrolment.faceSubjectRef)
    if (!verified) throw templateDeletionNotVerified(employeeId)

    const deletedAt = this.now().toISOString()
    await this.enrolmentRepo.markTemplateDeleted(tx, employeeId, deletedAt)

    await writeOutbox(tx, 'attendance', 'biometric.template.deleted', { employeeId, verifiedAt: deletedAt })
    await this.audit.emit(tx, 'attendance', {
      actorId: 'system', actorRole: 'system', action: 'biometric.template.deleted', entity: 'enrollment', entityId: employeeId,
      after: { reason, verifiedAt: deletedAt },
    })
  }
}
