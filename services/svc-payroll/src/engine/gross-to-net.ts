import { belowMinimumWage, providentFundRateOutOfBand, statutoryRuleMalformed } from '../errors'
import { RULE_KEYS } from '../statutory'
import {
  applyRate,
  clampToBand,
  mulDivRoundHalfUp,
  parseMultiplier,
  parsePercent,
  satangToBaht,
} from '../money'
import type { Rate, Satang } from '../money'
import { annualisedWithholding } from './pit'
import { checkMinimumWage } from './minimum-wage'
import { EWF_BASE_SSO_CAPPED, EWF_BASE_SSO_UNCAPPED } from './rules'
import type { EngineRules } from './rules'
import { NO_DECLARATION } from './types'
import type { ComputedLine, GrossToNetInput, GrossToNetResult, PayBasis, TaxDeclaration } from './types'

/**
 * THE GROSS-TO-NET ENGINE (M7-2). One employee, one period, in the
 * statutory order the Revenue Code and the Social Security Act require:
 *
 *   gross (base + OT from a LOCKED timesheet + taxable allowances)
 *     → minimum-wage floor check against the employee's province
 *     → SSO employee 5% of the CAPPED wage; employer matches
 *     → EWF 0.25% employee + employer, from 1 Oct 2026, and only where the
 *       employer has no registered provident fund
 *     → provident fund 2–15% voluntary
 *     → withholding tax by the annualised PIT method with declared allowances
 *     → net
 *
 * NOT ONE OF THOSE FIGURES IS IN THIS FILE. Every rate, ceiling, floor,
 * bracket, multiplier and divisor arrives in `rules`, resolved from
 * `svc-config` as of the period end date. The percentages written in the
 * paragraph above are documentation of the 2026 defaults, not values this
 * code knows. The proof is `gross-to-net.test.ts`: a September 2026 run
 * applies no EWF and an October 2026 run applies 0.25%, with the only
 * difference between the two being the effective-dated config, and every
 * rate test changes a config value and asserts the computed net moves.
 *
 * PURE, AND DELIBERATELY SO. No I/O, no clock, no randomness — a function
 * of `(input, rules)` only. That is what makes 100% branch coverage on this
 * file both achievable and worth having: every branch is reachable by
 * choosing arguments, so the coverage number measures the statute, not the
 * mocking.
 *
 * MONEY IS `bigint` SATANG THROUGHOUT. There is no `number` in any
 * arithmetic path here; quantities that arrive as decimal strings (hours,
 * days, percentages) become EXACT rationals and are multiplied through in
 * one step so rounding happens once, at the end, half-up. See `money.ts`.
 */

/** An hourly wage held as an exact rational rather than a rounded satang figure — see `hourlyBase`. */
interface RationalWage {
  num: bigint
  den: bigint
}

/**
 * The hourly base for overtime, kept UNROUNDED.
 *
 * `ot.hourly_base.formula` is "monthly ÷ 30 ÷ 8" (Statutory Spec §4). For a
 * 15,000 THB monthly wage that is 62.5 THB/hour exactly, but for 20,000 it
 * is 83.333... — and rounding there before multiplying by a 1.5× multiplier
 * and a fractional hour count would move the OT figure by more than the
 * rounding it removed. Holding the base as `num/den` and rounding once, at
 * the end of the whole product, is the difference between a payslip that
 * reconciles and one that is a satang out every month.
 */
function hourlyBase(basis: PayBasis, basePay: Satang, daysDivisor: bigint, hoursDivisor: bigint): RationalWage {
  if (basis === 'monthly') return { num: basePay, den: daysDivisor * hoursDivisor }
  if (basis === 'daily') return { num: basePay, den: hoursDivisor }
  return { num: basePay, den: 1n }
}

/** `hourlyBase × multiplier × hours`, with exactly one rounding at the end. */
function overtimePay(base: RationalWage, multiplier: Rate, hours: string): Satang {
  const h = parseMultiplier(hours)
  return mulDivRoundHalfUp(base.num, multiplier.num * h.num, base.den * multiplier.den * h.den)
}

