import type { Queryable } from '@gadong/kernel'

export interface RosterRefRow {
  employeeId: string
  workDate: string
  scheduledStart: string | null
  scheduledEnd: string | null
  graceMin: number
  hazardous: boolean
  isHoliday: boolean
  rosterEntryId: string | null
  updatedAt: string
}

export interface UpsertRosterRef {
  employeeId: string
  workDate: string
  scheduledStart: string | null
  scheduledEnd: string | null
  graceMin: number
  hazardous: boolean
  isHoliday: boolean
  rosterEntryId: string | null
}

function toIsoOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'string') return v
  throw new Error(`RosterRefRepository: unexpected timestamp value ${JSON.stringify(v)}`)
}

function toDateString(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === 'string') return v.slice(0, 10)
  throw new Error(`RosterRefRepository: unexpected date value ${JSON.stringify(v)}`)
}

const SELECT_COLUMNS =
  'employee_id, work_date, scheduled_start, scheduled_end, grace_min, hazardous, is_holiday, roster_entry_id, updated_at'

function mapRow(row: Record<string, unknown>): RosterRefRow {
  return {
    employeeId: String(row['employee_id']),
    workDate: toDateString(row['work_date']),
    scheduledStart: toIsoOrNull(row['scheduled_start']),
    scheduledEnd: toIsoOrNull(row['scheduled_end']),
    graceMin: Number(row['grace_min']),
    hazardous: Boolean(row['hazardous']),
    isHoliday: Boolean(row['is_holiday']),
    rosterEntryId: row['roster_entry_id'] === null || row['roster_entry_id'] === undefined ? null : String(row['roster_entry_id']),
    updatedAt: toIsoOrNull(row['updated_at']) as string,
  }
}

/**
 * `timesheet.roster_ref` — the local read model fed by
 * `roster.entry.published`, one event per roster entry, carrying the shift
 * timing this service cannot see across the schema boundary. Keyed by
 * (employee_id, work_date) to match `day_record`'s own key.
 *
 * The sibling `roster.published` event is a terse summary (`{rosterId,
 * orgUnitId, dateRange, entryCount}`) and deliberately NOT what this read
 * model consumes — reading it here is the defect the 2026-08-04 integration
 * reconciliation fixed. See `events.consumer.ts`'s
 * `RosterEntryPublishedPayload`.
 */
export class RosterRefRepository {
  constructor(private readonly db: Queryable) {}

  /**
   * `tx` defaults to this repository's own (non-transactional) connection.
   * A caller reading this INSIDE the same transaction that just upserted the
   * row it wants back (`ConsolidationService.recomputeDay`, called right
   * after `applyRosterEntry`'s own upsert) MUST pass its `tx` explicitly —
   * a plain read through a different connection cannot see an insert/update
   * that transaction has not committed yet.
   */
  async findOne(employeeId: string, workDate: string, tx: Queryable = this.db): Promise<RosterRefRow | null> {
    const { rows } = await tx.query(
      `SELECT ${SELECT_COLUMNS} FROM timesheet.roster_ref WHERE employee_id = $1 AND work_date = $2`,
      [employeeId, workDate],
    )
    return rows.length > 0 && rows[0] !== undefined ? mapRow(rows[0]) : null
  }

  async upsert(tx: Queryable, row: UpsertRosterRef): Promise<RosterRefRow> {
    const { rows } = await tx.query(
      `INSERT INTO timesheet.roster_ref (employee_id, work_date, scheduled_start, scheduled_end, grace_min, hazardous, is_holiday, roster_entry_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
       ON CONFLICT (employee_id, work_date) DO UPDATE
         SET scheduled_start = EXCLUDED.scheduled_start, scheduled_end = EXCLUDED.scheduled_end,
             grace_min = EXCLUDED.grace_min, hazardous = EXCLUDED.hazardous, is_holiday = EXCLUDED.is_holiday,
             roster_entry_id = EXCLUDED.roster_entry_id, updated_at = now()
       RETURNING ${SELECT_COLUMNS}`,
      [row.employeeId, row.workDate, row.scheduledStart, row.scheduledEnd, row.graceMin, row.hazardous, row.isHoliday, row.rosterEntryId],
    )
    const inserted = rows[0]
    if (inserted === undefined) throw new Error('RosterRefRepository.upsert: INSERT ... RETURNING produced no row')
    return mapRow(inserted)
  }
}
