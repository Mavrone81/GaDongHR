import { bahtToSatang, satangToBaht } from '../money'
import { StatutoryResolver } from '../statutory'
import type { SeveranceTier } from '../statutory'
import { seededConfig } from '../testing/statutory-fixture'
import { dailyWage, payInLieuOfNotice, serviceLength, severanceAmount, severanceDays } from './severance'

/**
 * LPA s.118 severance — ALL SIX TIERS, AT THEIR EXACT BOUNDARIES, on both
 * sides. The boundaries are where this gets expensive: 119 days versus 121
 * is 0 days of severance versus 30, and one day either side of the third
 * anniversary is 90 days versus 180 — for a 45,000 THB employee, a 135,000
 * THB difference decided by a date comparison.
 *
 * The tier table comes from the fixture rule pack through the real
 * resolver. No tier is written into this file.
 */

async function tiers(): Promise<SeveranceTier[]> {
  return new StatutoryResolver(seededConfig(), '2026-06-30').severanceTiers()
}

const START = '2020-01-01'

describe('serviceLength', () => {
  it('counts BOTH the first and the last day — 1 Jan to 30 Apr 2020 is 120 days, not 119', () => {
    expect(serviceLength(START, '2020-04-30').totalDays).toBe(121)
    expect(serviceLength(START, '2020-04-29').totalDays).toBe(120)
  })

  it('counts completed anniversaries, not days ÷ 365 — so a leap year cannot move an employee between tiers', () => {
    expect(serviceLength(START, '2022-12-31').completedYears).toBe(2)
    expect(serviceLength(START, '2023-01-01').completedYears).toBe(3)
    expect(serviceLength(START, '2023-01-02').completedYears).toBe(3)
  })

  it('a single day of employment is one day, not zero', () => {
    expect(serviceLength(START, START)).toEqual({ totalDays: 1, completedYears: 0 })
  })

  it('refuses a termination date before the start date rather than producing a negative tenure', () => {
    expect(() => serviceLength('2020-01-01', '2019-12-31')).toThrow(/precedes start date/)
  })

  it('refuses an unparseable date', () => {
    expect(() => serviceLength('not-a-date', '2020-01-01')).toThrow(/valid ISO date/)
  })
})

