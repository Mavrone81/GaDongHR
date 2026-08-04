import { idempotent } from '@gadong/kernel'
import type { Queryable } from '@gadong/kernel'
import { TemplateDeletionService } from './template-deletion.service'

/** `svc-onboarding`'s `employee.terminated` payload shape — `employee.service.ts`: `{ id, terminationDate, reasonCategory }`. */
export interface EmployeeTerminatedPayload {
  id: string
  terminationDate: string
  reasonCategory: string
}

/**
 * Consumes `employee.terminated` — the OTHER PDPA §7 deletion trigger
 * besides `consent.withdrawn` (module doc §1.3: "consent withdrawal OR
 * employee.terminated"). A terminated employee's biometric consent was not
 * necessarily withdrawn first — termination alone is sufficient grounds to
 * delete the template, since the purpose (attendance matching for an
 * active employee) has ended either way.
 */
export class EmployeeEventHandler {
  constructor(private readonly templateDeletion: TemplateDeletionService) {}

  async handleTerminated(tx: Queryable, eventId: string, payload: EmployeeTerminatedPayload): Promise<void> {
    await idempotent(tx, 'attendance', eventId, async () => {
      await this.templateDeletion.deleteForEmployee(tx, payload.id, 'employee_terminated')
    })
  }
}
