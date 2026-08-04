// The ONLY cross-service import in this codebase, and it is deliberate.
// See this file's header comment for why the two modules must be in scope
// together for these assertions to mean anything.
import { classifyOtHours } from '../../../svc-timesheet/src/ot-classifier'
import type { EmploymentType } from '../../../svc-timesheet/src/ot-classifier'
import { bahtToSatang, satangToBaht } from '../money'
import { StatutoryResolver } from '../statutory'
import { FakeConfigClient } from '../testing/fake-config-client'
import { PROVINCE_BANGKOK, seededConfig } from '../testing/statutory-fixture'
import { computeGrossToNet } from './gross-to-net'
import { resolveEngineRules } from './rules'
import type { EngineRules } from './rules'
import { ZERO_TIMESHEET, ZERO_YTD } from './types'
import type { GrossToNetInput, PayBasis } from './types'

/**
 * **THE `ot_2x` CROSS-MODULE CONTRACT.** M3 (`svc-timesheet`) and M7
 * (`svc-payroll`) were built in parallel. They agree about what the number
 * in `timesheet.day_record.ot_2x` MEANS — and until this file existed, they
 * agreed by coincidence of reading rather than by contract.
 *
 * The contract, stated once, in full:
 *
 *   `ot_2x` is a PAY-RATE EQUIVALENT, not hours worked. It is the number of
 *   minutes payable at exactly 2x the hourly base, with LPA s.62's
 *   entitlement discount already baked into the QUANTITY.
 *
 *   A monthly employee is already paid their normal day's wage for a public
 *   holiday whether or not they work it, so the law owes only a further +1x
 *   for hours actually worked. M3 therefore stores HALF the worked minutes,
 *   so that `half x 2x = 1x`. A daily/hourly/contract employee receives
 *   nothing for an unworked holiday, so the law owes the full 2x, and M3
 *   stores the FULL worked minutes.
 *
 *   M7 therefore applies `ot.holiday_work.multiplier` UNIFORMLY at 2x to
 *   whatever quantity arrives, and MUST NOT re-derive the distinction from
 *   the employee's pay basis.
 *
 * Each module already documents its own half (`ot-classifier.ts`'s header;
 * `engine/types.ts`'s `otHolidayWorkHours`) and each already tests its own
 * half — including `gross-to-net.test.ts`'s "THE TRAP", which pins that
 * halving a second time here would pay 750.00 where the law owes 1,500.00.
 *
 * **What neither module could have.** Every one of those tests takes the
 * other side's behaviour as a hand-written literal. M7's fixtures say
 * `MONTHLY_OT_2X = '4'` and `DAILY_OT_2X = '8'`; M3's say
 * `expect(result.ot2x).toBe('4.00')`. The `4` in M7's fixture and the
 * `regularMinutes / 2` in M3's classifier were connected by comments and by
 * nothing else — no assertion anywhere executed both. So if a future rule
 * pack moved the discount into the MULTIPLIER (which is how the Statutory
 * Spec §4 used to express it) and M3's halving were removed to match,
 * **every test in both services would still pass** while production paid
 * every monthly employee half their statutory holiday premium. Two modules,
 * each internally consistent, silently disagreeing about what a number
 * means. That is the same shape as the audit-emitter defect (roadmap,
 * "Audit payloads must carry hashes, not values") and the unreachable-
 * permission defect before it.
 *
 * This file closes it by removing the literal from the seam: it builds the
 * `timesheet.locked` totals by CALLING M3's real `classifyOtHours`, feeds
 * them through M7's real `computeGrossToNet`, and asserts the resulting
 * BAHT. Change the halving on the M3 side, or the uniform multiplier on the
 * M7 side, and this fails — because it is the only test that runs both.
 *
 * It lives in `svc-payroll` (the consumer, which is where the mistake would
 * be paid out) and imports `svc-timesheet` by relative path. That is the
 * only mechanism available today: there is no shared event-payload package,
 * `jest.config.js` runs one flat project over all four roots, and each
 * service's `tsconfig.json` excludes `src/**\/*.test.ts` from the composite
 * build — so this import is type-checked by ts-jest at test time without
 * entangling the two services' `tsc -b` project-reference graphs.
 */

const SEPTEMBER_2026 = '2026-09-30'

