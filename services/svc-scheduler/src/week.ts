/**
 * ISO week (Monday-Sunday) boundaries for a plain `YYYY-MM-DD` date —
 * shared by `RosterService` (weekly regular-hours ceiling) and `OtService`
 * (weekly OT ceiling), both of which sum hours "for the week containing
 * this date". Parsed as UTC-midnight throughout: these are calendar dates
 * with no time-of-day component and no timezone of their own (matching
 * `services/svc-config/src/rules.repository.ts`'s reasoning for treating
 * Postgres `date` columns as plain ISO strings, never a local-time `Date`).
 */
export interface DateRange {
  from: string
  to: string
}

function parseUtc(dateStr: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr)
  if (!match) throw new Error(`week: not a YYYY-MM-DD date: ${JSON.stringify(dateStr)}`)
  const [, y, m, d] = match as unknown as [string, string, string, string]
  return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)))
}

function toIso(d: Date): string {
  const iso = d.toISOString()
  const datePart = iso.slice(0, 10)
  return datePart
}

/** Monday..Sunday range (both inclusive) containing `dateStr`. */
export function isoWeekRange(dateStr: string): DateRange {
  const d = parseUtc(dateStr)
  const dayOfWeek = d.getUTCDay() // 0 = Sunday .. 6 = Saturday
  const isoDayOfWeek = dayOfWeek === 0 ? 7 : dayOfWeek // 1 = Monday .. 7 = Sunday
  const monday = new Date(d)
  monday.setUTCDate(d.getUTCDate() - (isoDayOfWeek - 1))
  const sunday = new Date(monday)
  sunday.setUTCDate(monday.getUTCDate() + 6)
  return { from: toIso(monday), to: toIso(sunday) }
}

/** `true` when `dateStr` falls on `dayOfWeek` (0 = Sunday .. 6 = Saturday) — used to detect a holiday landing on the (default Sunday) weekly rest day. */
export function isDayOfWeek(dateStr: string, dayOfWeek: number): boolean {
  return parseUtc(dateStr).getUTCDay() === dayOfWeek
}

/** The next calendar date after `dateStr`, as `YYYY-MM-DD`. */
export function nextDay(dateStr: string): string {
  const d = parseUtc(dateStr)
  d.setUTCDate(d.getUTCDate() + 1)
  return toIso(d)
}

/** `dateStr` shifted by `days` (may be negative), as `YYYY-MM-DD` — used by `RosterService.copyPattern` to translate a source-range date onto the target range. */
export function addDays(dateStr: string, days: number): string {
  const d = parseUtc(dateStr)
  d.setUTCDate(d.getUTCDate() + days)
  return toIso(d)
}

/** Whole-day difference `b - a` (positive when `b` is after `a`). */
export function diffDays(a: string, b: string): number {
  const msPerDay = 24 * 60 * 60 * 1000
  return Math.round((parseUtc(b).getTime() - parseUtc(a).getTime()) / msPerDay)
}
