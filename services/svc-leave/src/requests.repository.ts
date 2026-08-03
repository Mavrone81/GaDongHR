import type { Queryable } from '@gadong/kernel'

export type RequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled'
export type HalfDayPeriod = 'AM' | 'PM'

export interface LeaveRequestRow {
  id: string
  employeeId: string
  leaveTypeId: string
  /** ISO date, inclusive. */
  startDate: string
  /** ISO date, inclusive. */
  endDate: string
  /** `numeric` string — see `decimal.ts`. */
  days: string
  hours: string | null
  halfDayPeriod: HalfDayPeriod | null
  /** Envelope-encrypted ciphertext, or `null` when no certificate was attached — see `requests.service.ts`'s use of `CryptoClient`. Never the plaintext pointer. */
  attachmentRef: Buffer | null
  certRequired: boolean
  status: RequestStatus
  createdAt: string
}

export interface NewLeaveRequestRow {
  id: string
  employeeId: string
  leaveTypeId: string
  startDate: string
  endDate: string
  days: string
  hours: string | null
  halfDayPeriod: HalfDayPeriod | null
  attachmentRef: Buffer | null
  certRequired: boolean
  status: RequestStatus
}

/**
 * `dates` is a Postgres `daterange` — `[startDate, endDate + 1 day)`, both
 * input bounds inclusive per this service's domain model, matching the
 * upper-bound-exclusive convention `daterange` itself uses. This repository
 * never asks Postgres to evaluate a range OPERATOR (no `&&` overlap query):
 * `requests.service.ts` fetches an employee's active requests by the plain
 * equality `employee_id = $1` and checks overlap in TypeScript — see that
 * file's comment for why, and `testing/fake-db.ts`'s header for the fake's
 * matching "equality WHERE only" contract.
 */
function toDateRangeLiteral(startDate: string, endDate: string): string {
  const upperExclusive = addOneDay(endDate)
  return `[${startDate},${upperExclusive})`
}

function addOneDay(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

/** Inverse of `toDateRangeLiteral` — both a real Postgres `daterange` (returned by `pg` as this exact bracket-literal string, since `pg` does not auto-parse range OIDs) and this fake's stored string round-trip through the same literal, so one parser serves both. */
export function parseDateRangeLiteral(literal: string): { startDate: string; endDate: string } {
  const match = /^\[(\d{4}-\d{2}-\d{2}),(\d{4}-\d{2}-\d{2})\)$/.exec(literal)
  if (!match || match[1] === undefined || match[2] === undefined) {
    throw new Error(`RequestsRepository: unparseable daterange literal ${JSON.stringify(literal)}`)
  }
  const endDate = new Date(`${match[2]}T00:00:00Z`)
  endDate.setUTCDate(endDate.getUTCDate() - 1)
  return { startDate: match[1], endDate: endDate.toISOString().slice(0, 10) }
}

function mapRow(row: Record<string, unknown>): LeaveRequestRow {
  const { startDate, endDate } = parseDateRangeLiteral(String(row['dates']))
  const attachmentRef = row['attachment_ref']
  const createdAt = row['created_at']
  return {
    id: String(row['id']),
    employeeId: String(row['employee_id']),
    leaveTypeId: String(row['leave_type_id']),
    startDate,
    endDate,
    days: String(row['days']),
    hours: row['hours'] === null || row['hours'] === undefined ? null : String(row['hours']),
    halfDayPeriod: row['half_day_period'] === null || row['half_day_period'] === undefined ? null : (row['half_day_period'] as HalfDayPeriod),
    attachmentRef: attachmentRef === null || attachmentRef === undefined ? null : Buffer.isBuffer(attachmentRef) ? attachmentRef : Buffer.from(attachmentRef as Uint8Array),
    certRequired: Boolean(row['cert_required']),
    status: row['status'] as RequestStatus,
    createdAt: createdAt instanceof Date ? createdAt.toISOString() : String(createdAt),
  }
}

/** The inclusive list of ISO dates a request covers — shared by `requests.service.ts` (`leave.cancelled`) and `approvals.service.ts` (`leave.approved`), both of which publish the same `{..., dates: string[], ...}` shape (roadmap event catalog). */
export function datesArray(request: Pick<LeaveRequestRow, 'startDate' | 'endDate'>): string[] {
  const out: string[] = []
  const cur = new Date(`${request.startDate}T00:00:00Z`)
  const end = new Date(`${request.endDate}T00:00:00Z`)
  while (cur.getTime() <= end.getTime()) {
    out.push(cur.toISOString().slice(0, 10))
    cur.setUTCDate(cur.getUTCDate() + 1)
  }
  return out
}

/** SQL only — no validation, encryption, or balance logic here (`requests.service.ts` owns that), matching this service's repository/service split throughout. */
export class RequestsRepository {
  constructor(private readonly db: Queryable) {}

  async findById(id: string): Promise<LeaveRequestRow | null> {
    const { rows } = await this.db.query('SELECT * FROM leave.leave_request WHERE id = $1', [id])
    return rows.length > 0 && rows[0] !== undefined ? mapRow(rows[0]) : null
  }

  /** Every request for `employeeId`, any status — callers filter by status/date overlap themselves (see file header). */
  async listByEmployee(employeeId: string): Promise<LeaveRequestRow[]> {
    const { rows } = await this.db.query('SELECT * FROM leave.leave_request WHERE employee_id = $1', [employeeId])
    return rows.map(mapRow)
  }

  /** Every request in `status`, across all employees — backs the approval queue (`GET /approvals?status=pending`). */
  async listByStatus(status: RequestStatus): Promise<LeaveRequestRow[]> {
    const { rows } = await this.db.query('SELECT * FROM leave.leave_request WHERE status = $1', [status])
    return rows.map(mapRow)
  }

  async insert(tx: Queryable, row: NewLeaveRequestRow): Promise<LeaveRequestRow> {
    const { rows } = await tx.query(
      `INSERT INTO leave.leave_request
         (id, employee_id, leave_type_id, dates, days, hours, half_day_period, attachment_ref, cert_required, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        row.id,
        row.employeeId,
        row.leaveTypeId,
        toDateRangeLiteral(row.startDate, row.endDate),
        row.days,
        row.hours,
        row.halfDayPeriod,
        row.attachmentRef,
        row.certRequired,
        row.status,
        new Date(),
      ],
    )
    const inserted = rows[0]
    if (inserted === undefined) throw new Error('RequestsRepository.insert: INSERT ... RETURNING produced no row')
    return mapRow(inserted)
  }

  async updateStatus(tx: Queryable, id: string, status: RequestStatus): Promise<LeaveRequestRow | null> {
    const { rows } = await tx.query('UPDATE leave.leave_request SET status = $2 WHERE id = $1 RETURNING *', [id, status])
    return rows.length > 0 && rows[0] !== undefined ? mapRow(rows[0]) : null
  }
}
