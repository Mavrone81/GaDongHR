import type { Queryable } from '@gadong/kernel'

export type ExceptionKind = 'missed_punch' | 'late' | 'absence' | 'unapproved_ot'

export interface TimeExceptionRow {
  id: string
  dayRecordId: string
  kind: ExceptionKind
  resolution: string | null
  resolvedBy: string | null
  reason: string | null
  createdAt: string
  updatedAt: string
}

const SELECT_COLUMNS = 'id, day_record_id, kind, resolution, resolved_by, reason, created_at, updated_at'

function toIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'string') return v
  throw new Error(`ExceptionRepository: unexpected timestamp value ${JSON.stringify(v)}`)
}

function mapRow(row: Record<string, unknown>): TimeExceptionRow {
  return {
    id: String(row['id']),
    dayRecordId: String(row['day_record_id']),
    kind: row['kind'] as ExceptionKind,
    resolution: row['resolution'] === null || row['resolution'] === undefined ? null : String(row['resolution']),
    resolvedBy: row['resolved_by'] === null || row['resolved_by'] === undefined ? null : String(row['resolved_by']),
    reason: row['reason'] === null || row['reason'] === undefined ? null : String(row['reason']),
    createdAt: toIso(row['created_at']),
    updatedAt: toIso(row['updated_at']),
  }
}

/**
 * `timesheet.time_exception` (M3-3). `resolution IS NULL` means OPEN — the
 * lock guard (`PeriodService`) and the exception queue (`ViewsService`)
 * both key off exactly that. SQL only; `ConsolidationService` (raising) and
 * `ExceptionsService` (proposing/confirming) own the workflow.
 */
export class ExceptionRepository {
  constructor(private readonly db: Queryable) {}

  async findById(id: string): Promise<TimeExceptionRow | null> {
    return this.findByIdTx(this.db, id)
  }

  /** `findById`, reading through a caller-supplied `tx` — see `RosterRefRepository.findOne`'s doc for why a same-transaction caller must use this instead. */
  async findByIdTx(tx: Queryable, id: string): Promise<TimeExceptionRow | null> {
    const { rows } = await tx.query(`SELECT ${SELECT_COLUMNS} FROM timesheet.time_exception WHERE id = $1`, [id])
    return rows.length > 0 && rows[0] !== undefined ? mapRow(rows[0]) : null
  }

  async findOpenByDayRecordAndKind(dayRecordId: string, kind: ExceptionKind): Promise<TimeExceptionRow | null> {
    return this.findOpenByDayRecordAndKindTx(this.db, dayRecordId, kind)
  }

  /**
   * Same query as `findOpenByDayRecordAndKind`, but reads through a
   * caller-supplied `Queryable` — critically, THE SAME `tx` a same-transaction
   * `raise()`/`autoResolve()` call just wrote through. `ConsolidationService.
   * recomputeDay` must use this variant, not the plain one: a plain read
   * through this repository's own (non-tx) connection cannot see a row this
   * very transaction inserted but has not committed yet, which would
   * silently miss a just-raised exception when deciding whether
   * `day_record.status` should flip to `'exception'` in that same call.
   */
  async findOpenByDayRecordAndKindTx(tx: Queryable, dayRecordId: string, kind: ExceptionKind): Promise<TimeExceptionRow | null> {
    const { rows } = await tx.query(
      `SELECT ${SELECT_COLUMNS} FROM timesheet.time_exception
       WHERE day_record_id = $1 AND kind = $2 AND resolution IS NULL`,
      [dayRecordId, kind],
    )
    return rows.length > 0 && rows[0] !== undefined ? mapRow(rows[0]) : null
  }

  async findByDayRecord(dayRecordId: string): Promise<TimeExceptionRow[]> {
    const { rows } = await this.db.query(
      `SELECT ${SELECT_COLUMNS} FROM timesheet.time_exception WHERE day_record_id = $1 ORDER BY created_at`,
      [dayRecordId],
    )
    return rows.map(mapRow)
  }

  async raise(tx: Queryable, dayRecordId: string, kind: ExceptionKind, reason: string | null): Promise<TimeExceptionRow> {
    const { rows } = await tx.query(
      `INSERT INTO timesheet.time_exception (day_record_id, kind, reason) VALUES ($1, $2, $3)
       RETURNING ${SELECT_COLUMNS}`,
      [dayRecordId, kind, reason],
    )
    const inserted = rows[0]
    if (inserted === undefined) throw new Error('ExceptionRepository.raise: INSERT ... RETURNING produced no row')
    return mapRow(inserted)
  }

