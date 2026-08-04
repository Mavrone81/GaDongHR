import { idempotent } from '@gadong/kernel'
import type { Queryable } from '@gadong/kernel'
import type { ConsolidationService, PunchDirection } from './consolidation.service'
import type { EmployeeRefRepository, EmployeeStatus, EmploymentType } from './employee-ref.repository'
import type { DayRecordRow } from './day-record.repository'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function requireString(payload: Record<string, unknown>, field: string, context: string): string {
  const v = payload[field]
  if (typeof v !== 'string' || v.length === 0) throw new Error(`${context}: missing or invalid "${field}"`)
  return v
}

// ---------- attendance.punch ----------

export interface AttendancePunchPayload {
  idemKey: string
  employeeId: string
  punchedAt: string
  direction: PunchDirection
}

function parsePunch(payload: unknown): AttendancePunchPayload {
  if (!isRecord(payload)) throw new Error('EventsConsumer: attendance.punch payload is not an object')
  const idemKey = requireString(payload, 'idemKey', 'attendance.punch')
  const employeeId = requireString(payload, 'employeeId', 'attendance.punch')
  const punchedAt = requireString(payload, 'punchedAt', 'attendance.punch')
  const direction = payload['direction']
  if (direction !== 'in' && direction !== 'out') throw new Error('attendance.punch: direction must be "in" or "out"')
  return { idemKey, employeeId, punchedAt, direction }
}

// ---------- roster.published (per-entry) ----------

export interface RosterEntryPublishedPayload {
  employeeId: string
  workDate: string
  scheduledStart: string
  scheduledEnd: string
  graceMin: number
  hazardous: boolean
  isHoliday: boolean
  rosterEntryId: string
}

function parseRosterEntry(payload: unknown): RosterEntryPublishedPayload {
  if (!isRecord(payload)) throw new Error('EventsConsumer: roster.published entry payload is not an object')
  return {
    employeeId: requireString(payload, 'employeeId', 'roster.published'),
    workDate: requireString(payload, 'workDate', 'roster.published'),
    scheduledStart: requireString(payload, 'scheduledStart', 'roster.published'),
    scheduledEnd: requireString(payload, 'scheduledEnd', 'roster.published'),
    graceMin: typeof payload['graceMin'] === 'number' ? payload['graceMin'] : 0,
    hazardous: payload['hazardous'] === true,
    isHoliday: payload['isHoliday'] === true,
    rosterEntryId: requireString(payload, 'rosterEntryId', 'roster.published'),
  }
}

// ---------- leave.approved / leave.cancelled ----------

export interface LeaveApprovedPayload {
  requestId: string
  employeeId: string
  leaveTypeCode: string
  dates: { from: string; to: string }
  payMode: string
}

function parseLeaveApproved(payload: unknown): LeaveApprovedPayload {
  if (!isRecord(payload)) throw new Error('EventsConsumer: leave.approved payload is not an object')
  const dates = payload['dates']
  if (!isRecord(dates)) throw new Error('leave.approved: missing or invalid "dates"')
  return {
    requestId: requireString(payload, 'requestId', 'leave.approved'),
    employeeId: requireString(payload, 'employeeId', 'leave.approved'),
    leaveTypeCode: requireString(payload, 'leaveTypeCode', 'leave.approved'),
    dates: { from: requireString(dates, 'from', 'leave.approved.dates'), to: requireString(dates, 'to', 'leave.approved.dates') },
    payMode: requireString(payload, 'payMode', 'leave.approved'),
  }
}

function parseLeaveCancelled(payload: unknown): { requestId: string } {
  if (!isRecord(payload)) throw new Error('EventsConsumer: leave.cancelled payload is not an object')
  return { requestId: requireString(payload, 'requestId', 'leave.cancelled') }
}

// ---------- ot.approved ----------

export interface OtApprovedPayload {
  employeeId: string
  otDate: string
  hours: string
  rateClass: string
  approvedBy: string
}

function parseOtApproved(payload: unknown): OtApprovedPayload {
  if (!isRecord(payload)) throw new Error('EventsConsumer: ot.approved payload is not an object')
  const hours = payload['hours']
  return {
    employeeId: requireString(payload, 'employeeId', 'ot.approved'),
    otDate: requireString(payload, 'otDate', 'ot.approved'),
    hours: typeof hours === 'string' ? hours : typeof hours === 'number' ? String(hours) : (() => { throw new Error('ot.approved: missing or invalid "hours"') })(),
    rateClass: requireString(payload, 'rateClass', 'ot.approved'),
    approvedBy: requireString(payload, 'approvedBy', 'ot.approved'),
  }
}

// ---------- employee.created / employee.updated / employee.terminated ----------

