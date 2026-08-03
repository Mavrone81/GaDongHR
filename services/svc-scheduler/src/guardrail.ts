import { ConfigClient } from './config-client'
import { minutesToHoursString } from './hours'

/**
 * Working-time guardrails (M2-4, Statutory Spec §4). Every ceiling here is
 * fetched from `svc-config` at call time through `ConfigClient` — nothing
 * in this file is a statutory number (brief CONSTRAINTS). The rule keys
 * this policy reads:
 *
 *   hours.regular.max_per_day   -> plain number (default 8)
 *   hours.regular.max_per_week  -> { standard, hazardous } (default 48/42)
 *   hours.ot.max_per_week       -> plain number (default 36)
 *
 * `hours.regular.max_per_week`'s compound shape mirrors `svc-config`'s own
 * documented limitation (`rules.service.ts`'s `assertWithinFloorAndCeiling`
 * comment): a handful of rules carry a structured jsonb value the floor/
 * ceiling machinery does not reduce to one number, and the hazardous/
 * standard split is exactly that case.
 */

export type ConflictSeverity = 'warn' | 'block'

export interface Conflict {
  code: string
  severity: ConflictSeverity
  messageI18nKey: string
  details: Record<string, unknown>
}

export interface ConflictReport {
  items: Conflict[]
}

export function hasBlocking(report: ConflictReport): boolean {
  return report.items.some((c) => c.severity === 'block')
}

export interface RunningTotal {
  hours: string
  ceilingHours: string
  citation: string
}

/**
 * How close to a ceiling (in whole hours) a projected total must be before
 * it is surfaced as a WARN conflict rather than silently allowed — this is
 * a UX threshold, not a legal figure, so (unlike every ceiling above) it is
 * fine as an in-code constant. 1h of headroom is enough for a manager to
 * see "46.0 of 48" and still choose not to add the next shift (brief:
 * "surface ... while there is still room to act, not as an error after the
 * fact").
 */
const WARN_BUFFER_HOURS = 1

function toMinutes(hours: number): number {
  return Math.round(hours * 60)
}

/**
 * Evaluates a projected weekly total (regular hours, or OT hours) against a
 * ceiling fetched from config. Returns `{ conflict, total }` — `conflict`
 * is `null` when the projected total is comfortably under the ceiling,
 * `warn` when within `WARN_BUFFER_HOURS` of it (still allowed — this is the
 * "46.0 of 48" running-total case), and `block` once the projected total
 * exceeds it (LPA s.23/s.26 ceilings — never silently allowed through).
 */
export function evaluateWeeklyTotal(
  code: string,
  messageI18nKeyPrefix: string,
  projectedMinutes: number,
  ceilingHours: number,
  citation: string,
): { conflict: Conflict | null; total: RunningTotal } {
  const ceilingMinutes = toMinutes(ceilingHours)
  const total: RunningTotal = {
    hours: minutesToHoursString(projectedMinutes),
    ceilingHours: minutesToHoursString(ceilingMinutes),
    citation,
  }

  if (projectedMinutes > ceilingMinutes) {
    return {
      total,
      conflict: {
        code,
        severity: 'block',
        messageI18nKey: `${messageI18nKeyPrefix}.exceeded`,
        details: { ...total },
      },
    }
  }

  if (projectedMinutes >= ceilingMinutes - toMinutes(WARN_BUFFER_HOURS)) {
    return {
      total,
      conflict: {
        code,
        severity: 'warn',
        messageI18nKey: `${messageI18nKeyPrefix}.approaching`,
        details: { ...total },
      },
    }
  }

  return { total, conflict: null }
}

/** Daily ceiling (LPA s.23): block-only — a single day either fits within the statutory 8h or it does not; there is no "approaching" state worth surfacing for one day the way there is for a running weekly total. */
export function evaluateDailyTotal(
  dayMinutes: number,
  ceilingHours: number,
  citation: string,
): { conflict: Conflict | null; total: RunningTotal } {
  const ceilingMinutes = toMinutes(ceilingHours)
  const total: RunningTotal = {
    hours: minutesToHoursString(dayMinutes),
    ceilingHours: minutesToHoursString(ceilingMinutes),
    citation,
  }
  if (dayMinutes > ceilingMinutes) {
    return {
      total,
      conflict: {
        code: 'SCH-010',
        severity: 'block',
        messageI18nKey: 'scheduler.error.daily_hours_ceiling_exceeded',
        details: { ...total },
      },
    }
  }
  return { total, conflict: null }
}

export interface GuardrailCeilings {
  dailyHours: number
  dailyCitation: string
  weeklyHours: number
  weeklyCitation: string
  weeklyOtHours: number
  weeklyOtCitation: string
}

/** Fetches every ceiling this policy needs from `svc-config` in one call — the one place `hours.regular.max_per_week`'s compound `{standard, hazardous}` shape is unpacked. */
export class GuardrailPolicy {
  constructor(private readonly configClient: ConfigClient) {}

  async loadCeilings(hazardous: boolean): Promise<GuardrailCeilings> {
    const [daily, weekly, weeklyOt] = await Promise.all([
      this.configClient.getRule('hours.regular.max_per_day'),
      this.configClient.getRule('hours.regular.max_per_week'),
      this.configClient.getRule('hours.ot.max_per_week'),
    ])

    const weeklyValue = weekly.value
    const weeklyHours = hazardous
      ? this.pickCompound(weeklyValue, 'hazardous', weekly.ruleKey)
      : this.pickCompound(weeklyValue, 'standard', weekly.ruleKey)

    if (typeof daily.value !== 'number') {
      throw new Error(`GuardrailPolicy: hours.regular.max_per_day is not numeric: ${JSON.stringify(daily.value)}`)
    }
    if (typeof weeklyOt.value !== 'number') {
      throw new Error(`GuardrailPolicy: hours.ot.max_per_week is not numeric: ${JSON.stringify(weeklyOt.value)}`)
    }

    return {
      dailyHours: daily.value,
      dailyCitation: daily.citation,
      weeklyHours,
      weeklyCitation: weekly.citation,
      weeklyOtHours: weeklyOt.value,
      weeklyOtCitation: weeklyOt.citation,
    }
  }

  private pickCompound(value: unknown, key: 'standard' | 'hazardous', ruleKey: string): number {
    if (typeof value === 'object' && value !== null && key in value) {
      const v = (value as Record<string, unknown>)[key]
      if (typeof v === 'number') return v
    }
    throw new Error(`GuardrailPolicy: ${ruleKey} does not carry a numeric "${key}" field: ${JSON.stringify(value)}`)
  }
}
