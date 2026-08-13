import { idempotent } from '@gadong/kernel'
import type { Queryable } from '@gadong/kernel'
import { EmployeeRefRepository } from './employee-ref.repository'
import { LeaveRefRepository } from './leave-ref.repository'

export interface EmployeeCreatedOrUpdatedPayload {
  id: string
  empCode: string
  orgUnitId: string
  status: string
}

export interface EmployeeTerminatedPayload {
  id: string
  terminationDate: string
  reasonCategory: string
}

export interface LeaveApprovedPayload {
  requestId: string
  employeeId: string
  dates: string[]
}

export interface LeaveCancelledPayload {
  requestId: string
}

function dateRange(dates: string[]): { from: string; to: string } {
  if (dates.length === 0) throw new Error('events.service: leave.approved payload carried an empty dates[] array')
  const sorted = [...dates].sort()
  const from = sorted[0]
  const to = sorted[sorted.length - 1]
  if (from === undefined || to === undefined) throw new Error('events.service: unreachable — sorted non-empty array')
  return { from, to }
}

/**
 * Consumes `employee.created`/`employee.updated`/`employee.terminated` into
 * `scheduler_employee_ref`, and `leave.approved`/`leave.cancelled` into
 * `scheduler.leave_ref` (`LeaveReadModel`) — the two read models
 * `RosterService`'s conflict detection and `GET /rosters?org_unit=`
 * filtering depend on (roadmap "Event catalog"; M2-SCHEDULER §2 class
 * diagram: "RosterPlanner --> LeaveReadModel : leave.approved events").
 *
 * Every `handle*` method wraps its effect in the kernel's `idempotent()`
 * against `scheduler.processed_events` — triple delivery of the same event
 * id runs the handler exactly once (XC-EVENTS). Subscribed for real via
 * `main.ts`'s `wireEventBus` (event-bus task) — this class itself stays a
 * plain `(tx, eventId, payload)` method set with no broker dependency of
 * its own, the same shape every sibling consumer in this codebase uses.
 */
export class EventsService {
  constructor(
    private readonly employeeRefRepo: EmployeeRefRepository,
    private readonly leaveRefRepo: LeaveRefRepository,
  ) {}

  async handleEmployeeCreatedOrUpdated(tx: Queryable, eventId: string, payload: EmployeeCreatedOrUpdatedPayload): Promise<void> {
    await idempotent(tx, 'scheduler', eventId, () =>
      this.employeeRefRepo.upsert(tx, {
        employeeId: payload.id,
        empCode: payload.empCode,
        status: payload.status,
        orgUnitId: payload.orgUnitId,
      }),
    )
  }

  async handleEmployeeTerminated(tx: Queryable, eventId: string, payload: EmployeeTerminatedPayload): Promise<void> {
    await idempotent(tx, 'scheduler', eventId, () =>
      this.employeeRefRepo.upsert(tx, {
        employeeId: payload.id,
        empCode: null,
        status: 'terminated',
        orgUnitId: null,
      }),
    )
  }

  async handleLeaveApproved(tx: Queryable, eventId: string, payload: LeaveApprovedPayload): Promise<void> {
    await idempotent(tx, 'scheduler', eventId, () => {
      const { from, to } = dateRange(payload.dates)
      return this.leaveRefRepo.upsertApproved(tx, {
        employeeId: payload.employeeId,
        leaveRequestId: payload.requestId,
        dateFrom: from,
        dateTo: to,
      })
    })
  }

  async handleLeaveCancelled(tx: Queryable, eventId: string, payload: LeaveCancelledPayload): Promise<void> {
    await idempotent(tx, 'scheduler', eventId, () => this.leaveRefRepo.markCancelled(tx, payload.requestId))
  }
}
