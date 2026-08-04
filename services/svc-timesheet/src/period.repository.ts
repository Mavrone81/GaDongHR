import type { Queryable } from '@gadong/kernel'

export type PeriodStatus = 'open' | 'locked'

export interface PeriodRow {
  id: string
  from: string
  to: string
  status: PeriodStatus
  lockVersion: number
  lockedBy: string | null
  lockedAt: string | null
  createdAt: string
  updatedAt: string
}

const SELECT_COLUMNS =
  "id, lower(range) AS from_date, (upper(range) - 1) AS to_date, status, lock_version, locked_by, locked_at, created_at, updated_at"

function toDateString(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === 'string') return v.slice(0, 10)
  throw new Error(`PeriodRepository: unexpected date value ${JSON.stringify(v)}`)
}

function toIsoOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'string') return v
  throw new Error(`PeriodRepository: unexpected timestamp value ${JSON.stringify(v)}`)
}

function mapRow(row: Record<string, unknown>): PeriodRow {
  return {
    id: String(row['id']),
    from: toDateString(row['from_date']),
    to: toDateString(row['to_date']),
    status: row['status'] as PeriodStatus,
    lockVersion: Number(row['lock_version']),
    lockedBy: row['locked_by'] === null || row['locked_by'] === undefined ? null : String(row['locked_by']),
    lockedAt: toIsoOrNull(row['locked_at']),
    createdAt: toIsoOrNull(row['created_at']) as string,
    updatedAt: toIsoOrNull(row['updated_at']) as string,
  }
}

/**
 * `timesheet.period` — the daterange EXCLUDE constraint (Task 14 migration)
 * guarantees no two periods ever claim the same date, so `findContaining`
 * always resolves to at most one row for any given date. `[from, to]` here
 * are both INCLUSIVE calendar dates; `range` is a Postgres `daterange`
 * (upper bound exclusive by Postgres convention), so `to` is stored as
 * `upper(range) - 1`.
 */
export class PeriodRepository {
  constructor(private readonly db: Queryable) {}

  async findById(id: string): Promise<PeriodRow | null> {
    const { rows } = await this.db.query(`SELECT ${SELECT_COLUMNS} FROM timesheet.period WHERE id = $1`, [id])
    return rows.length > 0 && rows[0] !== undefined ? mapRow(rows[0]) : null
  }

  /** The (at most one) period whose range contains `date`. */
  async findContaining(date: string): Promise<PeriodRow | null> {
    const { rows } = await this.db.query(
      `SELECT ${SELECT_COLUMNS} FROM timesheet.period WHERE range @> $1::date`,
      [date],
    )
    return rows.length > 0 && rows[0] !== undefined ? mapRow(rows[0]) : null
  }

  async create(tx: Queryable, from: string, to: string): Promise<PeriodRow> {
    const { rows } = await tx.query(
      `INSERT INTO timesheet.period (range) VALUES (daterange($1::date, ($2::date + 1), '[)')) RETURNING ${SELECT_COLUMNS}`,
      [from, to],
    )
    const inserted = rows[0]
    if (inserted === undefined) throw new Error('PeriodRepository.create: INSERT ... RETURNING produced no row')
    return mapRow(inserted)
  }

  /** Transitions `open -> locked`, incrementing `lock_version` — the same call handles a first lock (0 -> 1) and a re-lock after unlock (1 -> 2), matching TC-M3-013 ("re-lock → v2 published"). Returns null if the period was not `open` (lost a race, or already locked). */
  async lock(tx: Queryable, id: string, lockedBy: string): Promise<PeriodRow | null> {
    const { rows } = await tx.query(
      `UPDATE timesheet.period
       SET status = 'locked', lock_version = lock_version + 1, locked_by = $2, locked_at = now(), updated_at = now()
       WHERE id = $1 AND status = 'open'
       RETURNING ${SELECT_COLUMNS}`,
      [id, lockedBy],
    )
    return rows.length > 0 && rows[0] !== undefined ? mapRow(rows[0]) : null
  }

  /** Transitions `locked -> open`. `lock_version` is untouched here — it advances on the NEXT lock, so it always identifies exactly the hours-set a given lock published (see `lock`'s doc). Returns null if the period was not `locked`. */
  async unlock(tx: Queryable, id: string): Promise<PeriodRow | null> {
    const { rows } = await tx.query(
      `UPDATE timesheet.period
       SET status = 'open', locked_by = NULL, locked_at = NULL, updated_at = now()
       WHERE id = $1 AND status = 'locked'
       RETURNING ${SELECT_COLUMNS}`,
      [id],
    )
    return rows.length > 0 && rows[0] !== undefined ? mapRow(rows[0]) : null
  }

  async list(): Promise<PeriodRow[]> {
    const { rows } = await this.db.query(`SELECT ${SELECT_COLUMNS} FROM timesheet.period ORDER BY range`, [])
    return rows.map(mapRow)
  }
}
