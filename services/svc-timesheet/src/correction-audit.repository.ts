import type { Queryable } from '@gadong/kernel'
import type { DayRecordRow } from './day-record.repository'

export interface CorrectionAuditRow {
  id: string
  dayRecordId: string
  actor: string
  at: string
  reason: string
  before: DayRecordRow
  after: DayRecordRow
}

function toIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'string') return v
  throw new Error(`CorrectionAuditRepository: unexpected timestamp value ${JSON.stringify(v)}`)
}

function parseSnapshot(v: unknown): DayRecordRow {
  return (typeof v === 'string' ? JSON.parse(v) : v) as DayRecordRow
}

const SELECT_COLUMNS = 'id, day_record_id, actor, at, reason, before, after'

function mapRow(row: Record<string, unknown>): CorrectionAuditRow {
  return {
    id: String(row['id']),
    dayRecordId: String(row['day_record_id']),
    actor: String(row['actor']),
    at: toIso(row['at']),
    reason: String(row['reason']),
    before: parseSnapshot(row['before']),
    after: parseSnapshot(row['after']),
  }
}

/**
 * `timesheet.correction_audit` (M3-3: "every manual correction stores who,
 * when and why, immutably"). Insert-only by construction — this class has no
 * `update`/`delete` method, and none should ever be added; the audit trail's
 * value is that it cannot be edited after the fact, only appended to.
 */
export class CorrectionAuditRepository {
  constructor(private readonly db: Queryable) {}

  async record(tx: Queryable, dayRecordId: string, actor: string, reason: string, before: DayRecordRow, after: DayRecordRow): Promise<CorrectionAuditRow> {
    const { rows } = await tx.query(
      `INSERT INTO timesheet.correction_audit (day_record_id, actor, reason, before, after)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
       RETURNING ${SELECT_COLUMNS}`,
      [dayRecordId, actor, reason, JSON.stringify(before), JSON.stringify(after)],
    )
    const inserted = rows[0]
    if (inserted === undefined) throw new Error('CorrectionAuditRepository.record: INSERT ... RETURNING produced no row')
    return mapRow(inserted)
  }

  /** `tx` defaults to this repository's own connection — pass the caller's transaction explicitly when checking history for a day_record that same transaction may have just corrected (see `RosterRefRepository.findOne`'s identical note). */
  async findByDayRecord(dayRecordId: string, tx: Queryable = this.db): Promise<CorrectionAuditRow[]> {
    const { rows } = await tx.query(
      `SELECT ${SELECT_COLUMNS} FROM timesheet.correction_audit WHERE day_record_id = $1 ORDER BY at`,
      [dayRecordId],
    )
    return rows.map(mapRow)
  }

  /** Whether `dayRecordId` has EVER been manually corrected — `ConsolidationService.recomputeDay`'s basis for the sticky `'corrected'` status (once corrected, a day_record never reports plain `'ok'` again, even after every open exception clears). */
  async hasAnyCorrection(dayRecordId: string, tx: Queryable = this.db): Promise<boolean> {
    return (await this.findByDayRecord(dayRecordId, tx)).length > 0
  }
}