/** Contractual earnings for the period, by pay basis (M7-1). */
function basePayEarned(basis: PayBasis, basePay: Satang, daysWorked: string, hoursWorked: string): Satang {
  if (basis === 'monthly') {
    // A monthly employee earns the monthly wage; absence is expressed as an
    // explicit unpaid-leave DEDUCTION line, never by silently pro-rating
    // here, so that what was withheld and why is always visible on the
    // payslip (LPA s.76 — deductions must be identifiable).
    return basePay
  }
  if (basis === 'daily') {
    const d = parseMultiplier(daysWorked)
    return mulDivRoundHalfUp(basePay, d.num, d.den)
  }
  const h = parseMultiplier(hoursWorked)
  return mulDivRoundHalfUp(basePay, h.num, h.den)
}

/** `true` when `rate` lies within `[min, max]`, compared exactly by cross-multiplication rather than through a decimal approximation. */
function rateWithinBand(rate: Rate, min: Rate, max: Rate): boolean {
  return rate.num * min.den >= min.num * rate.den && rate.num * max.den <= max.num * rate.den
}

export function computeGrossToNet(input: GrossToNetInput, rules: EngineRules): GrossToNetResult {
  const notes: string[] = []
  const citations: Record<string, string> = {}
  const lines: ComputedLine[] = []

  const cite = (ruleKey: string, citation: string): string => {
    citations[ruleKey] = citation
    return citation
  }

  const { basis, basePay } = input.profile

  // -------------------------------------------------------------------
  // 1. Minimum-wage floor, against the EMPLOYEE'S PROVINCE (M7-1).
  //    Checked before anything is computed: a contractual wage below the
  //    provincial floor is not a number to build a payslip on.
  // -------------------------------------------------------------------
  if (rules.minimumWageDaily === null) {
    // A province with no notification on file is a configuration gap, and
    // the run must say so rather than pass silently — an unchecked wage is
    // indistinguishable, on the payslip, from a checked one.
    notes.push(`payroll.note.minimum_wage_not_on_file:${input.employee.provinceCode}`)
  } else {
    const floor = rules.minimumWageDaily
    const outcome = checkMinimumWage(basis, basePay, floor.value, rules.minWageMonthlyDivisor.value, rules.otHourlyBaseHours.value)
    cite(floor.ruleKey, floor.citation)
    if (!outcome.ok) {
      throw belowMinimumWage(
        input.employee.provinceCode,
        satangToBaht(outcome.dailyEquivalent),
        satangToBaht(outcome.floor),
        floor.citation,
      )
    }
  }

  // -------------------------------------------------------------------
  // 2. Earnings.
  // -------------------------------------------------------------------
  const earnedBase = basePayEarned(basis, basePay, input.timesheet.daysWorked, input.timesheet.hoursWorked)
  lines.push({ code: 'base_pay', category: 'earning', amount: earnedBase, citation: null })

  const base = hourlyBase(basis, basePay, rules.otHourlyBaseDays.value, rules.otHourlyBaseHours.value)
  const otWorkday = overtimePay(base, rules.otWorkdayMultiplier.value, input.timesheet.otWorkdayHours)
  const otHolidayWork = overtimePay(base, rules.otHolidayWorkMultiplier.value, input.timesheet.otHolidayWorkHours)
  const otHolidayOt = overtimePay(base, rules.otHolidayOtMultiplier.value, input.timesheet.otHolidayOtHours)
  const overtime = otWorkday + otHolidayWork + otHolidayOt

  if (otWorkday !== 0n) {
    lines.push({ code: 'ot_workday', category: 'earning', amount: otWorkday, citation: cite(RULE_KEYS.otWorkdayMultiplier, rules.otWorkdayMultiplier.citation) })
  }
  if (otHolidayWork !== 0n) {
    lines.push({ code: 'ot_holiday_work', category: 'earning', amount: otHolidayWork, citation: cite(RULE_KEYS.otHolidayWorkMultiplier, rules.otHolidayWorkMultiplier.citation) })
  }
  if (otHolidayOt !== 0n) {
    lines.push({ code: 'ot_holiday_ot', category: 'earning', amount: otHolidayOt, citation: cite(RULE_KEYS.otHolidayOtMultiplier, rules.otHolidayOtMultiplier.citation) })
  }

  // -------------------------------------------------------------------
  // 3. Additional lines: allowances, one-offs, leave payouts and
  //    reimbursements. `taxable`/`ssoWageBase` are read, never re-derived.
  // -------------------------------------------------------------------
  let additionalEarnings = 0n
  let nonTaxablePay = 0n
  let otherDeductions = 0n
  let taxableFromLines = 0n
  let oneOffTaxable = 0n
  let ssoBaseFromLines = 0n

  for (const line of input.lines) {
    if (line.direction === 'deduction') {
      otherDeductions += line.amount
      lines.push({ code: line.code, category: 'employee_deduction', amount: line.amount, citation: null })
      continue
    }

    // An earning outside BOTH the tax base and the SSO wage base is a
    // reimbursement: it is paid, but it is not part of gross. Keeping it
    // out of `gross` (rather than adding it and subtracting it later) is
    // what makes it structurally impossible for สปส.1-10 or PND 1 to pick
    // it up by reading the wrong field.
    if (!line.taxable && !line.ssoWageBase) {
      nonTaxablePay += line.amount
      lines.push({ code: line.code, category: 'non_taxable_payment', amount: line.amount, citation: null })
      continue
    }

    additionalEarnings += line.amount
    if (line.taxable) {
      if (line.oneOff) oneOffTaxable += line.amount
      else taxableFromLines += line.amount
    }
    if (line.ssoWageBase) ssoBaseFromLines += line.amount
    lines.push({ code: line.code, category: 'earning', amount: line.amount, citation: null })
  }

  const gross = earnedBase + overtime + additionalEarnings
  // Base pay and overtime are wages: taxable and in the SSO wage base.
  const recurringTaxable = earnedBase + overtime + taxableFromLines
  const taxableGross = recurringTaxable + oneOffTaxable
  const ssoWage = earnedBase + overtime + ssoBaseFromLines

  // -------------------------------------------------------------------
  // 4. SSO — 5% of the CAPPED wage; the employer matches (Statutory §5).
  //    The band is [floor, ceiling], both from config. The ceiling is the
  //    figure that must bind: an employee on 40,000 contributes on 17,500.
  // -------------------------------------------------------------------
  const ssoCappedWage = clampToBand(ssoWage, rules.ssoWageFloor.value, rules.ssoWageCeiling.value)
  const ssoEmployee = applyRate(ssoCappedWage, rules.ssoRateEmployee.value)
  const ssoEmployer = applyRate(ssoCappedWage, rules.ssoRateEmployer.value)
  cite(RULE_KEYS.ssoWageCeiling, rules.ssoWageCeiling.citation)
  cite(RULE_KEYS.ssoRateEmployee, rules.ssoRateEmployee.citation)
  lines.push({ code: 'sso_employee', category: 'employee_deduction', amount: ssoEmployee, citation: rules.ssoRateEmployee.citation })
  lines.push({ code: 'sso_employer', category: 'employer_contribution', amount: ssoEmployer, citation: cite(RULE_KEYS.ssoRateEmployer, rules.ssoRateEmployer.citation) })

  // -------------------------------------------------------------------
  // 5. EWF — TWO independent gates (Statutory Spec §6).
  //
  //    (a) DATE. `rules.ewfRate*` is `null` when `svc-config` has no
  //        version of the rule in force on the period end date. On
  //        2026-09-30 there is none; on 2026-10-31 there is 0.25. No date
  //        literal appears anywhere in this engine — the comparison lives
  //        in the effective-dated data.
  //    (b) EXEMPTION. An employer operating a registered provident fund is
  //        exempt, IF the exemption rule says a registered PF exempts —
  //        itself config, because §12 V3 flags the exemption scope as
  //        unverified pending Ministry of Labour regulations.
  // -------------------------------------------------------------------
  const exemptByProvidentFund =
    rules.employerProvidentFundRegistered.value && rules.ewfExemptsWithProvidentFund.value

  let ewfEmployee = 0n
  let ewfEmployer = 0n

  if (exemptByProvidentFund) {
    notes.push('payroll.note.ewf_exempt_provident_fund')
    cite(RULE_KEYS.ewfExemptionProvidentFund, rules.ewfExemptsWithProvidentFund.citation)
  } else {
    const ewfBase = ewfWageBaseFor(rules.ewfWageBase, ssoWage, ssoCappedWage)
    if (rules.ewfRateEmployee !== null) {
      ewfEmployee = applyRate(ewfBase, rules.ewfRateEmployee.value)
      lines.push({ code: 'ewf_employee', category: 'employee_deduction', amount: ewfEmployee, citation: cite(RULE_KEYS.ewfRateEmployee, rules.ewfRateEmployee.citation) })
    }
    if (rules.ewfRateEmployer !== null) {
      ewfEmployer = applyRate(ewfBase, rules.ewfRateEmployer.value)
      lines.push({ code: 'ewf_employer', category: 'employer_contribution', amount: ewfEmployer, citation: cite(RULE_KEYS.ewfRateEmployer, rules.ewfRateEmployer.citation) })
    }
    if (rules.ewfRateEmployee === null && rules.ewfRateEmployer === null) {
      notes.push('payroll.note.ewf_not_yet_in_force')
    }
  }

  // -------------------------------------------------------------------
  // 6. Provident fund — voluntary, 2–15% (Provident Fund Act B.E. 2530).
  //    The band comes from config; a rate outside it is refused rather
  //    than clamped, because clamping would quietly pay a different rate
  //    than the employee agreed to.
  // -------------------------------------------------------------------
  const pfEmployee = providentFundContribution(input.profile.pfRatePercent, ssoWage, rules, 'employee')
  const pfEmployer = providentFundContribution(input.profile.pfRateEmployerPercent, ssoWage, rules, 'employer')
  if (pfEmployee !== 0n) lines.push({ code: 'pf_employee', category: 'employee_deduction', amount: pfEmployee, citation: null })
  if (pfEmployer !== 0n) lines.push({ code: 'pf_employer', category: 'employer_contribution', amount: pfEmployer, citation: null })

  // -------------------------------------------------------------------
  // 7. Withholding tax — annualised PIT with declared allowances.
  // -------------------------------------------------------------------
  let declaration: TaxDeclaration
  if (input.profile.declaration === null) {
    // PAY-040: not fatal. The employee is withheld on the personal
    // allowance alone and the payslip carries the note, because refusing
    // to pay someone who has not filed a form is worse than withholding a
    // little too much and reconciling it at year end.
    notes.push('payroll.note.tax_declaration_missing')
    declaration = NO_DECLARATION
  } else {
    declaration = input.profile.declaration
  }

  const remainingPeriods = remainingPeriodsIn(rules.periodsPerYear.value, input.period.indexInYear)
  const tax = annualisedWithholding({
    recurringTaxableThisPeriod: recurringTaxable,
    oneOffTaxableThisPeriod: oneOffTaxable,
    ytdTaxableIncome: input.ytd.taxableIncome,
    ytdSsoEmployee: input.ytd.ssoEmployee,
    ssoEmployeeThisPeriod: ssoEmployee,
    ytdPfEmployee: input.ytd.pfEmployee,
    pfEmployeeThisPeriod: pfEmployee,
    ytdWhtPaid: input.ytd.whtPaid,
    remainingPeriods,
    expenseRate: rules.taxExpenseRate.value,
    expenseCap: rules.taxExpenseCap.value,
    personalAllowance: rules.taxAllowancePersonal.value,
    spouseAllowance: rules.taxAllowanceSpouse.value,
    childAllowance: rules.taxAllowanceChild.value,
    childSecondAllowance: rules.taxAllowanceChildSecond.value,
    parentalCareAllowance: rules.taxAllowanceParentalCare.value,
    brackets: rules.pitBrackets,
    spouse: declaration.spouse,
    children: declaration.children,
    childrenSecondFrom2018: declaration.childrenSecondFrom2018,
    parentsCaredFor: declaration.parentsCaredFor,
    declaredOtherAllowances: declaration.otherAllowances,
  })
  // The bracket table always carries the citation of the rule it came from;
  // the fallback only matters for the degenerate empty table, which the
  // resolver refuses but which a direct caller of this pure function can
  // still construct.
  const bracketCitation = cite(RULE_KEYS.taxPitBrackets, rules.pitBrackets[0]?.citation ?? rules.taxAllowancePersonal.citation)
  if (tax.wht !== 0n) lines.push({ code: 'withholding_tax', category: 'employee_deduction', amount: tax.wht, citation: bracketCitation })

  // -------------------------------------------------------------------
  // 8. Net. Reimbursements are ADDED here, having never been part of
  //    gross — the last step of M7-2's flowchart.
  // -------------------------------------------------------------------
  const net = gross - ssoEmployee - ewfEmployee - pfEmployee - tax.wht - otherDeductions + nonTaxablePay

  return {
    gross,
    taxableGross,
    nonTaxablePay,
    basePayEarned: earnedBase,
    overtimePay: overtime,
    ssoWage,
    ssoCappedWage,
    ssoEmployee,
    ssoEmployer,
    ewfEmployee,
    ewfEmployer,
    pfEmployee,
    pfEmployer,
    wht: tax.wht,
    otherDeductions,
    net,
    lines,
    notes,
    citations,
  }
}

