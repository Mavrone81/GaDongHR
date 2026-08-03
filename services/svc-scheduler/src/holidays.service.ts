import { GadongError } from '@gadong/kernel'
import type { Queryable } from '@gadong/kernel'
import { ConfigClient } from './config-client'
import type { HolidayRow } from './holidays.repository'
import { HolidaysRepository } from './holidays.repository'
import { isDayOfWeek, nextDay } from './week'

export interface HolidayInput {
  date: string
  nameI18n: Record<string, string>
}

export interface SetCalendarInput {
  year: number
  holidays: HolidayInput[]
  /** 0 = Sunday .. 6 = Saturday. Defaults to Sunday — the common Thai weekly rest day — when the caller does not specify one; a company with a different rest day passes it explicitly. */
  restDayOfWeek?: number
}

export interface CalendarView {
  year: number
  holidays: HolidayRow[]
}

function belowFloor(year: number, count: number, floor: number, citation: string): GadongError {
  return new GadongError('SCH-030', 'scheduler.error.holiday_floor', 422, [
    { year, providedCount: count, statutoryFloor: floor, citation },
  ])
}

/**
 * M2-3: the ≥13 floor comes from `svc-config`'s `holidays.public.min_per_year`
 * — never a hard-coded `13` here (brief CONSTRAINTS). `setCalendar` is
 * replace-semantics for the NON-substitute holiday list (M2-SCHEDULER §1.3
 * "Y[Annual holiday list ≥13 ...]"): every call supplies the full
 * authoritative list for that year, which is what makes "cannot reduce
 * below the floor" a checkable invariant on each call rather than a
 * historical one this service would have to reconstruct from prior calls.
 * Substitute holidays (M2-SCHEDULER §1.3 flowchart: a holiday landing on
 * the weekly rest day gets an auto-created substitute on the next working
 * day) are generated fresh every call and never counted toward the floor —
 * they are a consequence of the real list, not part of it.
 */
export class HolidaysService {
  constructor(
    private readonly repo: HolidaysRepository,
    private readonly configClient: ConfigClient,
  ) {}

  async getCalendar(year: number): Promise<CalendarView> {
    const calendar = await this.repo.findCalendarByYear(year)
    if (!calendar) return { year, holidays: [] }
    const holidays = await this.repo.listByCalendar(calendar.id)
    return { year, holidays }
  }

  async setCalendar(tx: Queryable, input: SetCalendarInput): Promise<CalendarView> {
    const floorRule = await this.configClient.getNumber('holidays.public.min_per_year')

    // Dedupe by date — a company listing the same statutory date twice must
    // not be able to inflate its way past the floor with duplicates.
    const byDate = new Map<string, HolidayInput>()
    for (const h of input.holidays) byDate.set(h.date, h)
    const realHolidays = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))

    if (realHolidays.length < floorRule.value) {
      throw belowFloor(input.year, realHolidays.length, floorRule.value, floorRule.citation)
    }

    const restDayOfWeek = input.restDayOfWeek ?? 0
    const substitutes = computeSubstitutes(
      realHolidays.map((h) => h.date),
      restDayOfWeek,
    )

    let calendar = await this.repo.findCalendarByYear(input.year)
    if (!calendar) {
      calendar = await this.repo.insertCalendar(tx, input.year)
    } else {
      await this.repo.deleteAllByCalendar(tx, calendar.id)
    }

    const inserted: HolidayRow[] = []
    const insertedByDate = new Map<string, HolidayRow>()
    for (const h of realHolidays) {
      const row = await this.repo.insertHoliday(tx, calendar.id, {
        holidayDate: h.date,
        nameI18n: h.nameI18n,
        isSubstitute: false,
        substituteForId: null,
      })
      inserted.push(row)
      insertedByDate.set(h.date, row)
    }
    for (const sub of substitutes) {
      const forRow = insertedByDate.get(sub.forDate)
      const row = await this.repo.insertHoliday(tx, calendar.id, {
        holidayDate: sub.date,
        nameI18n: { en: 'Substitute Holiday', th: 'วันหยุดชดเชย' },
        isSubstitute: true,
        substituteForId: forRow?.id ?? null,
      })
      inserted.push(row)
    }

    return { year: input.year, holidays: inserted }
  }
}

/**
 * Pure: for every holiday date that falls on `restDayOfWeek`, finds the
 * next date that is neither itself already a holiday nor itself the rest
 * day, and returns it as that holiday's substitute (M2-SCHEDULER §1.3).
 * Exported and tested directly so the "Songkran on a rest day" acceptance
 * scenario does not depend on which real year Songkran happens to land on
 * a Sunday.
 */
export function computeSubstitutes(
  holidayDates: string[],
  restDayOfWeek: number,
): Array<{ date: string; forDate: string }> {
  const holidaySet = new Set(holidayDates)
  const substitutes: Array<{ date: string; forDate: string }> = []

  for (const date of holidayDates) {
    if (!isDayOfWeek(date, restDayOfWeek)) continue
    let candidate = nextDay(date)
    while (holidaySet.has(candidate) || isDayOfWeek(candidate, restDayOfWeek)) {
      candidate = nextDay(candidate)
    }
    holidaySet.add(candidate) // a substitute cannot itself collide with a later substitute
    substitutes.push({ date: candidate, forDate: date })
  }

  return substitutes
}
