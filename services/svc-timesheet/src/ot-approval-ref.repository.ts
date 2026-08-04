import type { Queryable } from '@gadong/kernel'

export interface OtApprovalRefRow {
  id: string
  employeeId: string
  otDate: string
  rateClass: string
  hours: string
  approvedBy: string | null
}

function toDateString(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === 'string') return v.slice(0, 10)
  throw new Error(`OtApprovalRefRepository: unexpected date value ${JSON.stringify(v)}`)
}

const SELECT_COLUMNS = 'id, employee_id, ot_date, rate_class, hours, approved_by'

function mapRow(row: Record<string, unknown>): OtApprovalRefRow {
  return {
    id: String(row['id']),
    employeeId: String(row['employee_id']),
    otDate: toDateString(row['ot_date']),
    rateClass: String(row['rate_class']),
    hours: String(row['hours']),
    approvedBy: row['approved_by'] === null || row['approved_by'] === undefined ? null : String(row['approved_by']),
  }
}

/**
 * `timesheet.ot_approval_ref` — the local `ot.approved` read model
 * `OtClassifier`'s `approvedOtMinutes` input is sourced from. `upsert` ADDS
 * `hours` on conflict (one row per employee-day) rather than replacing it:
 * `services/svc-scheduler`'s `OtService` can approve more than one OT
 * request for the same employee-day (e.g. a manager tops up an earlier
 * approval), and each is a separate `ot.approved` event this consumer must
 * accumulate, not overwrite — losing an earlier approval on a second event
 * would manufacture a false "unapproved OT" exception for hours that were,
 * in fact, approved.
 */
export class OtApprovalRefRepository {
  constructor(private readonly db: Queryable) {}

  /** `tx` defaults to this repository's own connection — pass the caller's transaction explicitly when reading back a row that same transaction may have just upserted (see `RosterRefRepository.findOne`'s identical note). */
  async findByEmployeeAndDate(employeeId: string, otDate: string, tx: Queryable = this.db): Promise<OtApprovalRefRow[]> {
    const { rows } = await tx.query(
      `SELECT ${SELECT_COLUMNS} FROM timesheet.ot_approval_ref WHERE employee_id = $1 AND ot_date = $2`,
      [employeeId, otDate],
    )
    return rows.map(mapRow)
  }

  async upsertAdd(
    tx: Queryable,
    row: { employeeId: string; otDate: string; rateClass: string; hours: string; approvedBy: string | null },
  ): Promise<OtApprovalRefRow> {
    const { rows } = await tx.query(
      `INSERT INTO timesheet.ot_approval_ref (employee_id, ot_date, rate_class, hours, approved_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (employee_id, ot_date) DO UPDATE
         SET hours = (timesheet.ot_approval_ref.hours::numeric + EXCLUDED.hours::numeric)::text,
             rate_class = EXCLUDED.rate_class, approved_by = EXCLUDED.approved_by, updated_at = now()
       RETURNING ${SELECT_COLUMNS}`,
      [row.employeeId, row.otDate, row.rateClass, row.hours, row.approvedBy],
    )
    const inserted = rows[0]
    if (inserted === undefined) throw new Error('OtApprovalRefRepository.upsertAdd: INSERT ... RETURNING produced no row')
    return mapRow(inserted)
  }
}
