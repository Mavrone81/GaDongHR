/**
 * Duration/hours math for day-record consolidation — same discipline as
 * `services/svc-scheduler/src/hours.ts`: every intermediate accumulation is
 * done in INTEGER MINUTES (exact under `Number.MAX_SAFE_INTEGER`), and a
 * float division only ever happens once, at the final minutes-to-hours-string
 * conversion, on a value already rounded to the nearest minute. "Hours are
 * numeric throughout" (brief CONSTRAINTS) is a discipline about where a float
 * is allowed to touch a value that is stored or compared — this module is
 * where that discipline lives for svc-timesheet, mirroring the sibling
 * service exactly so a reviewer already familiar with one recognises the
 * other.
 */

/** Converts a whole number of minutes to a fixed 2-decimal-place hours string — the shape every `numeric` column and JSON payload in this service carries hours in. */
export function minutesToHoursString(totalMinutes: number): string {
  if (!Number.isInteger(totalMinutes)) {
    throw new Error(`hours: minutesToHoursString requires an integer minute count, got ${totalMinutes}`)
  }
  const negative = totalMinutes < 0
  const abs = Math.abs(totalMinutes)
  const wholeHours = Math.trunc(abs / 60)
  const remainderMinutes = abs % 60
  const hundredths = Math.round((remainderMinutes * 100) / 60)
  const carry = hundredths === 100
  const wholePart = wholeHours + (carry ? 1 : 0)
  const fracPart = carry ? 0 : hundredths
  const sign = negative && (wholePart !== 0 || fracPart !== 0) ? '-' : ''
  return `${sign}${wholePart}.${String(fracPart).padStart(2, '0')}`
}

/** Parses a `numeric` hours string into integer minutes — the inverse of `minutesToHoursString` for values it produced. */
export function hoursStringToMinutes(hours: string): number {
  const value = Number.parseFloat(hours)
  if (!Number.isFinite(value)) throw new Error(`hours: unparseable hours value ${JSON.stringify(hours)}`)
  return Math.round(value * 60)
}

/**
 * Whole minutes between two ISO timestamps (`end` - `start`), floored at 0 —
 * a punch-out before its punch-in is a physical impossibility the migration's
 * own `day_record_actual_out_after_in_check` CHECK constraint already
 * refuses to store, so this never needs to represent a negative duration.
 */
export function minutesBetween(startIso: string, endIso: string): number {
  const start = Date.parse(startIso)
  const end = Date.parse(endIso)
  if (Number.isNaN(start) || Number.isNaN(end)) {
    throw new Error(`hours: unparseable timestamp (${startIso} .. ${endIso})`)
  }
  return Math.max(0, Math.round((end - start) / 60_000))
}

/** The `YYYY-MM-DD` calendar date (UTC) an ISO timestamp falls on. */
export function dateOf(iso: string): string {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) throw new Error(`hours: unparseable timestamp ${JSON.stringify(iso)}`)
  return new Date(ms).toISOString().slice(0, 10)
}

/** `dateStr` (`YYYY-MM-DD`) shifted by `days` (may be negative), as `YYYY-MM-DD`. */
export function addDays(dateStr: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr)
  if (!match) throw new Error(`hours: not a YYYY-MM-DD date: ${JSON.stringify(dateStr)}`)
  const [, y, m, d] = match as unknown as [string, string, string, string]
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)))
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

/** Every `YYYY-MM-DD` date from `from` to `to`, inclusive. */
export function dateRange(from: string, to: string): string[] {
  const dates: string[] = []
  let cursor = from
  while (cursor <= to) {
    dates.push(cursor)
    cursor = addDays(cursor, 1)
  }
  return dates
}