/** An 8-hour shift on a public holiday, no OT beyond the regular ceiling — M3's TC-M3-007. */
const EIGHT_HOUR_HOLIDAY_SHIFT = {
  workedMinutes: 480,
  regularThresholdMinutes: 480,
  isHoliday: true,
  approvedOtMinutes: 0,
} as const

async function rulesAsOf(on: string, config: FakeConfigClient = seededConfig()): Promise<EngineRules> {
  return resolveEngineRules(new StatutoryResolver(config, on), PROVINCE_BANGKOK)
}

/**
 * The seam itself, executed rather than assumed: run M3's classifier, take
 * the `ot_2x` string it would write to `timesheet.day_record`, and hand it
 * to M7's engine exactly as `HttpTimesheetClient.getLockedTotals` does after
 * a `timesheet.locked` event binds a lock version.
 */
function payForHolidayShift(
  employmentType: EmploymentType,
  basis: PayBasis,
  basePayThb: string,
  rules: EngineRules,
): { ot2xFromM3: string; holidayPayThb: string } {
  const classified = classifyOtHours({ ...EIGHT_HOUR_HOLIDAY_SHIFT, employmentType })

  const input: GrossToNetInput = {
    employee: { id: 'emp-1', provinceCode: PROVINCE_BANGKOK },
    period: { code: '2026-09', start: '2026-09-01', end: '2026-09-30', payDate: '2026-09-30', indexInYear: 9 },
    profile: { basis, basePay: bahtToSatang(basePayThb), pfRatePercent: null, pfRateEmployerPercent: null, declaration: null },
    // `ot2x` crosses the module boundary here — M3's output, unmodified,
    // as M7's input. No literal, no rescaling, no re-derivation.
    timesheet: { ...ZERO_TIMESHEET, daysWorked: '20', hoursWorked: '160', otHolidayWorkHours: classified.ot2x },
    lines: [],
    ytd: ZERO_YTD,
  }

  const result = computeGrossToNet(input, rules)
  return {
    ot2xFromM3: classified.ot2x,
    holidayPayThb: satangToBaht(result.lines.find((l) => l.code === 'ot_holiday_work')?.amount ?? 0n),
  }
}