export interface EmployeeUpsertPayload {
  id: string
  empCode: string
  orgUnitId: string
  employmentType: EmploymentType
  status: EmployeeStatus
}

function parseEmployeeUpsert(payload: unknown): EmployeeUpsertPayload {
  if (!isRecord(payload)) throw new Error('EventsConsumer: employee.* payload is not an object')
  const employmentType = payload['employmentType']
  const status = payload['status']
  if (employmentType !== 'monthly' && employmentType !== 'daily' && employmentType !== 'hourly' && employmentType !== 'contract') {
    throw new Error('employee.*: invalid employmentType')
  }
  if (status !== 'onboarding' && status !== 'active' && status !== 'terminated') {
    throw new Error('employee.*: invalid status')
  }
  return {
    id: requireString(payload, 'id', 'employee.*'),
    empCode: requireString(payload, 'empCode', 'employee.*'),
    orgUnitId: requireString(payload, 'orgUnitId', 'employee.*'),
    employmentType,
    status,
  }
}

/**
 * Idempotent consumer boundary for every event `svc-timesheet` subscribes
 * to (M3-TIMESHEET.md §3 "Events / in"). Every `handle*` wraps its work in
 * kernel's `idempotent()` keyed on an event id — triple delivery of the
 * same event produces exactly one effect (XC-EVENTS / M4-4 AC). No message
 * broker is wired anywhere in this codebase yet (matching every sibling
 * service's `EventsService`/`EmployeeRefConsumer` — "ready for a future
 * subscriber, tested directly today"); this class is that same shape for
 * `svc-timesheet`.
 *
 * `attendance.punch` uses the event's OWN `idemKey` field as the
 * idempotency key — not a broker-assigned id — because M4-4's AC requires
 * survival across kiosk-side offline queueing: the kiosk generates
 * `idemKey` before it knows whether the broker is even reachable, so it
 * must be stable across retries the kiosk itself drives, not just across
 * broker redelivery. Every other event here dedupes on a broker-supplied
 * `eventId` (the publishing service's outbox row id), matching
 * `services/svc-leave`'s `EmployeeRefConsumer`.
 */
export class EventsConsumer {
  constructor(
    private readonly consolidation: ConsolidationService,
    private readonly employeeRefs: EmployeeRefRepository,
  ) {}

  async handleAttendancePunch(tx: Queryable, payload: unknown): Promise<DayRecordRow | 'duplicate'> {
    const parsed = parsePunch(payload)
    return idempotent(tx, 'timesheet', parsed.idemKey, () =>
      this.consolidation.applyPunch(tx, { employeeId: parsed.employeeId, punchedAt: parsed.punchedAt, direction: parsed.direction }),
    )
  }

  async handleRosterEntryPublished(tx: Queryable, eventId: string, payload: unknown): Promise<DayRecordRow | 'duplicate'> {
    const parsed = parseRosterEntry(payload)
    return idempotent(tx, 'timesheet', eventId, () => this.consolidation.applyRosterEntry(tx, parsed))
  }

  async handleLeaveApproved(tx: Queryable, eventId: string, payload: unknown): Promise<DayRecordRow[] | 'duplicate'> {
    const parsed = parseLeaveApproved(payload)
    return idempotent(tx, 'timesheet', eventId, () =>
      this.consolidation.applyLeaveApproved(tx, {
        employeeId: parsed.employeeId,
        leaveRequestId: parsed.requestId,
        dateFrom: parsed.dates.from,
        dateTo: parsed.dates.to,
        leaveTypeCode: parsed.leaveTypeCode,
        payMode: parsed.payMode,
      }),
    )
  }

  async handleLeaveCancelled(tx: Queryable, eventId: string, payload: unknown): Promise<DayRecordRow[] | 'duplicate'> {
    const parsed = parseLeaveCancelled(payload)
    return idempotent(tx, 'timesheet', eventId, () => this.consolidation.applyLeaveCancelled(tx, parsed.requestId))
  }

  async handleOtApproved(tx: Queryable, eventId: string, payload: unknown): Promise<DayRecordRow | 'duplicate'> {
    const parsed = parseOtApproved(payload)
    return idempotent(tx, 'timesheet', eventId, () => this.consolidation.applyOtApproval(tx, parsed))
  }

  async handleEmployeeUpsert(tx: Queryable, eventId: string, payload: unknown): Promise<'duplicate' | Awaited<ReturnType<EmployeeRefRepository['upsert']>>> {
    const parsed = parseEmployeeUpsert(payload)
    return idempotent(tx, 'timesheet', eventId, () =>
      this.employeeRefs.upsert(tx, {
        employeeId: parsed.id,
        empCode: parsed.empCode,
        orgUnitId: parsed.orgUnitId,
        employmentType: parsed.employmentType,
        status: parsed.status,
      }),
    )
  }
}
