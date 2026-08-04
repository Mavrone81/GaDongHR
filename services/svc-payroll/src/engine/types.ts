import type { Satang } from '../money'

/** LPA-recognised pay bases (M7-1). `pay_profile.pay_basis`'s CHECK constraint carries the same three. */
export type PayBasis = 'monthly' | 'daily' | 'hourly'

/**
 * One earning or deduction line entering a period's calculation: a
 * recurring item from the pay profile, a one-off manual item, an
 * unused-leave payout, or an approved expense reimbursement.
 *
 * `taxable` and `ssoWageBase` are SEPARATE, MANDATORY booleans rather than
 * something derived from `code`. That is the single most consequential
 * design decision in this file. `claim.approved_for_payroll` carries
 * `taxable:false` and `ssoWageBase:false` explicitly; the engine reads
 * those flags and never re-derives the classification. A reimbursement that
 * drifts into the tax base over-taxes the employee, and one that drifts
 * into the SSO base makes the employer's สปส.1-10 filing wrong — two
 * different wrongs from one missing boolean.
 */
export interface PayLineInput {
  code: string
  direction: 'earning' | 'deduction'
  amount: Satang
  taxable: boolean
  ssoWageBase: boolean
  /**
   * A bonus or other non-recurring payment. Under the Revenue Department's
   * annualised withholding method a one-off is added to projected annual
   * income ONCE, not multiplied by the remaining periods — treating a
   * December bonus as recurring would over-withhold enormously.
   */
  oneOff: boolean
}

/**
 * Hours and days from a LOCKED timesheet period, as plain decimal strings
 * ("21", "7.5"). Strings, not numbers, because they are parsed into exact
 * rationals — nothing in this service turns a quantity into a float on its
 * way to a money figure.
 */
export interface TimesheetTotals {
  daysWorked: string
  hoursWorked: string
  /** LPA s.61 — overtime on a working day. Maps to `timesheet.day_record.ot_15x`. */
  otWorkdayHours: string

  /**
   * LPA s.62 — the holiday-work premium. Maps to
   * `timesheet.day_record.ot_2x`.
   *
   * ⚠️ THIS IS A PAY-RATE-EQUIVALENT QUANTITY, NOT RAW HOURS WORKED, and
   * the distinction is worth money. M3's `OtClassifier` defines `ot_2x` as
   * "minutes payable at exactly 2× the hourly base", and encodes the LPA
   * s.62 entitlement distinction IN THE QUANTITY rather than in the
   * multiplier:
   *
   *   - A MONTHLY employee already receives their normal day's wage for a
   *     public holiday whether or not they work it, so the law owes only a
   *     further +1× for hours actually worked. M3 therefore stores HALF the
   *     worked minutes here, so that `half × 2× = 1×` — the correct top-up.
   *   - A DAILY/HOURLY/CONTRACT employee receives nothing for an unworked
   *     holiday, so the law owes the full 2×. M3 stores the FULL worked
   *     minutes.
   *
   * M3's worked example (TC-M3-007): an 8-hour holiday shift yields
   * `ot_2x = 4.00` for a monthly employee and `ot_2x = 8.00` for a
   * daily-rate one. `day_record.worked_hours` always carries the true,
   * unscaled hours actually worked; nothing is lost, only the
   * payable-at-2× equivalent is derived.
   *
   * SO THIS ENGINE APPLIES `ot.holiday_work.multiplier` UNIFORMLY, at 2×,
   * to whatever quantity arrives — and MUST NOT re-derive the entitlement
   * distinction from `PayProfileInput.basis`. Doing so would halve a
   * monthly employee's holiday premium a SECOND time and pay 0.5× where
   * the law owes 1×, on a payslip that would look entirely plausible.
   * `gross-to-net.test.ts`'s "the M3 `ot_2x` contract" block pins both
   * sides of this, including the double-halving trap.
   *
   * Note that the Statutory Spec §4 states the same rule the OTHER way
   * round — `ot.holiday_work.multiplier` as "+1× for employees entitled to
   * paid holidays (→2× total); 2× for daily-rate without holiday pay",
   * i.e. the distinction living in the MULTIPLIER. Both encodings are
   * correct in isolation; applying both is the defect. M3 owns the
   * classification and shipped first, so the quantity carries it and this
   * engine's multiplier stays uniform.
   */
  otHolidayWorkHours: string