describe('CROSS-MODULE: M3 produces ot_2x, M7 pays it (the timesheet.locked contract)', () => {
  it('MONTHLY: M3 halves the quantity, M7 doubles it, the employee is paid the +1x LPA s.62 owes', async () => {
    const rules = await rulesAsOf(SEPTEMBER_2026)
    const { ot2xFromM3, holidayPayThb } = payForHolidayShift('monthly', 'monthly', '45000', rules)

    // M3's half of the contract, as M3 actually computes it.
    expect(ot2xFromM3).toBe('4.00')
    // M7's half: hourly base 45,000/30/8 = 187.50; 187.50 x 2 x 4 = 1,500.00.
    expect(holidayPayThb).toBe('1500.00')
    // And the statute's own statement of the same figure, derived here from
    // neither engine: +1x the hourly base for the 8 hours REALLY worked.
    // `ot_2x` being 4.00 while the employee worked 8h is the whole point —
    // it is a pay-rate equivalent, and `day_record.worked_hours` still
    // carries the true unscaled 8.
    expect(bahtToSatang(holidayPayThb)).toBe(bahtToSatang('187.50') * 8n)
  })

  it('DAILY-RATE: M3 passes the full quantity, M7 doubles it, the employee is paid the full 2x', async () => {
    const rules = await rulesAsOf(SEPTEMBER_2026)
    const { ot2xFromM3, holidayPayThb } = payForHolidayShift('daily', 'daily', '600', rules)

    expect(ot2xFromM3).toBe('8.00')
    // Hourly base 600/8 = 75.00; 75.00 x 2 x 8 = 1,200.00 — the full 2x,
    // because a daily-rate employee is paid nothing for an unworked holiday.
    expect(holidayPayThb).toBe('1200.00')
    expect(bahtToSatang(holidayPayThb)).toBe(bahtToSatang('75') * 2n * 8n)
  })

  /**
   * The drift detector, and the reason this file exists rather than a
   * comment. It asserts the RELATIONSHIP between the two employment types
   * end-to-end, at identical hourly rates — so it fails if either side
   * changes unilaterally, without needing to know which side moved.
   */
  it('THE DRIFT DETECTOR: at the same hourly base, monthly pay is exactly HALF daily-rate pay — one discount, applied once', async () => {
    const rules = await rulesAsOf(SEPTEMBER_2026)
    // Both reach an hourly base of 75.00: 18,000/30/8 and 600/8.
    const monthly = payForHolidayShift('monthly', 'monthly', '18000', rules)
    const daily = payForHolidayShift('daily', 'daily', '600', rules)

    expect(monthly.holidayPayThb).toBe('600.00') // 75 x 2 x 4  — the +1x top-up
    expect(daily.holidayPayThb).toBe('1200.00') // 75 x 2 x 8  — the full 2x
    // Exactly one halving happens in the whole pipeline. Two (M3 halving AND
    // M7 re-deriving from `basis`) gives 300.00; zero (the discount moved to
    // the multiplier in a rule pack, M3's halving removed, M7 not updated)
    // gives 1,200.00 for a monthly employee. Both are wrong, in opposite
    // directions, and both would pass every other test in both services.
    expect(bahtToSatang(monthly.holidayPayThb) * 2n).toBe(bahtToSatang(daily.holidayPayThb))
  })

  /**
   * The control. A test that would still pass with the mechanism removed is
   * not evidence of anything, so: re-run the monthly case with the halving
   * defeated (M3's own non-entitled branch, reached by classifying a monthly
   * employee's shift as if they were daily-rate) and confirm the assertion
   * above genuinely fails.
   */
  it('CONTROL: if M3 stopped halving for monthly staff and M7 was not updated in the same change, the monthly employee is paid 2x instead of 1x', async () => {
    const rules = await rulesAsOf(SEPTEMBER_2026)
    // Same monthly employee, same 45,000 salary, same 8-hour holiday shift —
    // but classified WITHOUT the s.62 entitlement discount.
    const withoutHalving = payForHolidayShift('daily', 'monthly', '45000', rules)

    expect(withoutHalving.ot2xFromM3).toBe('8.00')
    expect(withoutHalving.holidayPayThb).toBe('3000.00') // vs the correct 1,500.00
    expect(withoutHalving.holidayPayThb).not.toBe('1500.00')
  })

  /**
   * The asymmetry that makes the contract sharper than it looks. M3's
   * `EmploymentType` has four members and M7's `PayBasis` has three: M3
   * distinguishes `contract`, M7 does not. Only `monthly` is
   * entitlement-bearing on the M3 side, so the three others must all
   * produce the full, unhalved quantity. If a future change made `contract`
   * entitled to paid holidays, M7 would need no change at all — the
   * quantity would simply arrive halved — which is exactly the property
   * that makes putting the discount in the quantity the right choice.
   */
  it('every NON-monthly employment type produces the full quantity — the discount is monthly-only, and M7 never has to know', async () => {
    const rules = await rulesAsOf(SEPTEMBER_2026)
    for (const employmentType of ['daily', 'hourly', 'contract'] as const) {
      const { ot2xFromM3, holidayPayThb } = payForHolidayShift(employmentType, 'daily', '600', rules)
      expect(ot2xFromM3).toBe('8.00')
      expect(holidayPayThb).toBe('1200.00')
    }
  })

  /**
   * The multiplier stays statutory data, not a constant, on the far side of
   * the seam too — a rule pack that changes `ot.holiday_work.multiplier`
   * moves the pay for BOTH employment types, without either module changing.
   */
  it('the 2x remains config: a rule-pack change moves both employment types together, still exactly 2:1', async () => {
    const config = seededConfig()
    config.amend('ot.holiday_work.multiplier', SEPTEMBER_2026, '2.5')
    const rules = await rulesAsOf(SEPTEMBER_2026, config)

    const monthly = payForHolidayShift('monthly', 'monthly', '18000', rules)
    const daily = payForHolidayShift('daily', 'daily', '600', rules)

    expect(monthly.holidayPayThb).toBe('750.00') // 75 x 2.5 x 4
    expect(daily.holidayPayThb).toBe('1500.00') // 75 x 2.5 x 8
    expect(bahtToSatang(monthly.holidayPayThb) * 2n).toBe(bahtToSatang(daily.holidayPayThb))
  })
})
