import type { Queryable } from '@gadong/kernel'

export type LeaveRefStatus = 'approved' | 'cancelled'

export interface LeaveRefRow {
  id: string
  employeeId: string
  leaveRequestId: string
  dateFrom: string
  dateTo: string
  leaveTypeCode: string
  payMode: string
  status: LeaveRefStatus
}

function toDateString(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === 'string') return v.slice(0, 10)
  throw new Error(`LeaveRefRepository: unexpected date value ${JSON.stringify(v)}`)
}

const SELECT_COLUMNS = 'id, employee_id, leave_request_id, date_from, date_to, leave_type_code, pay_mode, status'

function mapRow(row: Record<string, unknown>): LeaveRefRow {
  return {
    id: String(row['id']),
    employeeId: String(row['employee_id']),
    leaveRequestId: String(row['leave_request_id']),
    dateFrom: toDateString(row['date_from']),
    dateTo: toDateString(row['date_to']),
    leaveTypeCode: String(row['leave_type_code']),
    payMode: String(row['pay_mode']),
    status: row['status'] as LeaveRefStatus,
  }
}

/** `timesheet.leave_ref` — the local `leave.approved`/`leave.cancelled` read model, mirroring `services/svc-scheduler`'s own `leave_ref` table (same reasoning: a durable record of which dates a request covers, so cancellation can find and clear them). */
export class LeaveRefRepository {
  constructor(private readonly db: Queryable) {}

  async upsertApproved(
    tx: Queryable,
    row: { employeeId: string; leaveRequestId: string; dateFrom: string; dateTo: string; leaveTypeCode: string; payMode: string },
  ): Promise<LeaveRefRow> {
    const { rows } = await tx.query(
      `INSERT INTO timesheet.leave_ref (employee_id, leave_request_id, date_from, date_to, leave_type_code, pay_mode, status, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'approved', now())
       ON CONFLICT (leave_request_id) DO UPDATE
         SET employee_id = EXCLUDED.employee_id, date_from = EXCLUDED.date_from, date_to = EXCLUDED.date_to,
             leave_type_code = EXCLUDED.leave_type_code, pay_mode = EXCLUDED.pay_mode, status = 'approved', updated_at = now()
       RETURNING ${SELECT_COLUMNS}`,
      [row.employeeId, row.leaveRequestId, row.dateFrom, row.dateTo, row.leaveTypeCode, row.payMode],
    )
    const inserted = rows[0]
    if (inserted === undefined) throw new Error('LeaveRefRepository.upsertApproved: INSERT ... RETURNING produced no row')
    return mapRow(inserted)
  }

  async markCancelled(tx: Queryable, leaveRequestId: string): Promise<LeaveRefRow | null> {
    const { rows } = await tx.query(
      `UPDATE timesheet.leave_ref SET status = 'cancelled', updated_at = now()
       WHERE leave_request_id = $1
       RETURNING ${SELECT_COLUMNS}`,
      [leaveRequestId],
    )
    return rows.length > 0 && rows[0] !== undefined ? mapRow(rows[0]) : null
  }

  /** `tx` defaults to this repository's own connection — pass the caller's transaction explicitly when reading back a row that same transaction may have just upserted (see `RosterRefRepository.findOne`'s identical note; `ConsolidationService.applyLeaveCancelled` does exactly this). */
  async findByRequestId(leaveRequestId: string, tx: Queryable = this.db): Promise<LeaveRefRow | null> {
    const { rows } = await tx.query(`SELECT ${SELECT_COLUMNS} FROM timesheet.leave_ref WHERE leave_request_id = $1`, [
      leaveRequestId,
    ])
    return rows.length > 0 && rows[0] !== undefined ? mapRow(rows[0]) : null
  }

  async findApprovedCovering(employeeId: string, date: string): Promise<LeaveRefRow | null> {
    const { rows } = await this.db.query(
      `SELECT ${SELECT_COLUMNS} FROM timesheet.leave_ref
       WHERE employee_id = $1 AND status = 'approved' AND date_from <= $2 AND date_to >= $2`,
      [employeeId, date],
    )
    return rows.length > 0 && rows[0] !== undefined ? mapRow(rows[0]) : null
  }
}