  /** Manager's proposed fix — `resolution` records the PROPOSAL, not yet confirmed. Distinct `propose` vs `confirm` steps so HR confirmation is a separate, auditable action (M3-3 state diagram: open → proposed → corrected). */
  async propose(tx: Queryable, id: string, resolution: string, proposedBy: string): Promise<TimeExceptionRow | null> {
    const { rows } = await tx.query(
      `UPDATE timesheet.time_exception SET resolution = $2, resolved_by = $3, updated_at = now()
       WHERE id = $1 AND resolution IS NULL
       RETURNING ${SELECT_COLUMNS}`,
      [id, `proposed:${resolution}`, proposedBy],
    )
    return rows.length > 0 && rows[0] !== undefined ? mapRow(rows[0]) : null
  }

  /**
   * HR confirms — `finalResolution` is the CALLER's chosen final text
   * (`ExceptionsService.confirm` passes the manager's human-readable
   * `reason`, not the raw `proposed:{...json...}` blob `propose` stored,
   * which exists only to carry the pending correction payload between the
   * two steps). Only succeeds against a row currently in the `proposed:`
   * state; reads through `tx` (not this repository's plain connection) so
   * a `propose()` made earlier IN THE SAME transaction is visible here —
   * see `RosterRefRepository.findOne`'s doc for why that matters.
   */
  async confirm(tx: Queryable, id: string, confirmedBy: string, finalResolution: string): Promise<TimeExceptionRow | null> {
    const existing = await this.findByIdTx(tx, id)
    if (!existing || existing.resolution === null || !existing.resolution.startsWith('proposed:')) return null
    const { rows } = await tx.query(
      `UPDATE timesheet.time_exception SET resolution = $2, resolved_by = $3, updated_at = now()
       WHERE id = $1
       RETURNING ${SELECT_COLUMNS}`,
      [id, finalResolution, confirmedBy],
    )
    return rows.length > 0 && rows[0] !== undefined ? mapRow(rows[0]) : null
  }

  /** System-driven auto-resolution (e.g. a late `ot.approved` regularises a previously-open `unapproved_ot` exception) — `resolved_by` stays null to distinguish it from a human decision. */
  async autoResolve(tx: Queryable, id: string, resolution: string): Promise<TimeExceptionRow | null> {
    const { rows } = await tx.query(
      `UPDATE timesheet.time_exception SET resolution = $2, updated_at = now()
       WHERE id = $1 AND resolution IS NULL
       RETURNING ${SELECT_COLUMNS}`,
      [id, resolution],
    )
    return rows.length > 0 && rows[0] !== undefined ? mapRow(rows[0]) : null
  }

  /** Any OPEN exception (`resolution IS NULL`) for a day_record whose `work_date` falls in `[from, to]` — the period-lock guard's exact query (`TSH-030`). */
  async findOpenInDateRange(from: string, to: string): Promise<TimeExceptionRow[]> {
    const { rows } = await this.db.query(
      `SELECT te.id, te.day_record_id, te.kind, te.resolution, te.resolved_by, te.reason, te.created_at, te.updated_at
       FROM timesheet.time_exception te
       JOIN timesheet.day_record dr ON dr.id = te.day_record_id
       WHERE te.resolution IS NULL AND dr.work_date BETWEEN $1 AND $2`,
      [from, to],
    )
    return rows.map(mapRow)
  }

  /** Manager/HR queue (`GET /exceptions?status&org_unit`), optionally scoped to a set of employee ids (row scoping). */
  async findByStatusAndEmployees(status: 'open' | 'resolved', employeeIds: string[] | null): Promise<TimeExceptionRow[]> {
    const clause = status === 'open' ? 'te.resolution IS NULL' : 'te.resolution IS NOT NULL'
    const { rows } = await this.db.query(
      `SELECT te.id, te.day_record_id, te.kind, te.resolution, te.resolved_by, te.reason, te.created_at, te.updated_at
       FROM timesheet.time_exception te
       JOIN timesheet.day_record dr ON dr.id = te.day_record_id
       WHERE ${clause} AND ($1::text[] IS NULL OR dr.employee_id = ANY($1))
       ORDER BY te.created_at`,
      [employeeIds],
    )
    return rows.map(mapRow)
  }
}
