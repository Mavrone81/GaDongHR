import type { Queryable } from '@gadong/kernel'

export interface EmployeeRefRow {
  employeeId: string
  status: string
  startDate: string | null
  terminatedAt: string | null
  updatedAt: string
}

function mapRow(row: Record<string, unknown>): EmployeeRefRow {
  const updatedAt = row['updated_at']
  const terminatedAt = row['terminated_at']
  return {
    employeeId: String(row['employee_id']),
    status: String(row['status']),
    startDate: row['start_date'] === null || row['start_date'] === undefined ? null : String(row['start_date']),
    terminatedAt: terminatedAt === null || terminatedAt === undefined ? null : terminatedAt instanceof Date ? terminatedAt.toISOString() : String(terminatedAt),
    updatedAt: updatedAt instanceof Date ? updatedAt.toISOString() : String(updatedAt),
  }
}

/**
 * SQL for `leave_employee_ref` — the read model `employee-ref.consumer.ts`
 * populates from `employee.*` events (DATABASE-DESIGN.md §1: "no foreign
 * keys across schemas"; roadmap "each service's DB role is granted only its
 * own schema"). This table has no write endpoint of its own — the consumer
 * is the only path anything is ever written here, matching
 * `services/svc-audit`'s `AuditConsumer` precedent for an events-only table.
 */
export class EmployeeRefRepository {
  constructor(private readonly db: Queryable) {}

  async findById(employeeId: string): Promise<EmployeeRefRow | null> {
    const { rows } = await this.db.query('SELECT * FROM leave.leave_employee_ref WHERE employee_id = $1', [employeeId])
    return rows.length > 0 && rows[0] !== undefined ? mapRow(rows[0]) : null
  }

  /** Upsert-by-hand (find-then-insert-or-update) rather than `ON CONFLICT DO UPDATE`: this fake's generic engine only understands plain `INSERT`/`UPDATE`/`SELECT` (see `testing/fake-db.ts`'s header), and `employee_id` is this table's primary key so a find-then-branch is race-free within the single transaction `idempotent()` already serializes each event through. */
  async upsert(tx: Queryable, row: { employeeId: string; status: string; startDate: string | null; terminatedAt: string | null }): Promise<EmployeeRefRow> {
    const existing = await this.findById(row.employeeId)
    if (existing) {
      const { rows } = await tx.query(
        `UPDATE leave.leave_employee_ref SET status = $2, start_date = $3, terminated_at = $4, updated_at = $5 WHERE employee_id = $1 RETURNING *`,
        [row.employeeId, row.status, row.startDate, row.terminatedAt, new Date()],
      )
      const updated = rows[0]
      if (updated === undefined) throw new Error('EmployeeRefRepository.upsert: UPDATE ... RETURNING produced no row')
      return mapRow(updated)
    }
    const { rows } = await tx.query(
      `INSERT INTO leave.leave_employee_ref (employee_id, status, start_date, terminated_at, updated_at) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [row.employeeId, row.status, row.startDate, row.terminatedAt, new Date()],
    )
    const inserted = rows[0]
    if (inserted === undefined) throw new Error('EmployeeRefRepository.upsert: INSERT ... RETURNING produced no row')
    return mapRow(inserted)
  }
}