/**
 * Which wage EWF is levied on. The Statutory Spec does not state this, so
 * it is configuration (`ewf.wage.base`) with two legal values rather than a
 * decision taken silently here — and an unrecognised value fails the run
 * instead of defaulting, because defaulting would pick a base nobody chose.
 */
function ewfWageBaseFor(selector: { value: string }, ssoWage: Satang, ssoCappedWage: Satang): Satang {
  if (selector.value === EWF_BASE_SSO_CAPPED) return ssoCappedWage
  if (selector.value === EWF_BASE_SSO_UNCAPPED) return ssoWage
  throw statutoryRuleMalformed(
    RULE_KEYS.ewfWageBase,
    `expected ${EWF_BASE_SSO_CAPPED} or ${EWF_BASE_SSO_UNCAPPED}, got ${JSON.stringify(selector.value)}`,
  )
}

function providentFundContribution(
  ratePercent: string | null,
  wage: Satang,
  rules: EngineRules,
  side: 'employee' | 'employer',
): Satang {
  if (ratePercent === null) return 0n
  const rate = parsePercent(ratePercent)
  if (!rateWithinBand(rate, rules.pfRateMin.value, rules.pfRateMax.value)) {
    throw providentFundRateOutOfBand(
      `${ratePercent}%(${side})`,
      `${rules.pfRateMin.value.num.toString()}/${rules.pfRateMin.value.den.toString()}`,
      `${rules.pfRateMax.value.num.toString()}/${rules.pfRateMax.value.den.toString()}`,
      rules.pfRateMin.citation,
    )
  }
  return applyRate(wage, rate)
}

/** Periods left in the tax year, counting this one. Period 1 of 12 leaves 12; period 12 leaves 1. */
function remainingPeriodsIn(periodsPerYear: bigint, indexInYear: number): bigint {
  const index = BigInt(indexInYear)
  if (index < 1n || index > periodsPerYear) {
    throw new Error(
      `computeGrossToNet: period index ${indexInYear.toString()} is outside the ${periodsPerYear.toString()}-period tax year`,
    )
  }
  return periodsPerYear - index + 1n
}
