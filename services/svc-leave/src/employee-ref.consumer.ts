import { idempotent } from '@gadong/kernel'
import type { Queryable } from '@gadong/kernel'
import type { BalancesService } from './balances.service'
import type { EmployeeRefRepository, EmployeeRefRow } from './employee-ref.repository'
import type { LeaveTypesRepository } from './leave-types.repository'

/** The wire shape of `employee.created`/`employee.updated` (roadmap event catalog: `{id, empCode, orgUnitId, employmentType, provinceCode, startDate, status, preferredLang}`) — only the fields this consumer actually needs are read; the rest pass through unused by design (this read model exists to seed pro-ration and drive termination payout, not to mirror the whole employee record — that would recreate onboarding's schema inside leave's). */
export interface EmployeeCreatedOrUpdatedPayload {
  id: string
  startDate: string
  status: string
}

/** `employee.terminated` (roadmap: `{id, terminationDate, reasonCategory}`). */
export interface EmployeeTerminatedPayload {
  id: string
  terminationDate: string
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function parseCreatedOrUpdated(payload: unknown): EmployeeCreatedOrUpdatedPayload {
  if (!isRecord(payload)) throw new Error('EmployeeRefConsumer: event payload is not an object')
  const { id, startDate, status } = payload
  if (typeof id !== 'string' || id.length === 0) throw new Error('EmployeeRefConsumer: missing or invalid id')
  if (typeof startDate !== 'string' || startDate.length === 0) throw new Error('EmployeeRefConsumer: missing or invalid startDate')
  if (typeof status !== 'string' || status.length === 0) throw new Error('EmployeeRefConsumer: missing or invalid status')
  return { id, startDate, status }
}

function parseTerminated(payload: unknown): EmployeeTerminatedPayload {
  if (!isRecord(payload)) throw new Error('EmployeeRefConsumer: event payload is not an object')
  const { id, terminationDate } = payload
  if (typeof id !== 'string' || id.length === 0) throw new Error('EmployeeRefConsumer: missing or invalid id')
  if (typeof terminationDate !== 'string' || terminationDate.length === 0) throw new Error('EmployeeRefConsumer: missing or invalid terminationDate')
  return { id, terminationDate }
}

/**
 * Consumes `employee.created`/`employee.updated`/`employee.terminated` into
 * `leave_employee_ref` (DATABASE-DESIGN.md §1 read-model pattern; no
 * foreign keys across schemas). Every `handle*` method wraps its work in
 * the kernel's `idempotent()` keyed on `eventId` — triple delivery of the
 * same event produces exactly one effect (XC-EVENTS), which is also why
 * `employee.terminated`'s payout side-effect (below) cannot double-pay: a
 * redelivered `eventId` never reaches `handler` a second time at all.
 *
 * `employee.terminated` is the trigger for M5-2's mandatory termination
 * payout (Statutory Spec §7, s.67): for every leave type the terminated
 * employee has a balance in for the termination year, this consumer calls
 * `BalancesService.terminationPayout`, which itself only publishes
 * `leave.balance_payout` for a POSITIVE unused balance (a zero-balance type
 * produces no event — see that method's own doc).
 */
export class EmployeeRefConsumer {
  constructor(
    private readonly repo: EmployeeRefRepository,
    private readonly leaveTypes: LeaveTypesRepository,
    private readonly balances: BalancesService,
  ) {}

  async handleCreatedOrUpdated(tx: Queryable, eventId: string, payload: unknown): Promise<EmployeeRefRow | 'duplicate'> {
    return idempotent(tx, 'leave', eventId, async () => {
      const parsed = parseCreatedOrUpdated(payload)
      return this.repo.upsert(tx, { employeeId: parsed.id, status: parsed.status, startDate: parsed.startDate, terminatedAt: null })
    })
  }

  async handleTerminated(tx: Queryable, eventId: string, payload: unknown): Promise<EmployeeRefRow | 'duplicate'> {
    return idempotent(tx, 'leave', eventId, async () => {
      const parsed = parseTerminated(payload)
      const existing = await this.repo.findById(parsed.id)
      const updated = await this.repo.upsert(tx, {
        employeeId: parsed.id,
        status: 'terminated',
        startDate: existing?.startDate ?? null,
        terminatedAt: parsed.terminationDate,
      })

      const year = Number(parsed.terminationDate.slice(0, 4))
      const types = await this.leaveTypes.findAll()
      for (const leaveType of types) {
        // Termination payout must check each type's balance in turn within this one transaction; the type count per tenant is small.
        await this.balances.terminationPayout(tx, parsed.id, leaveType, year)
      }

      return updated
    })
  }
}
