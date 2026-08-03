import type { Queryable } from '@gadong/kernel'

export type OtRateClass = 'workday' | 'holiday_work' | 'holiday_ot'
export type OtStatus = 'pending' | 'approved' | 'rejected'

export interface OtRequestRow {
  id: string
  employeeId: string
  otDate: string
  hours: string // numeric — always a decimal string, never a float (brief CONSTRAINTS)
  rateClass: OtRateClass
  status: OtStatus
  approvedBy: string | null
  reason: string
  employeeConsent: boolean
  decisionReason: string | null
  createdAt: string
  updatedAt: string
}

export interface NewOtRequestRow {
  employeeId: string
  otDate: string
  hours: string
  rateClass: OtRateClass
  reason: string
  employeeConsent: boolean
}

function toIsoString(v: unknown): string {
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'string') return v
  throw new Error(`OtRepository: unexpected timestamp value ${JSON.stringify(v)}`)
}

function toDateString(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === 'string') return v.slice(0, 10)
  throw new Error(`OtRepository: unexpected date value ${JSON.stringify(v)}`)
}

const SELECT_COLUMNS =
  'id, employee_id, ot_date, hours, rate_class, status, approved_by, reason, employee_consent, decision_reason, created_at, updated_at'

function mapRow(row: Record<string, unknown>): OtRequestRow {
  return {
    id: String(row['id']),
    employeeId: String(row['employee_id']),
    otDate: toDateString(row['ot_date']),
    hours: String(row['hours']),
    rateClass: row['rate_class'] as OtRateClass,
    status: row['status'] as OtStatus,
    approvedBy: row['approved_by'] === null || row['approved_by'] === undefined ? null : String(row['approved_by']),
    reason: String(row['reason']),
    employeeConsent: Boolean(row['employee_consent']),
    decisionReason:
      row['decision_reason'] === null || row['decision_reason'] === undefined ? null : String(row['decision_reason']),
    createdAt: toIsoString(row['created_at']),
    updatedAt: toIsoString(row['updated_at']),
  }
}

/** SQL only — `ot.service.ts` owns the weekly-ceiling re-check, the consent requirement, and the `ot.approved` outbox write. */
export class OtRepository {
  constructor(private readonly db: Queryable) {}

  async insert(tx: Queryable, row: NewOtRequestRow): Promise<OtRequestRow> {
    const { rows } = await tx.query(
      `INSERT INTO scheduler.ot_request (employee_id, ot_date, hours, rate_class, status, reason, employee_consent)
       VALUES ($1, $2, $3::numeric, $4, 'pending', $5, $6)
       RETURNING ${SELECT_COLUMNS}`,
      [row.employeeId, row.otDate, row.hours, row.rateClass, row.reason, row.employeeConsent],
    )
    const inserted = rows[0]
    if (inserted === undefined) throw new Error('OtRepository.insert: INSERT ... RETURNING produced no row')
    return mapRow(inserted)
  }

  async findById(id: string): Promise<OtRequestRow | null> {
    const { rows } = await this.db.query(`SELECT ${SELECT_COLUMNS} FROM scheduler.ot_request WHERE id = $1`, [id])
    return rows.length > 0 && rows[0] !== undefined ? mapRow(rows[0]) : null
  }

  async findApprovedForEmployeeInRange(employeeId: string, from: string, to: string): Promise<OtRequestRow[]> {
    const { rows } = await this.db.query(
      `SELECT ${SELECT_COLUMNS} FROM scheduler.ot_request
       WHERE employee_id = $1 AND status = 'approved' AND ot_date BETWEEN $2 AND $3`,
      [employeeId, from, to],
    )
    return rows.map(mapRow)
  }

  /** Moves a `pending` request to `approved`/`rejected`. No-op (`null`) if `id` does not exist or is not currently `pending` — the service turns that into a 404/409. */
  async decide(
    tx: Queryable,
    id: string,
    status: 'approved' | 'rejected',
    decidedBy: string,
    decisionReason: string | null,
  ): Promise<OtRequestRow | null> {
    const { rows } = await tx.query(
      `UPDATE scheduler.ot_request
       SET status = $2, approved_by = $3, decision_reason = $4, updated_at = now()
       WHERE id = $1 AND status = 'pending'
       RETURNING ${SELECT_COLUMNS}`,
      [id, status, decidedBy, decisionReason],
    )
    return rows.length > 0 && rows[0] !== undefined ? mapRow(rows[0]) : null
  }
}
