import { idempotent } from '@gadong/kernel'
import type { Queryable } from '@gadong/kernel'
import { ConsentStateRepository } from './consent-state.repository'
import { TemplateDeletionService } from './template-deletion.service'

export interface ConsentEventPayload {
  employeeId: string
  purpose: string
  formVersion: number
  at: string
}

/**
 * Consumes `consent.granted`/`consent.withdrawn` (published by
 * `svc-onboarding`'s `ConsentService`, see that service's
 * `consent.service.ts`). Both go through kernel's `idempotent()` — a
 * message-broker consumer redelivering the same event id must produce
 * exactly one effect (XC-EVENTS), matching every other consumer in this
 * codebase.
 *
 * Only `purpose === 'biometric'` events matter to this service — a
 * `consent.granted` for `hr_processing` or any other purpose is a no-op
 * here (this service has nothing to enable on it), acknowledged as
 * processed and otherwise ignored.
 */
export class ConsentEventHandler {
  constructor(
    private readonly consentState: ConsentStateRepository,
    private readonly templateDeletion: TemplateDeletionService,
  ) {}

  async handleGranted(tx: Queryable, eventId: string, payload: ConsentEventPayload): Promise<void> {
    await idempotent(tx, 'attendance', eventId, async () => {
      if (payload.purpose !== 'biometric') return
      await this.consentState.upsert(tx, payload.employeeId, 'granted', payload.at)
    })
  }

  /**
   * M4-1's enrolment gate immediately reflects the withdrawal (so a
   * withdrawal mid-capture is caught by `EnrolmentService.completeEnrolment`'s
   * re-check), AND the PDPA §7 template-deletion pipeline runs in the SAME
   * `idempotent()` handler — both are one atomic effect of this one event,
   * consistent with "triple delivery produces exactly one effect."
   */
  async handleWithdrawn(tx: Queryable, eventId: string, payload: ConsentEventPayload): Promise<void> {
    await idempotent(tx, 'attendance', eventId, async () => {
      if (payload.purpose !== 'biometric') return
      await this.consentState.upsert(tx, payload.employeeId, 'withdrawn', payload.at)
      await this.templateDeletion.deleteForEmployee(tx, payload.employeeId, 'consent_withdrawn')
    })
  }
}
