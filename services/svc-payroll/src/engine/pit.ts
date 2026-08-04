import { clampNonNegative, divideRoundHalfUp, minSatang, mulDivRoundHalfUp } from '../money'
import type { Rate, Satang } from '../money'
import type { TaxBracket } from '../statutory'

/**
 * Thai personal income tax withholding — the Revenue Department's
 * ANNUALISED method (Statutory Spec §9): project the year's income from
 * what has been paid so far plus what is about to be paid, deduct the
 * standard expense and the employee's declared allowances, run the
 * progressive brackets, then divide the resulting annual tax across the
 * periods that remain.
 *
 * No bracket, rate, allowance or cap appears in this file. Every one of
 * them arrives as an argument, resolved from `svc-config` as of the period
 * end date. Changing the personal allowance in config and re-running is a
 * test in `pit.test.ts`, and the computed tax moves.
 */

/**
 * Progressive tax on a NET annual income, computed marginally: each
 * bracket taxes only the slice of income that falls inside it.
 *
 * The bracket edges matter more than they look. The statutory table is
 * written "0 – 150,000: 0%" then "150,001 – 300,000: 5%", so income of
 * exactly 150,000 pays nothing and income of 150,001 pays 5% of ONE baht,
 * not 5% of 150,001. Marginal accumulation gives exactly that behaviour
 * without any special-casing of the boundary, and `pit.test.ts` asserts
 * every edge in the shipped table, on both sides.
 */
export function progressiveTax(netAnnualIncome: Satang, brackets: readonly TaxBracket[]): Satang {
  const income = clampNonNegative(netAnnualIncome)
  let tax = 0n
  let lowerEdge = 0n

  for (const bracket of brackets) {
    if (income <= lowerEdge) break
    const upper = bracket.upTo === null ? income : minSatang(income, bracket.upTo)
    const slice = upper - lowerEdge
    if (slice > 0n) tax += applyBracketRate(slice, bracket.rate)
    if (bracket.upTo === null) break
    lowerEdge = bracket.upTo
  }

  return tax
}

function applyBracketRate(slice: Satang, rate: Rate): Satang {
  return mulDivRoundHalfUp(slice, rate.num, rate.den)
}

export interface AnnualisedWithholdingInput {
  /** Taxable earnings paid in this period that repeat in the periods that follow. */
  recurringTaxableThisPeriod: Satang
  /** Bonuses and other one-off taxable payments — added to the projection ONCE. */
  oneOffTaxableThisPeriod: Satang
  /** Taxable income already paid this tax year, before this period. */
  ytdTaxableIncome: Satang
  /** SSO/PF employee contributions already made this year, and this period's — both are deductible. */
  ytdSsoEmployee: Satang
  ssoEmployeeThisPeriod: Satang
  ytdPfEmployee: Satang
  pfEmployeeThisPeriod: Satang
  /** Withholding already remitted this year. */
  ytdWhtPaid: Satang
  /** Periods remaining in the tax year INCLUDING this one — never zero. */
  remainingPeriods: bigint

  // --- everything below is resolved from svc-config, never a literal ---
  expenseRate: Rate
  expenseCap: Satang
  personalAllowance: Satang
  spouseAllowance: Satang
  childAllowance: Satang
  childSecondAllowance: Satang
  parentalCareAllowance: Satang
  brackets: readonly TaxBracket[]

  // --- the employee's declaration (counts, not amounts) ---
  spouse: boolean
  children: number
  childrenSecondFrom2018: number
  parentsCaredFor: number
  declaredOtherAllowances: Satang
}

export interface AnnualisedWithholdingResult {
  /** Withholding for THIS period. */
  wht: Satang
  projectedAnnualIncome: Satang
  expenseDeduction: Satang
  totalAllowances: Satang
  netAnnualIncome: Satang
  annualTax: Satang
}

/**
 * The standard RD method, in the order the Revenue Code applies it.
 *
 * `remainingPeriods` includes the current period, so in January of a
 * 12-period year it is 12 and in December it is 1. Dividing the remaining
 * annual liability (annual tax less what has already been withheld) by that
 * count is what makes the method self-correcting: a mid-year pay rise
 * spreads its extra tax across the periods that are left rather than
 * landing entirely in December.
 */
export function annualisedWithholding(input: AnnualisedWithholdingInput): AnnualisedWithholdingResult {
  if (input.remainingPeriods <= 0n) {
    throw new Error('annualisedWithholding: remainingPeriods must be at least 1 — a period outside the tax year cannot be annualised')
  }

  const projectedAnnualIncome =
    input.ytdTaxableIncome + input.recurringTaxableThisPeriod * input.remainingPeriods + input.oneOffTaxableThisPeriod

  // Expense deduction: a percentage of income, capped. Both figures from config.
  const uncappedExpense = mulDivRoundHalfUp(projectedAnnualIncome, input.expenseRate.num, input.expenseRate.den)
  const expenseDeduction = minSatang(clampNonNegative(uncappedExpense), input.expenseCap)

  const spouse = input.spouse ? input.spouseAllowance : 0n
  const children = input.childAllowance * BigInt(input.children)
  const childrenSecond = input.childSecondAllowance * BigInt(input.childrenSecondFrom2018)
  const parents = input.parentalCareAllowance * BigInt(input.parentsCaredFor)

  // SSO and provident-fund contributions are deductible; both are
  // annualised the same way income is.
  const annualSso = input.ytdSsoEmployee + input.ssoEmployeeThisPeriod * input.remainingPeriods
  const annualPf = input.ytdPfEmployee + input.pfEmployeeThisPeriod * input.remainingPeriods

  const totalAllowances =
    input.personalAllowance + spouse + children + childrenSecond + parents + annualSso + annualPf + input.declaredOtherAllowances

  const netAnnualIncome = clampNonNegative(projectedAnnualIncome - expenseDeduction - totalAllowances)
  const annualTax = progressiveTax(netAnnualIncome, input.brackets)

  // Only the liability not yet withheld is spread over the periods that
  // remain. Floored at zero: an over-withheld employee is refunded through
  // their annual PND 91 filing, never through a negative deduction that
  // would silently pay them the Revenue Department's money.
  const outstanding = clampNonNegative(annualTax - input.ytdWhtPaid)
  const wht = divideRoundHalfUp(outstanding, input.remainingPeriods)

  return { wht, projectedAnnualIncome, expenseDeduction, totalAllowances, netAnnualIncome, annualTax }
}
