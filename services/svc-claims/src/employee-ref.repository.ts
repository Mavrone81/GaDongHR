import type { Queryable } from '@gadong/kernel'

export interface EmployeeRefRow {
  employeeId: string
  status: string
  updatedAt: string
}

function toIsoString(v: unknown): string {
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'string') return v
  throw new Error(`EmployeeRefRepository: unexpected timestamp value ${JSON.stringify(v)}`)
}

function mapRow(row: Record<string, unknown>): EmployeeRefRow {
  return { employeeId: String(row['employee_id']), status: String(row['status']), updatedAt: toIsoString(row['updated_at']) }
}

/**
 * SQL only for `claims.claims_employee_ref` — the read model the base
 * migration created for `employee.*` events (DATABASE-DESIGN.md §1: "no
 * foreign keys across schemas"). `employee-events.service.ts` owns the
 * upsert-vs-terminate business logic; this file only writes/reads the row.
 */
export class EmployeeRefRepository {
  constructor(private readonly db: Queryable) {}

  async findById(employeeId: string): Promise<EmployeeRefRow | null> {
    const { rows } = await this.db.query(`SELECT employee_id, status, updated_at FROM claims.claims_employee_ref WHERE employee_id = $1`, [
      employeeId,
    ])
    return rows.length > 0 && rows[0] !== undefined ? mapRow(rows[0]) : null
  }

  async upsert(tx: Queryable, employeeId: string, status: string): Promise<EmployeeRefRow> {
    const { rows } = await tx.query(
      `INSERT INTO claims.claims_employee_ref (employee_id, status, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (employee_id) DO UPDATE SET status = EXCLUDED.status, updated_at = now()
       RETURNING employee_id, status, updated_at`,
      [employeeId, status],
    )
    const row = rows[0]
    if (row === undefined) throw new Error('EmployeeRefRepository.upsert: INSERT ... RETURNING produced no row')
    return mapRow(row)
  }
}
