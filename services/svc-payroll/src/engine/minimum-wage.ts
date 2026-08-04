import { mulDivRoundHalfUp } from '../money'
import type { Satang } from '../money'
import type { PayBasis } from './types'

/**
 * The provincial minimum-wage floor (Statutory Spec §8 / M7-1). The floor
 * itself is one of 77 provincial values in a rule pack, resolved by
 * `minwage.daily.<PROVINCE_CODE>` as of the period end date; it appears
 * nowhere in this file.
 *
 * THE COMPARISON IS EXACT. A monthly employee's daily equivalent is
 * `basePay ÷ divisor`, which is very often not a whole number of satang —
 * 12,000.00 THB ÷ 30 is exact, but 11,999.00 ÷ 26 is not. Comparing a
 * ROUNDED daily equivalent against the floor would let a wage sitting a
 * fraction of a satang below the floor round up and pass. So the test is
 * performed by cross-multiplication (`basePay ≥ floor × divisor`), with the
 * rounded figure computed only for the error message a human reads.
 */

export interface MinimumWageOutcome {
  /** Rounded to the satang — for display in the PAY-010 rejection only, never for the comparison. */
  dailyEquivalent: Satang
  floor: Satang
  ok: boolean
}

export function checkMinimumWage(
  basis: PayBasis,
  basePay: Satang,
  floor: Satang,
  monthlyDivisor: bigint,
  hoursPerDay: bigint,
): MinimumWageOutcome {
  if (basis === 'monthly') {
    return {
      dailyEquivalent: mulDivRoundHalfUp(basePay, 1n, monthlyDivisor),
      floor,
      // basePay/divisor >= floor  <=>  basePay >= floor*divisor. Exact.
      ok: basePay >= floor * monthlyDivisor,
    }
  }
  if (basis === 'daily') {
    return { dailyEquivalent: basePay, floor, ok: basePay >= floor }
  }
  // Hourly: a full statutory working day at this rate must clear the floor.
  const perDay = basePay * hoursPerDay
  return { dailyEquivalent: perDay, floor, ok: perDay >= floor }
}
