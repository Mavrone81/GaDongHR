/**
 * Duration/hours math for shifts, rosters and OT — all of it in INTEGER
 * MINUTES until the very last step, which converts once to a fixed
 * 2-decimal-place `numeric` string. "Hours are numeric, never float" (brief
 * CONSTRAINTS) is a discipline about where floats are allowed to touch a
 * value that is stored or compared, not a ban on the `number` type outright
 * — Postgres's `numeric` column type has no in-process representation other
 * than a decimal string or a big-decimal library, and this codebase has
 * neither available (no `decimal.js`/`big.js` dependency anywhere in the
 * workspace). The discipline this module actually enforces: every
 * intermediate accumulation (summing a week's shifts, adding OT hours) is
 * done on `HHMM` integer minutes, which JS represents exactly up to
 * `Number.MAX_SAFE_INTEGER` — no rounding error can accumulate the way it
 * would if this summed `7.5 + 7.5 + ...` as floating-point hours. A float
 * division only ever happens once, at the final minutes-to-hours-string
 * conversion, on a value already rounded to the nearest minute.
 */

export interface ShiftTiming {
  /** `HH:MM` or `HH:MM:SS`, as returned by Postgres's `time` column type. */
  startT: string
  endT: string
  crossesMidnight: boolean
  /** Total unpaid break minutes to subtract (sum of `break_rules`), never negative. */
  breakMinutes: number
}

function parseMinutesOfDay(t: string): number {
  const parts = t.split(':')
  const hh = parts[0]
  const mm = parts[1]
  if (hh === undefined || mm === undefined) {
    throw new Error(`hours: unparseable time value ${JSON.stringify(t)}`)
  }
  const hours = Number.parseInt(hh, 10)
  const minutes = Number.parseInt(mm, 10)
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) {
    throw new Error(`hours: unparseable time value ${JSON.stringify(t)}`)
  }
  return hours * 60 + minutes
}

/**
 * Raw (pre-break) shift span in minutes. THE case that breaks naive time
 * handling: a night shift like `22:00`–`06:00` has `endT < startT` in
 * clock-of-day terms, which means "ends the following day", not "invalid
 * range" or "zero/negative duration" — `crossesMidnight` is the explicit
 * flag this function branches on (never inferred by comparing the two
 * times, which is exactly the naive approach that gets midnight-crossing
 * wrong): a same-day shift with `endT <= startT` and `crossesMidnight:
 * false` is a genuine data error, not silently treated as crossing.
 */
export function rawSpanMinutes(timing: Pick<ShiftTiming, 'startT' | 'endT' | 'crossesMidnight'>): number {
  const start = parseMinutesOfDay(timing.startT)
  const end = parseMinutesOfDay(timing.endT)

  if (timing.crossesMidnight) {
    // 22:00 -> 06:00: (24*60 - 22*60) + 06*60 = 120 + 360 = 480 minutes (8h).
    // Explicitly assert-worthy boundary case tested in hours.test.ts.
    return 24 * 60 - start + end
  }

  if (end <= start) {
    throw new Error(
      `hours: shift end (${timing.endT}) is not after start (${timing.startT}) and crossesMidnight is false — ` +
        'a genuinely same-day shift must end after it starts; a shift spanning midnight must set crossesMidnight: true',
    )
  }
  return end - start
}

/** Paid duration in minutes: raw span minus unpaid break minutes, floored at 0. */
export function paidDurationMinutes(timing: ShiftTiming): number {
  const raw = rawSpanMinutes(timing)
  const paid = raw - Math.max(0, timing.breakMinutes)
  return Math.max(0, paid)
}

/**
 * Converts a whole number of minutes to a fixed 2-decimal-place hours
 * string — the shape `numeric` columns and JSON payloads carry hours in
 * throughout this service (never a bare float). The single float division
 * below operates on an already-integral minute count, so its result is
 * rounded to the nearest hundredth immediately and never re-accumulated.
 */
export function minutesToHoursString(totalMinutes: number): string {
  if (!Number.isInteger(totalMinutes)) {
    throw new Error(`hours: minutesToHoursString requires an integer minute count, got ${totalMinutes}`)
  }
  const negative = totalMinutes < 0
  const abs = Math.abs(totalMinutes)
  const wholeHours = Math.trunc(abs / 60)
  const remainderMinutes = abs % 60
  // remainderMinutes is always 0..59, so this multiply/divide/round never
  // approaches a float-precision edge case in practice; it is the one
  // deliberate float touch-point in this whole module, isolated here.
  const hundredths = Math.round((remainderMinutes * 100) / 60)
  const carry = hundredths === 100 // 59 minutes can round up to "60"
  const wholePart = wholeHours + (carry ? 1 : 0)
  const fracPart = carry ? 0 : hundredths
  const sign = negative && (wholePart !== 0 || fracPart !== 0) ? '-' : ''
  return `${sign}${wholePart}.${String(fracPart).padStart(2, '0')}`
}

/** Parses a `numeric` hours string (as returned by `pg`) into integer minutes, the inverse of `minutesToHoursString` for values it produced. */
export function hoursStringToMinutes(hours: string): number {
  const value = Number.parseFloat(hours)
  if (!Number.isFinite(value)) throw new Error(`hours: unparseable hours value ${JSON.stringify(hours)}`)
  return Math.round(value * 60)
}
