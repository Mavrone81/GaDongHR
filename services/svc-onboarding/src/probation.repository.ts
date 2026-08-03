import type { Queryable } from '@gadong/kernel'

export type ProbationOutcome = 'confirm' | 'extend' | 'terminate'

export interface ProbationRow {
  id: string
  employeeId: string
  endDate: string
  outcome: ProbationOutcome | null
  decidedAt: string | null
  extendedTo: string | null
}

const SELECT_COLUMNS = 'id, employee_id, end_date, outcome, decided_at, extended_to'

function toDateString(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === 'string') return v.slice(0, 10)
  throw new Error(`ProbationRepository: unexpected date value ${JSON.stringify(v)}`)
}
function toDateStringOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : toDateString(v)
}
function toIsoStringOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'string') return v
  throw new Error(`ProbationRepository: unexpected timestamp value ${JSON.stringify(v)}`)
}

function mapRow(row: Record<string, unknown>): ProbationRow {
  return {
    id: String(row['id']),
    employeeId: String(row['employee_id']),
    endDate: toDateString(row['end_date']),
    outcome: (row['outcome'] as ProbationOutcome | null) ?? null,
    decidedAt: toIsoStringOrNull(row['decided_at']),
    extendedTo: toDateStringOrNull(row['extended_to']),
  }
}

/**
 * SQL for `onboarding.probation` — M1-5. `insert`/`decide` take the
 * CALLER's transaction handle `tx` so a decision and any employee-status
 * side effect (e.g. `terminate` transitioning the employee row and
 * publishing `employee.terminated`) commit or roll back together
 * (ADR-005). `employee_id` is `UNIQUE` (the ERD's 0..1 relationship) —
 * `insert` relies on the DB (fake or real) to enforce that.
 */
export class ProbationRepository {
  constructor(private readonly db: Queryable) {}

  async insert(tx: Queryable, employeeId: string, endDate: string): Promise<ProbationRow> {
    const { rows } = await tx.query(
      `INSERT INTO onboarding.probation (employee_id, end_date) VALUES ($1, $2) RETURNING ${SELECT_COLUMNS}`,
      [employeeId, endDate],
    )
    const inserted = rows[0]
    if (inserted === undefined) throw new Error('ProbationRepository.insert: INSERT ... RETURNING produced no row')
    return mapRow(inserted)
  }

  async findByEmployeeId(employeeId: string): Promise<ProbationRow | null> {
    const { rows } = await this.db.query(`SELECT ${SELECT_COLUMNS} FROM onboarding.probation WHERE employee_id = $1`, [employeeId])
    return rows.length > 0 && rows[0] !== undefined ? mapRow(rows[0]) : null
  }

  /** Records the outcome. `extendedTo` is only meaningful for `outcome = 'extend'`; `null` otherwise. No-op (`null`) if `id` does not exist. */
  async decide(tx: Queryable, id: string, outcome: ProbationOutcome, decidedAt: string, extendedTo: string | null): Promise<ProbationRow | null> {
    const { rows } = await tx.query(
      `UPDATE onboarding.probation SET outcome = $1, decided_at = $2, extended_to = $3 WHERE id = $4 RETURNING ${SELECT_COLUMNS}`,
      [outcome, decidedAt, extendedTo, id],
    )
    return rows.length > 0 && rows[0] !== undefined ? mapRow(rows[0]) : null
  }
}