describe('severanceDays — all six s.118 tiers at their exact boundaries', () => {
  /** [label, termination date, expected days] — every boundary from the Statutory Spec §7 table. */
  const boundaries: Array<[string, string, number]> = [
    ['119 days of service — below the 120-day threshold, no severance', '2020-04-28', 0],
    ['exactly 120 days — the threshold is inclusive', '2020-04-29', 30],
    ['121 days — 30 days of severance', '2020-04-30', 30],
    ['just under one year', '2020-12-31', 30],
    ['exactly one year — 90 days', '2021-01-01', 90],
    ['2.9 years — still the 1-to-3 tier', '2022-11-01', 90],
    ['the day before the third anniversary', '2022-12-31', 90],
    ['exactly three years — 180 days', '2023-01-01', 180],
    ['3.1 years', '2023-02-01', 180],
    ['the day before the sixth anniversary', '2025-12-31', 180],
    ['exactly six years — 240 days', '2026-01-01', 240],
    ['the day before the tenth anniversary', '2029-12-31', 240],
    ['exactly ten years — 300 days', '2030-01-01', 300],
    ['the day before the twentieth anniversary', '2039-12-31', 300],
    ['exactly twenty years — 400 days', '2040-01-01', 400],
    ['well beyond twenty years — still 400, the table has no higher tier', '2050-06-30', 400],
  ]

  it.each(boundaries)('%s (%s) -> %i days', async (_label, endDate, expected) => {
    expect(severanceDays(await tiers(), serviceLength(START, endDate)).days).toBe(expected)
  })

  it('carries the citation of the tier that applied, so a payslip can say which law produced the figure', async () => {
    const outcome = severanceDays(await tiers(), serviceLength(START, '2023-01-01'))
    expect(outcome.tier?.citation).toBe('LPA s.118')
  })

  it('below the lowest tier there is no tier at all — a legitimate answer, not a gap', async () => {
    expect(severanceDays(await tiers(), serviceLength(START, '2020-04-28')).tier).toBeNull()
  })

  it('THE TIERS ARE DATA: adding a richer tier in config changes the entitlement with no code change', async () => {
    const config = seededConfig()
    config.amend('severance.tiers', '2026-06-30', [
      { minServiceDays: 120, days: 30 },
      { minServiceYears: 1, days: 90 },
      { minServiceYears: 3, days: 240 },
    ])
    const amended = await new StatutoryResolver(config, '2026-06-30').severanceTiers()
    expect(severanceDays(amended, serviceLength(START, '2023-01-01')).days).toBe(240)
  })

  it('a tier stating neither a day nor a year minimum is refused — it would apply to everyone', async () => {
    const config = seededConfig()
    config.amend('severance.tiers', '2026-06-30', [{ days: 400 }])
    await expect(new StatutoryResolver(config, '2026-06-30').severanceTiers()).rejects.toMatchObject({ code: 'PAY-504' })
  })

  it('a tier with a non-integer or negative day count is refused', async () => {
    const config = seededConfig()
    config.amend('severance.tiers', '2026-06-30', [{ minServiceYears: 1, days: -30 }])
    await expect(new StatutoryResolver(config, '2026-06-30').severanceTiers()).rejects.toMatchObject({ code: 'PAY-504' })
  })

  it('a non-array tier table is refused', async () => {
    const config = seededConfig()
    config.amend('severance.tiers', '2026-06-30', 'thirty days')
    await expect(new StatutoryResolver(config, '2026-06-30').severanceTiers()).rejects.toMatchObject({ code: 'PAY-504' })
  })
})

describe('dailyWage — a "day of last wage" per pay basis', () => {
  it('monthly: divided by the configured divisor', () => {
    expect(satangToBaht(dailyWage('monthly', bahtToSatang('45000'), 30n, 8n))).toBe('1500.00')
  })

  it('daily: the wage itself', () => {
    expect(dailyWage('daily', bahtToSatang('600'), 30n, 8n)).toBe(bahtToSatang('600'))
  })

  it('hourly: a statutory working day at that rate', () => {
    expect(satangToBaht(dailyWage('hourly', bahtToSatang('75'), 30n, 8n))).toBe('600.00')
  })
})

describe('severanceAmount and pay in lieu of notice', () => {
  it('180 days of last wage for a 45,000/month employee is 270,000 THB', () => {
    expect(satangToBaht(severanceAmount(dailyWage('monthly', bahtToSatang('45000'), 30n, 8n), 180))).toBe('270000.00')
  })

  it('the 119-versus-121-day boundary is worth 45,000 THB to this employee', () => {
    const perDay = dailyWage('monthly', bahtToSatang('45000'), 30n, 8n)
    expect(satangToBaht(severanceAmount(perDay, 30))).toBe('45000.00')
    expect(severanceAmount(perDay, 0)).toBe(0n)
  })

  it('refuses a fractional or negative day count', () => {
    expect(() => severanceAmount(1n, -1)).toThrow(/whole non-negative/)
    expect(() => severanceAmount(1n, 1.5)).toThrow(/whole non-negative/)
  })

  it('pay in lieu is owed only when notice was NOT given (LPA s.17)', () => {
    const wage = bahtToSatang('45000')
    expect(payInLieuOfNotice(wage, 1n, false)).toBe(wage)
    expect(payInLieuOfNotice(wage, 1n, true)).toBe(0n)
  })

  it('a longer contractual notice period multiplies the amount — the period is config, not a constant', () => {
    expect(satangToBaht(payInLieuOfNotice(bahtToSatang('45000'), 2n, false))).toBe('90000.00')
  })
})
