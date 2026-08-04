import { mulDivRoundHalfUp } from '../money'
import type { Satang } from '../money'
import type { SeveranceTier } from '../statutory'
import type { PayBasis } from './types'

/**
 * Severance under LPA s.118 (Statutory Spec §7). The TIER TABLE ITSELF is
 * configuration — 30/90/180/240/300/400 days by service length appears
 * nowhere in this file, only in the rule pack and in test fixtures. A
 * future amendment to s.118 is a rule-pack import.
 *
 * What this file does own is how service length is MEASURED, which the
 * statute states in two different units at once ("≥120 days and <1 year",
 * then "≥1 and <3 years"), so the engine computes both and a tier may
 * state either or both.
 */

const MS_PER_DAY = 86_400_000

function parseIsoDate(iso: string): Date {
  const d = new Date(`${iso}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) throw new Error(`severance: not a valid ISO date: ${JSON.stringify(iso)}`)
  return d
}

export interface ServiceLength {
  /** Calendar days of employment, counting BOTH the first and the last day — a person who starts on 1 January and leaves on 30 April has served 120 days, not 119. */
  totalDays: number
  /** Completed anniversaries. On the third anniversary of the start date this is 3; the day before, it is 2. */
  completedYears: number
}

export function serviceLength(startDate: string, endDate: string): ServiceLength {
  const start = parseIsoDate(startDate)
  const end = parseIsoDate(endDate)
  if (end.getTime() < start.getTime()) {
    throw new Error(`severance: termination date ${endDate} precedes start date ${startDate}`)
  }

  const totalDays = Math.round((end.getTime() - start.getTime()) / MS_PER_DAY) + 1

  // Anniversary arithmetic, not days ÷ 365: leap years would otherwise make
  // the tier an employee falls into depend on which years they happened to
  // work through.
  let completedYears = 0
  for (;;) {
    const anniversary = new Date(start.getTime())
    anniversary.setUTCFullYear(start.getUTCFullYear() + completedYears + 1)
    if (anniversary.getTime() > end.getTime()) break
    completedYears += 1
  }

  return { totalDays, completedYears }
}

export interface SeveranceEntitlement {
  days: number
  tier: SeveranceTier | null
}

/**
 * The highest tier whose stated minimums the employee meets. A tier may
 * state a day minimum, a year minimum, or both; all stated minimums must be
 * met. Below the lowest tier the entitlement is zero days — which is a
 * legitimate answer under s.118, not a gap.
 */
export function severanceDays(tiers: readonly SeveranceTier[], service: ServiceLength): SeveranceEntitlement {
  let best: SeveranceTier | null = null
  for (const tier of tiers) {
    if (tier.minServiceDays !== null && service.totalDays < tier.minServiceDays) continue
    if (tier.minServiceYears !== null && service.completedYears < tier.minServiceYears) continue
    if (best === null || tier.days > best.days) best = tier
  }
  return { days: best === null ? 0 : best.days, tier: best }
}

/**
 * A "day of last wage" for each pay basis. For a monthly employee the
 * divisor comes from `severance.daily_wage_divisor` in config — a separate
 * key from the overtime divisor, because a company that lawfully raises its
 * OT divisor must not thereby lower a statutory severance entitlement.
 */
export function dailyWage(basis: PayBasis, basePay: Satang, monthlyDivisor: bigint, hoursPerDay: bigint): Satang {
  if (basis === 'monthly') return mulDivRoundHalfUp(basePay, 1n, monthlyDivisor)
  if (basis === 'daily') return basePay
  return basePay * hoursPerDay
}

export function severanceAmount(perDayWage: Satang, days: number): Satang {
  if (days < 0 || !Number.isInteger(days)) throw new Error(`severance: days must be a whole non-negative count, got ${days.toString()}`)
  return perDayWage * BigInt(days)
}

/**
 * Pay in lieu of notice (LPA s.17): the wage the employee would have earned
 * over the notice period the employer did not give. `periods` and the
 * period wage both arrive resolved — nothing here decides how long notice
 * must be.
 */
export function payInLieuOfNotice(periodWage: Satang, periods: bigint, noticeGiven: boolean): Satang {
  if (noticeGiven) return 0n
  return periodWage * periods
}
