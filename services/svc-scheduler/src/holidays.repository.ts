import type { Queryable } from '@gadong/kernel'

export interface HolidayCalendarRow {
  id: string
  year: number
}

export interface HolidayRow {
  id: string
  calendarId: string
  holidayDate: string
  nameI18n: Record<string, string>
  isSubstitute: boolean
  substituteForId: string | null
}

export interface NewHolidayRow {
  holidayDate: string
  nameI18n: Record<string, string>
  isSubstitute: boolean
  substituteForId: string | null
}

function toDateString(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === 'string') return v.slice(0, 10)
  throw new Error(`HolidaysRepository: unexpected date value ${JSON.stringify(v)}`)
}

function mapCalendar(row: Record<string, unknown>): HolidayCalendarRow {
  return { id: String(row['id']), year: Number(row['year']) }
}

function mapHoliday(row: Record<string, unknown>): HolidayRow {
  return {
    id: String(row['id']),
    calendarId: String(row['calendar_id']),
    holidayDate: toDateString(row['holiday_date']),
    nameI18n: row['name_i18n'] as Record<string, string>,
    isSubstitute: Boolean(row['is_substitute']),
    substituteForId:
      row['substitute_for_id'] === null || row['substitute_for_id'] === undefined ? null : String(row['substitute_for_id']),
  }
}

/**
 * SQL only. `holidays.service.ts` owns the ≥13 floor check (against
 * `svc-config`'s `holidays.public.min_per_year`), the "cannot reduce below
 * the floor" governance, and substitute-day generation
 * (M2-SCHEDULER §1.3).
 */
export class HolidaysRepository {
  constructor(private readonly db: Queryable) {}

  async findCalendarByYear(year: number): Promise<HolidayCalendarRow | null> {
    const { rows } = await this.db.query(`SELECT id, year FROM scheduler.holiday_calendar WHERE year = $1`, [year])
    return rows.length > 0 && rows[0] !== undefined ? mapCalendar(rows[0]) : null
  }

  async insertCalendar(tx: Queryable, year: number): Promise<HolidayCalendarRow> {
    const { rows } = await tx.query(
      `INSERT INTO scheduler.holiday_calendar (year) VALUES ($1) RETURNING id, year`,
      [year],
    )
    const inserted = rows[0]
    if (inserted === undefined) throw new Error('HolidaysRepository.insertCalendar: INSERT ... RETURNING produced no row')
    return mapCalendar(inserted)
  }

  async insertHoliday(tx: Queryable, calendarId: string, row: NewHolidayRow): Promise<HolidayRow> {
    const { rows } = await tx.query(
      `INSERT INTO scheduler.holiday (calendar_id, holiday_date, name_i18n, is_substitute, substitute_for_id)
       VALUES ($1, $2, $3::jsonb, $4, $5)
       RETURNING id, calendar_id, holiday_date, name_i18n, is_substitute, substitute_for_id`,
      [calendarId, row.holidayDate, JSON.stringify(row.nameI18n), row.isSubstitute, row.substituteForId],
    )
    const inserted = rows[0]
    if (inserted === undefined) throw new Error('HolidaysRepository.insertHoliday: INSERT ... RETURNING produced no row')
    return mapHoliday(inserted)
  }

  /** Replace semantics for `HolidaysService.setCalendar`: clears every existing holiday (real and substitute) for a calendar before the new authoritative list is reinserted, all within the caller's transaction. */
  async deleteAllByCalendar(tx: Queryable, calendarId: string): Promise<void> {
    await tx.query(`DELETE FROM scheduler.holiday WHERE calendar_id = $1`, [calendarId])
  }

  async listByCalendar(calendarId: string): Promise<HolidayRow[]> {
    const { rows } = await this.db.query(
      `SELECT id, calendar_id, holiday_date, name_i18n, is_substitute, substitute_for_id
       FROM scheduler.holiday WHERE calendar_id = $1 ORDER BY holiday_date`,
      [calendarId],
    )
    return rows.map(mapHoliday)
  }
}
