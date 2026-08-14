import type { Queryable } from '@gadong/kernel'

export type RosterStatus = 'planned' | 'published'

export interface RosterEntryRow {
  id: string
  employeeId: string
  shiftId: string
  workDate: string
  status: RosterStatus
  overrideReason: string | null
  hazardous: boolean
  createdAt: string
  updatedAt: string
}

export interface NewRosterEntryRow {
  employeeId: string
  shiftId: string
  workDate: string
  overrideReason: string | null
  hazardous: boolean
}

function toIsoString(v: unknown): string {
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'string') return v
  throw new Error(`RosterRepository: unexpected timestamp value ${JSON.stringify(v)}`)
}

function toDateString(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === 'string') return v.slice(0, 10)
  throw new Error(`RosterRepository: unexpected date value ${JSON.stringify(v)}`)
}

const SELECT_COLUMNS =
  'id, employee_id, shift_id, work_date, status, override_reason, hazardous, created_at, updated_at'

function mapRow(row: Record<string, unknown>): RosterEntryRow {
  return {
    id: String(row['id']),
    employeeId: String(row['employee_id']),
    shiftId: String(row['shift_id']),
    workDate: toDateString(row['work_date']),
    status: row['status'] as RosterStatus,
    overrideReason: row['override_reason'] === null || row['override_reason'] === undefined ? null : String(row['override_reason']),
    hazardous: Boolean(row['hazardous']),
    createdAt: toIsoString(row['created_at']),
    updatedAt: toIsoString(row['updated_at']),
  }
}

/**
 * SQL only — no conflict detection, no guardrail evaluation, no event
 * publishing (`roster.service.ts` owns all of that, matching the
 * `services/svc-config` split). `employee_id` is a bare uuid throughout,
 * never a query parameter joined against `scheduler_employee_ref` in SQL —
 * this repository never performs a cross-table join; the service layer
 * composes results from this repository and `EmployeeRefRepository`/
 * `LeaveRefRepository` in application code (Task 14 migration header: no
 * FK, and by the same reasoning, no implicit SQL-level coupling either).
 */
export class RosterRepository {
  constructor(private readonly db: Queryable) {}

  async insert(tx: Queryable, row: NewRosterEntryRow): Promise<RosterEntryRow> {
    const { rows } = await tx.query(
      `INSERT INTO scheduler.roster_entry (employee_id, shift_id, work_date, status, override_reason, hazardous)
       VALUES ($1, $2, $3, 'planned', $4, $5)
       RETURNING ${SELECT_COLUMNS}`,
      [row.employeeId, row.shiftId, row.workDate, row.overrideReason, row.hazardous],
    )
    const inserted = rows[0]
    if (inserted === undefined) throw new Error('RosterRepository.insert: INSERT ... RETURNING produced no row')
    return mapRow(inserted)
  }

  async findById(id: string): Promise<RosterEntryRow | null> {
    const { rows } = await this.db.query(`SELECT ${SELECT_COLUMNS} FROM scheduler.roster_entry WHERE id = $1`, [id])
    return rows.length > 0 && rows[0] !== undefined ? mapRow(rows[0]) : null
  }

  async findByEmployeeAndDate(employeeId: string, workDate: string): Promise<RosterEntryRow[]> {
    const { rows } = await this.db.query(
      `SELECT ${SELECT_COLUMNS} FROM scheduler.roster_entry WHERE employee_id = $1 AND work_date = $2`,
      [employeeId, workDate],
    )
    return rows.map(mapRow)
  }

  async findByEmployeeAndDateRange(employeeId: string, from: string, to: string): Promise<RosterEntryRow[]> {
    const { rows } = await this.db.query(
      `SELECT ${SELECT_COLUMNS} FROM scheduler.roster_entry WHERE employee_id = $1 AND work_date BETWEEN $2 AND $3`,
      [employeeId, from, to],
    )
    return rows.map(mapRow)
  }

  /** `employeeIds: null` means every employee (the team roster grid); a non-null array scopes to exactly those employees. */
  async findByDateRange(from: string, to: string, employeeIds: string[] | null): Promise<RosterEntryRow[]> {
    const { rows } = await this.db.query(
      `SELECT ${SELECT_COLUMNS} FROM scheduler.roster_entry
       WHERE work_date BETWEEN $1 AND $2 AND ($3::uuid[] IS NULL OR employee_id = ANY($3::uuid[]))`,
      [from, to, employeeIds],
    )
    return rows.map(mapRow)
  }

  async setOverrideReason(tx: Queryable, id: string, reason: string): Promise<RosterEntryRow | null> {
    const { rows } = await tx.query(
      `UPDATE scheduler.roster_entry SET override_reason = $2, updated_at = now() WHERE id = $1 RETURNING ${SELECT_COLUMNS}`,
      [id, reason],
    )
    return rows.length > 0 && rows[0] !== undefined ? mapRow(rows[0]) : null
  }

  /** Publishes every `planned` entry in range (optionally scoped to `employeeIds`) to `published`, returning the rows that changed. */
  async publishRange(tx: Queryable, from: string, to: string, employeeIds: string[] | null): Promise<RosterEntryRow[]> {
    const { rows } = await tx.query(
      `UPDATE scheduler.roster_entry
       SET status = 'published', updated_at = now()
       WHERE work_date BETWEEN $1 AND $2 AND status = 'planned' AND ($3::uuid[] IS NULL OR employee_id = ANY($3::uuid[]))
       RETURNING ${SELECT_COLUMNS}`,
      [from, to, employeeIds],
    )
    return rows.map(mapRow)
  }
}
