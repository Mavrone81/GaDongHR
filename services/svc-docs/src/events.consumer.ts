import { idempotent } from '@gadong/kernel'
import type { Queryable } from '@gadong/kernel'
import type { EmployeeRefRepository } from './employee-ref.repository'
import type { PayslipRefRepository } from './payslip-ref.repository'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function requireString(payload: Record<string, unknown>, field: string, context: string): string {
  const v = payload[field]
  if (typeof v !== 'string' || v.length === 0) throw new Error(`${context}: missing or invalid "${field}"`)
  return v
}

// ---------- employee.created / employee.updated / employee.terminated ----------

export interface EmployeeUpsertPayload {
  id: string
  orgUnitId: string
}

function parseEmployeeUpsert(payload: unknown): EmployeeUpsertPayload {
  if (!isRecord(payload)) throw new Error('EventsConsumer: employee.* payload is not an object')
  return {
    id: requireString(payload, 'id', 'employee.*'),
    orgUnitId: requireString(payload, 'orgUnitId', 'employee.*'),
  }
}

// ---------- payslip.issued ----------

export interface PayslipIssuedPayload {
  payslipId: string
  employeeId: string
}

function parsePayslipIssued(payload: unknown): PayslipIssuedPayload {
  if (!isRecord(payload)) throw new Error('EventsConsumer: payslip.issued payload is not an object')
  return {
    payslipId: requireString(payload, 'payslipId', 'payslip.issued'),
    employeeId: requireString(payload, 'employeeId', 'payslip.issued'),
  }
}

/**
 * Idempotent consumer boundary for the two events the row-scoping fix's
 * local read models depend on (`employee-ref.repository.ts`,
 * `payslip-ref.repository.ts`) — same shape as
 * `services/svc-timesheet/src/events.consumer.ts`'s `handleEmployeeUpsert`:
 * every `handle*` wraps its work in kernel's `idempotent()` keyed on the
 * broker-supplied event id, so triple delivery of the same event produces
 * exactly one effect (XC-EVENTS).
 */
export class EventsConsumer {
  constructor(
    private readonly employeeRefs: EmployeeRefRepository,
    private readonly payslipRefs: PayslipRefRepository,
  ) {}

  async handleEmployeeUpsert(tx: Queryable, eventId: string, payload: unknown): Promise<'duplicate' | Awaited<ReturnType<EmployeeRefRepository['upsert']>>> {
    const parsed = parseEmployeeUpsert(payload)
    return idempotent(tx, 'docs', eventId, () => this.employeeRefs.upsert(tx, { employeeId: parsed.id, orgUnitId: parsed.orgUnitId }))
  }

  async handlePayslipIssued(tx: Queryable, eventId: string, payload: unknown): Promise<'duplicate' | Awaited<ReturnType<PayslipRefRepository['upsert']>>> {
    const parsed = parsePayslipIssued(payload)
    return idempotent(tx, 'docs', eventId, () => this.payslipRefs.upsert(tx, { payslipId: parsed.payslipId, employeeId: parsed.employeeId }))
  }
}