  /** LPA s.63 — overtime on a holiday, a flat 3× for every employment type. Maps to `timesheet.day_record.ot_3x`. */
  otHolidayOtHours: string
}

export const ZERO_TIMESHEET: TimesheetTotals = {
  daysWorked: '0',
  hoursWorked: '0',
  otWorkdayHours: '0',
  otHolidayWorkHours: '0',
  otHolidayOtHours: '0',
}

/**
 * The employee's ล.ย.01-equivalent allowance declaration. Counts, not
 * amounts: the AMOUNT each allowance is worth is a statutory figure that
 * comes from `svc-config` (`tax.allowance.*`), so a change to the personal
 * allowance is a rule-pack import, not a re-declaration by every employee.
 */
export interface TaxDeclaration {
  spouse: boolean
  children: number
  /** Second and subsequent children born from 2018 onward, which carry a higher allowance (Statutory Spec §9). */
  childrenSecondFrom2018: number
  parentsCaredFor: number
  /** Declared life/health insurance, RMF and similar, already summed and capped by the declaration workflow. */
  otherAllowances: Satang
}

export const NO_DECLARATION: TaxDeclaration = {
  spouse: false,
  children: 0,
  childrenSecondFrom2018: 0,
  parentsCaredFor: 0,
  otherAllowances: 0n,
}

export interface PayProfileInput {
  basis: PayBasis
  basePay: Satang
  /** Decimal percent string, or `null` when the employee does not participate in the provident fund. */
  pfRatePercent: string | null
  pfRateEmployerPercent: string | null
  declaration: TaxDeclaration | null
}

export interface PeriodInput {
  /** 'YYYY-MM'. */
  code: string
  /** ISO date, inclusive. */
  start: string
  /** ISO date, inclusive — the date every statutory rule is resolved as of. */
  end: string
  payDate: string
  /** 1-based index of this period within the tax year; drives the annualised withholding divisor. */
  indexInYear: number
}

/** Year-to-date figures from the employee's already-committed payslips in the same tax year. */
export interface YearToDate {
  taxableIncome: Satang
  ssoEmployee: Satang
  pfEmployee: Satang
  whtPaid: Satang
}

export const ZERO_YTD: YearToDate = { taxableIncome: 0n, ssoEmployee: 0n, pfEmployee: 0n, whtPaid: 0n }

export interface EmployeeInput {
  id: string
  /** Drives the provincial minimum-wage floor. */
  provinceCode: string
}

export interface GrossToNetInput {
  employee: EmployeeInput
  period: PeriodInput
  profile: PayProfileInput
  timesheet: TimesheetTotals
  lines: readonly PayLineInput[]
  ytd: YearToDate
}

/** One computed line on the payslip, in the order the payslip prints it. */
export interface ComputedLine {
  code: string
  category: 'earning' | 'employee_deduction' | 'employer_contribution' | 'non_taxable_payment'
  amount: Satang
  /** The rule key + citation behind a statutory line; `null` for a contractual one. */
  citation: string | null
}

/**
 * The result of one employee's gross-to-net calculation. Every field is
 * satang; nothing here is rendered, formatted or rounded to baht — that
 * happens once, in the payslip renderer, through the kernel's `formatTHB`.
 */
export interface GrossToNetResult {
  /** Taxable/SSO-bearing earnings: base + OT + taxable allowances. */
  gross: Satang
  /** The portion of `gross` entering the PIT base. */
  taxableGross: Satang
  /** Reimbursements and other payments outside both the tax and SSO bases. */
  nonTaxablePay: Satang
  basePayEarned: Satang
  overtimePay: Satang
  /** The wage SSO is levied on, BEFORE the floor/ceiling band is applied. */
  ssoWage: Satang
  /** ...and after. The cap binding is the whole point of `sso.wage.ceiling`. */
  ssoCappedWage: Satang
  ssoEmployee: Satang
  ssoEmployer: Satang
  ewfEmployee: Satang
  ewfEmployer: Satang
  pfEmployee: Satang
  pfEmployer: Satang
  wht: Satang
  otherDeductions: Satang
  net: Satang
  lines: ComputedLine[]
  /** Non-fatal observations that must reach the payslip and the variance review (e.g. PAY-040's missing declaration). */
  notes: string[]
  /** Rule key → citation for every statutory figure that moved a number in this result. */
  citations: Record<string, string>
}
