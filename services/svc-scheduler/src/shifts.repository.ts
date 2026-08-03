import type { Queryable } from '@gadong/kernel'

export interface BreakRule {
  minutes: number
  paid: boolean
}

export interface Differential {
  kind: 'flat' | 'percent'
  amount: number
}

export interface ShiftRow {
  id: string
  nameI18n: Record<string, string>
  startT: string
  endT: string
  crossesMidnight: boolean
  breakRules: BreakRule[]
  graceMin: number
  differential: Differential | null
  createdAt: string
  updatedAt: string
}

export interface NewShiftRow {
  nameI18n: Record<string, string>
  startT: string
  endT: string
  crossesMidnight: boolean
  breakRules: BreakRule[]
  graceMin: number
  differential: Differential | null
}

export interface ShiftPatch {
  nameI18n?: Record<string, string>
  startT?: string
  endT?: string
  crossesMidnight?: boolean
  breakRules?: BreakRule[]
  graceMin?: number
  differential?: Differential | null
}

const SELECT_COLUMNS =
  'id, name_i18n, start_t, end_t, crosses_midnight, break_rules, grace_min, differential, created_at, updated_at'

function toIsoString(v: unknown): string {
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'string') return v
  throw new Error(`ShiftsRepository: unexpected timestamp value ${JSON.stringify(v)}`)
}

/** Postgres `time` columns round-trip as `HH:MM:SS`; `hours.ts` parses either that or `HH:MM`. */
function toTimeString(v: unknown): string {
  if (typeof v === 'string') return v
  throw new Error(`ShiftsRepository: unexpected time value ${JSON.stringify(v)}`)
}

function mapRow(row: Record<string, unknown>): ShiftRow {
  return {
    id: String(row['id']),
    nameI18n: row['name_i18n'] as Record<string, string>,
    startT: toTimeString(row['start_t']),
    endT: toTimeString(row['end_t']),
    crossesMidnight: Boolean(row['crosses_midnight']),
    breakRules: (row['break_rules'] as BreakRule[] | null) ?? [],
    graceMin: Number(row['grace_min']),
    differential: (row['differential'] as Differential | null) ?? null,
    createdAt: toIsoString(row['created_at']),
    updatedAt: toIsoString(row['updated_at']),
  }
}

/** SQL only — no duration math, no validation beyond what the DB itself enforces (`shift_grace_min_check`). `hours.ts` owns duration math; `shifts.service.ts` owns everything else. */
export class ShiftsRepository {
  constructor(private readonly db: Queryable) {}

  async insert(tx: Queryable, row: NewShiftRow): Promise<ShiftRow> {
    const { rows } = await tx.query(
      `INSERT INTO scheduler.shift (name_i18n, start_t, end_t, crosses_midnight, break_rules, grace_min, differential)
       VALUES ($1::jsonb, $2, $3, $4, $5::jsonb, $6, $7::jsonb)
       RETURNING ${SELECT_COLUMNS}`,
      [
        JSON.stringify(row.nameI18n),
        row.startT,
        row.endT,
        row.crossesMidnight,
        JSON.stringify(row.breakRules),
        row.graceMin,
        JSON.stringify(row.differential),
      ],
    )
    const inserted = rows[0]
    if (inserted === undefined) throw new Error('ShiftsRepository.insert: INSERT ... RETURNING produced no row')
    return mapRow(inserted)
  }

  async findById(id: string): Promise<ShiftRow | null> {
    const { rows } = await this.db.query(`SELECT ${SELECT_COLUMNS} FROM scheduler.shift WHERE id = $1`, [id])
    return rows.length > 0 && rows[0] !== undefined ? mapRow(rows[0]) : null
  }

  async list(): Promise<ShiftRow[]> {
    const { rows } = await this.db.query(`SELECT ${SELECT_COLUMNS} FROM scheduler.shift ORDER BY created_at`, [])
    return rows.map(mapRow)
  }

  /** Whole-row replace of the patched fields — the service loads the current row, merges the patch, and calls this with the full resulting shape, so this method never has to build a dynamic SET list. */
  async update(tx: Queryable, id: string, row: NewShiftRow): Promise<ShiftRow | null> {
    const { rows } = await tx.query(
      `UPDATE scheduler.shift
       SET name_i18n = $2::jsonb, start_t = $3, end_t = $4, crosses_midnight = $5,
           break_rules = $6::jsonb, grace_min = $7, differential = $8::jsonb, updated_at = now()
       WHERE id = $1
       RETURNING ${SELECT_COLUMNS}`,
      [
        id,
        JSON.stringify(row.nameI18n),
        row.startT,
        row.endT,
        row.crossesMidnight,
        JSON.stringify(row.breakRules),
        row.graceMin,
        JSON.stringify(row.differential),
      ],
    )
    return rows.length > 0 && rows[0] !== undefined ? mapRow(rows[0]) : null
  }
}
