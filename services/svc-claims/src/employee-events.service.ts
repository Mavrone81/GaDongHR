import { idempotent } from '@gadong/kernel'
import type { Queryable } from '@gadong/kernel'
import { EmployeeRefRepository } from './employee-ref.repository'
import type { EmployeeRefRow } from './employee-ref.repository'

export interface EmployeeEvent {
  topic: 'employee.created' | 'employee.updated' | 'employee.terminated'
  eventId: string
  payload: { id: string; status?: string }
}

function statusFor(event: EmployeeEvent): string {
  if (event.topic === 'employee.terminated') return 'terminated'
  return event.payload.status ?? 'active'
}

/**
 * Consumes `employee.*` (roadmap event catalog) into `claims_employee_ref` —
 * the Task 14 brief's one required consumer. Wrapped in the kernel's
 * `idempotent()`, which dedupes on `claims.processed_events(event_id)`
 * inside the SAME transaction as the upsert: triple delivery of the same
 * `eventId` runs the handler exactly once (XC-EVENTS) — see
 * `employee-events.service.test.ts`.
 */
export class EmployeeEventsService {
  constructor(private readonly repo: EmployeeRefRepository) {}

  async handle(tx: Queryable, event: EmployeeEvent): Promise<EmployeeRefRow | 'duplicate'> {
    return idempotent(tx, 'claims', event.eventId, () => this.repo.upsert(tx, event.payload.id, statusFor(event)))
  }
}
