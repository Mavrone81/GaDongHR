import type { Queryable } from '@gadong/kernel'

export type LeaveRefStatus = 'approved' | 'cancelled'

export interface LeaveRefRow {
  id: string
  employeeId: string
  leaveRequestId: string
  dateFrom: string
  dateTo: string
  status: LeaveRefStatus
}

function toDateString(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === 'string') return v.slice(0, 10)
  throw new Error(`LeaveRefRepository: unexpected date value ${JSON.stringify(v)}`)
}

function mapRow(row: Record<string, unknown>): LeaveRefRow {
  return {
    id: String(row['id']),
    employeeId: String(row['employee_id']),
    leaveRequestId: String(row['leave_request_id']),
    dateFrom: toDateString(row['date_from']),
    dateTo: toDateString(row['date_to']),
    status: row['status'] as LeaveRefStatus,
  }
}

/**
 * `LeaveReadModel` (M2-SCHEDULER §2 class diagram) — fed by
 * `leave.approved`/`leave.cancelled`, consumed by `RosterService`'s
 * conflict detection (`isOnLeave`, in `roster.service.ts`). One row per
 * leave request, keyed on the event payload's `requestId`
 * (`leave_request_id`), so a later `leave.cancelled` for the same request
 * updates the row `leave.approved` created rather than leaving a stale
 * "approved" row behind (M3's roster-vs-leave collision must reflect the
 * CURRENT state of the leave request, not just whatever was last true).
 */
export class LeaveRefRepository {
  constructor(private readonly db: Queryable) {}

  async upsertApproved(
    tx: Queryable,
    row: { employeeId: string; leaveRequestId: string; dateFrom: string; dateTo: string },
  ): Promise<LeaveRefRow> {
    const { rows } = await tx.query(
      `INSERT INTO scheduler.leave_ref (employee_id, leave_request_id, date_from, date_to, status, updated_at)
       VALUES ($1, $2, $3, $4, 'approved', now())
       ON CONFLICT (leave_request_id) DO UPDATE
         SET employee_id = EXCLUDED.employee_id, date_from = EXCLUDED.date_from, date_to = EXCLUDED.date_to,
             status = 'approved', updated_at = now()
       RETURNING id, employee_id, leave_request_id, date_from, date_to, status`,
      [row.employeeId, row.leaveRequestId, row.dateFrom, row.dateTo],
    )
    const inserted = rows[0]
    if (inserted === undefined) throw new Error('LeaveRefRepository.upsertApproved: INSERT ... RETURNING produced no row')
    return mapRow(inserted)
  }

  async markCancelled(tx: Queryable, leaveRequestId: string): Promise<LeaveRefRow | null> {
    const { rows } = await tx.query(
      `UPDATE scheduler.leave_ref SET status = 'cancelled', updated_at = now()
       WHERE leave_request_id = $1
       RETURNING id, employee_id, leave_request_id, date_from, date_to, status`,
      [leaveRequestId],
    )
    return rows.length > 0 && rows[0] !== undefined ? mapRow(rows[0]) : null
  }

  /** Approved leave rows for `employeeId` overlapping `date` — the query `RosterService.isOnLeave` (roster.service.ts) uses for the leave-collision conflict check. */
  async findApprovedCovering(employeeId: string, date: string): Promise<LeaveRefRow[]> {
    const { rows } = await this.db.query(
      `SELECT id, employee_id, leave_request_id, date_from, date_to, status FROM scheduler.leave_ref
       WHERE employee_id = $1 AND status = 'approved' AND date_from <= $2 AND date_to >= $2`,
      [employeeId, date],
    )
    return rows.map(mapRow)
  }
}
