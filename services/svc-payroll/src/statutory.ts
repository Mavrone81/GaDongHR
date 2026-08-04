import { statutoryRuleMalformed, statutoryRuleNotResolved } from './errors'
import { bahtToSatang, parseMultiplier, parsePercent } from './money'
import type { Rate, Satang } from './money'
import type { ConfigClient, StatutoryRuleView } from './config-client'

/**
 * Every statutory figure the payroll engine uses, resolved from
 * `svc-config` BY KEY AND BY DATE. This file contains rule KEYS and the
 * code that narrows a `jsonb` value into a typed figure — it contains no
 * rates, no ceilings, no brackets and no tiers. That is the whole point:
 * the product absorbs a Thai law change as a rule-pack import, not a
 * release, and the canonical proof is the September-vs-October 2026 EWF
 * test, which passes with no code on either side of it changing.
 *
 * THE DATE USED IS THE PERIOD END DATE. A payroll run for September 2026
 * resolves every rule as of 2026-09-30; October 2026 resolves as of
 * 2026-10-31. Period end (rather than pay date, which can fall in the
 * following month) is the date through which the wage was earned, so a rule
 * that comes into force on the 1st of a month governs that whole month's
 * wages and no part of the preceding month's. `RunsService` passes the same
 * date to every resolution in one run, and stores the resolved versions in
 * `payroll_run.rulepack_versions` so a committed run can be re-explained
 * years later even if the rules have since moved on.
 *
 * REQUIRED vs OPTIONAL is a deliberate, load-bearing distinction:
 *
 *  - `requiredPercent`/`requiredMoney`/... raise PAY-503 when nothing is
 *    effective. A missing SSO ceiling is a configuration gap, and there is
 *    no default in this codebase to fall back on.
 *  - `optionalPercent` returns `null` when nothing is effective. That is
 *    the EWF gate: before 1 Oct 2026 there is simply no version of
 *    `ewf.rate.employee` in force, so the engine adds no EWF line. After
 *    it, the same call returns 0.25 and the line appears. Nothing in the
 *    engine compares a date against a literal.
 */

/**
 * The rule keys this service reads. Names follow the Statutory Rules Spec's
 * own `rule_key` column verbatim where that document names one (§5 SSO, §6
 * EWF, §4 overtime, §9 PIT); the rest follow the same dotted convention.
 * Keys the spec does NOT name are called out in this module's report as
 * items for the rule-pack authors to confirm.
 */
export const RULE_KEYS = {
  ssoRateEmployee: 'sso.rate.employee',
  ssoRateEmployer: 'sso.rate.employer',
  ssoWageFloor: 'sso.wage.floor',
  ssoWageCeiling: 'sso.wage.ceiling',

  ewfRateEmployee: 'ewf.rate.employee',
  ewfRateEmployer: 'ewf.rate.employer',
  /** Whether a registered provident fund exempts the employer from EWF (Statutory Spec §6, flagged V3 pending Ministry of Labour regulations). */
  ewfExemptionProvidentFund: 'ewf.exemption.provident_fund_registered',
  /** Which wage base EWF is levied on: 'sso_capped_wage' or 'sso_wage'. Not stated in the spec — see the report's open-figures list. */
  ewfWageBase: 'ewf.wage.base',

  /** Tenant fact, not a statutory figure: does this employer operate a registered provident fund? Governance class COMPANY_POLICY. */
  employerProvidentFundRegistered: 'employer.provident_fund.registered',
  pfRateMin: 'pf.rate.min',
  pfRateMax: 'pf.rate.max',

  taxExpenseRate: 'tax.expense.rate',
  taxExpenseCap: 'tax.expense.cap',
  taxAllowancePersonal: 'tax.allowance.personal',
  taxAllowanceSpouse: 'tax.allowance.spouse',
  taxAllowanceChild: 'tax.allowance.child',
  taxAllowanceChildSecond: 'tax.allowance.child_second_2018',
  taxAllowanceParentalCare: 'tax.allowance.parental_care',
  taxPitBrackets: 'tax.pit.brackets',

  otWorkdayMultiplier: 'ot.workday.multiplier',
  otHolidayWorkMultiplier: 'ot.holiday_work.multiplier',
  otHolidayOtMultiplier: 'ot.holiday_ot.multiplier',
  /** The divisor pair behind `ot.hourly_base.formula` = monthly ÷ 30 ÷ 8 (Statutory Spec §4; the spec itself calls the divisor configurable). */
  otHourlyBaseDays: 'ot.hourly_base.days_divisor',
  otHourlyBaseHours: 'ot.hourly_base.hours_divisor',

  /**
   * The divisor that turns a monthly wage into the daily equivalent the
   * provincial minimum-wage floor is compared against (Statutory Spec §8
   * writes it as "÷30"). Deliberately a SEPARATE key from
   * `ot.hourly_base.days_divisor`: the spec calls the OT divisor
   * configurable (30/26/actual) and a company that lawfully raises its OT
   * divisor must not thereby move the statutory minimum-wage test.
   */
  minWageMonthlyDivisor: 'minwage.monthly_equivalent_divisor',

  /** Severance tiers, LPA s.118 (Statutory Spec §7). An ARRAY, so the tier table itself is data. */
  severanceTiers: 'severance.tiers',
  /** Divisor turning a monthly wage into the "day of last wage" the s.118 tiers are counted in. Separate key, same reasoning as `minwage.monthly_equivalent_divisor`. */
  severanceDailyWageDivisor: 'severance.daily_wage_divisor',
  /** How many pay periods of notice the law requires; drives pay in lieu (LPA s.17). */
  noticePeriods: 'notice.min_pay_periods',

  /** Pay periods per year — the annualisation divisor of the RD withholding method. */
  periodsPerYear: 'payroll.periods.per_year',
  /** Variance-review flag threshold, as a percentage of the prior period's net. */
  varianceThresholdPercent: 'payroll.variance.threshold_percent',

  /**
   * Employer identity, needed on every statutory filing and every bank
   * file. Tenant configuration rather than statutory figures, but resolved
   * through the same effective-dated store so an entity that re-registers
   * mid-year files each period under the number that was correct then.
   */
  employerName: 'employer.name',
  employerSsoNumber: 'employer.sso_number',
  employerTaxId: 'employer.tax_id',
  employerDisbursementAccount: 'employer.disbursement_account',

  /** Are unused-leave payouts taxable / in the SSO wage base? Classification, not arithmetic — see the report's open-figures list. */
  leavePayoutTaxable: 'payroll.leave_payout.taxable',
  leavePayoutSsoWageBase: 'payroll.leave_payout.sso_wage_base',
  /** Same two questions for severance (LPA s.118) — treated differently from ordinary wages under the Revenue Code. */
  severanceTaxable: 'payroll.severance.taxable',
  severanceSsoWageBase: 'payroll.severance.sso_wage_base',
} as const

/** `minwage.daily.<PROVINCE_CODE>` — 77 provincial daily minimums, shipped as a data pack (Statutory Spec §8, flagged V4). */
export function minimumWageRuleKey(provinceCode: string): string {
  return `minwage.daily.${provinceCode}`
}

/** One bracket of the progressive PIT table. `upTo === null` is the open-ended top bracket. */
export interface TaxBracket {
  upTo: Satang | null
  rate: Rate
  citation: string
}

/** One Section 118 severance tier. A tier applies when BOTH stated minimums (whichever are present) are met. */
export interface SeveranceTier {
  minServiceDays: number | null
  minServiceYears: number | null
  days: number
  citation: string
}

/** A resolved figure plus the citation that justifies it — carried together so an error or a payslip footnote can always say *why*. */
export interface Cited<T> {
  value: T
  citation: string
  ruleKey: string
  effectiveFrom: string
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Config values arrive as `jsonb`. A figure may legitimately be stored as a
 * JSON number (`5`) or a JSON string (`"5"`); both are accepted and both go
 * through the same exact decimal parsers in `money.ts`. A JSON number is
 * stringified rather than arithmetic'd, so no float ever forms — `String(5)`
 * is `'5'`, and `parsePercent` takes it from there.
 */
function asDecimalString(ruleKey: string, value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw statutoryRuleMalformed(ruleKey, 'value is not a finite number')
    // `toString()` on a JSON-parsed number is exact for every decimal a
    // rule pack can express; it never introduces a rounding step because
    // nothing is computed with the number, only printed from it.
    return value.toString()
  }
  throw statutoryRuleMalformed(ruleKey, `expected a numeric value, got ${typeof value}`)
}

/**
 * Resolves typed statutory figures for ONE date. Constructed per run (see
 * `RunsService`), so every employee in a run sees exactly the same rule
 * versions, and a rule that changes mid-run cannot produce two different
 * answers inside one payroll.
 *
 * Resolutions are memoised per key for the lifetime of the resolver: a
 * 500-employee run must not make 500 identical HTTP calls for the SSO
 * ceiling, and — more importantly — must not be able to observe two
 * different answers for one key.
 */
export class StatutoryResolver {
  private readonly cache = new Map<string, Promise<StatutoryRuleView | null>>()
  /** Every rule version this resolver actually used, for `payroll_run.rulepack_versions`. */
  private readonly used = new Map<string, { effectiveFrom: string; citation: string }>()

  constructor(
    private readonly config: ConfigClient,
    /** ISO date — the period end date. See the file header for why. */
    readonly on: string,
  ) {}

  private resolve(ruleKey: string): Promise<StatutoryRuleView | null> {
    const cached = this.cache.get(ruleKey)
    if (cached !== undefined) return cached
    const pending = this.config.getEffectiveRule(ruleKey, this.on).then((view) => {
      if (view !== null) this.used.set(ruleKey, { effectiveFrom: view.effectiveFrom, citation: view.citation })
      return view
    })
    this.cache.set(ruleKey, pending)
    return pending
  }

  /** The rule versions this resolver used, snapshotted into the run so a committed run stays explainable. */
  snapshot(): Record<string, { effectiveFrom: string; citation: string }> {
    return Object.fromEntries(this.used)
  }

  private async required(ruleKey: string): Promise<StatutoryRuleView> {
    const view = await this.resolve(ruleKey)
    if (view === null) throw statutoryRuleNotResolved(ruleKey, this.on)
    return view
  }

  async requiredPercent(ruleKey: string): Promise<Cited<Rate>> {
    const view = await this.required(ruleKey)
    return { value: parsePercent(asDecimalString(ruleKey, view.value)), citation: view.citation, ruleKey, effectiveFrom: view.effectiveFrom }
  }

  /**
   * `null` when nothing is in force on `this.on`. THE EWF DATE GATE. Not a
   * fallback and not an error — an absent effective version is the config's
   * way of saying "this obligation does not exist yet", which is exactly
   * what it means on 30 September 2026.
   */
  async optionalPercent(ruleKey: string): Promise<Cited<Rate> | null> {
    const view = await this.resolve(ruleKey)
    if (view === null) return null
    return { value: parsePercent(asDecimalString(ruleKey, view.value)), citation: view.citation, ruleKey, effectiveFrom: view.effectiveFrom }
  }

  async requiredMultiplier(ruleKey: string): Promise<Cited<Rate>> {
    const view = await this.required(ruleKey)
    return { value: parseMultiplier(asDecimalString(ruleKey, view.value)), citation: view.citation, ruleKey, effectiveFrom: view.effectiveFrom }
  }

  async requiredMoney(ruleKey: string): Promise<Cited<Satang>> {
    const view = await this.required(ruleKey)
    return { value: bahtToSatang(asDecimalString(ruleKey, view.value)), citation: view.citation, ruleKey, effectiveFrom: view.effectiveFrom }
  }

  /** `null` when no provincial minimum wage is on file for this province — a real gap the caller must decide about, never a silent pass. */
  async optionalMoney(ruleKey: string): Promise<Cited<Satang> | null> {
    const view = await this.resolve(ruleKey)
    if (view === null) return null
    return { value: bahtToSatang(asDecimalString(ruleKey, view.value)), citation: view.citation, ruleKey, effectiveFrom: view.effectiveFrom }
  }

  async requiredCount(ruleKey: string): Promise<Cited<bigint>> {
    const view = await this.required(ruleKey)
    const text = asDecimalString(ruleKey, view.value)
    if (!/^\d+$/.test(text)) throw statutoryRuleMalformed(ruleKey, `expected a whole count, got ${JSON.stringify(text)}`)
    return { value: BigInt(text), citation: view.citation, ruleKey, effectiveFrom: view.effectiveFrom }
  }

  async requiredFlag(ruleKey: string): Promise<Cited<boolean>> {
    const view = await this.required(ruleKey)
    const raw = view.value
    if (typeof raw !== 'boolean') throw statutoryRuleMalformed(ruleKey, `expected a boolean, got ${typeof raw}`)
    return { value: raw, citation: view.citation, ruleKey, effectiveFrom: view.effectiveFrom }
  }

  async requiredText(ruleKey: string): Promise<Cited<string>> {
    const view = await this.required(ruleKey)
    const raw = view.value
    if (typeof raw !== 'string') throw statutoryRuleMalformed(ruleKey, `expected a string, got ${typeof raw}`)
    return { value: raw, citation: view.citation, ruleKey, effectiveFrom: view.effectiveFrom }
  }

  /**
   * The progressive PIT table, as DATA. Each entry is
   * `{ upTo: <THB or null>, rate: <percent> }`; entries are sorted by
   * threshold here rather than trusted to arrive sorted, because a
   * mis-ordered pack would otherwise silently produce a wrong tax on every
   * payslip instead of failing.
   */
  async pitBrackets(): Promise<TaxBracket[]> {
    const ruleKey = RULE_KEYS.taxPitBrackets
    const view = await this.required(ruleKey)
    const raw = view.value
    if (!Array.isArray(raw) || raw.length === 0) throw statutoryRuleMalformed(ruleKey, 'expected a non-empty array of brackets')

    const brackets: TaxBracket[] = raw.map((entry) => {
      if (!isRecord(entry)) throw statutoryRuleMalformed(ruleKey, 'a bracket entry is not an object')
      const upToRaw = entry['upTo']
      const rateRaw = entry['rate']
      if (rateRaw === undefined) throw statutoryRuleMalformed(ruleKey, 'a bracket entry has no rate')
      const upTo = upToRaw === null || upToRaw === undefined ? null : bahtToSatang(asDecimalString(ruleKey, upToRaw))
      return { upTo, rate: parsePercent(asDecimalString(ruleKey, rateRaw)), citation: view.citation }
    })

    const openEnded = brackets.filter((b) => b.upTo === null)
    if (openEnded.length !== 1) {
      throw statutoryRuleMalformed(ruleKey, `expected exactly one open-ended top bracket, found ${openEnded.length.toString()}`)
    }
    const bounded = brackets.filter((b): b is TaxBracket & { upTo: Satang } => b.upTo !== null)
    bounded.sort((a, b) => (a.upTo < b.upTo ? -1 : a.upTo > b.upTo ? 1 : 0))
    const top = openEnded[0]
    if (top === undefined) throw statutoryRuleMalformed(ruleKey, 'unreachable: open-ended bracket vanished')
    return [...bounded, top]
  }

  /** The Section 118 tier table, as DATA. Sorted ascending so the engine can take the last tier the employee qualifies for. */
  async severanceTiers(): Promise<SeveranceTier[]> {
    const ruleKey = RULE_KEYS.severanceTiers
    const view = await this.required(ruleKey)
    const raw = view.value
    if (!Array.isArray(raw) || raw.length === 0) throw statutoryRuleMalformed(ruleKey, 'expected a non-empty array of severance tiers')

    const tiers: SeveranceTier[] = raw.map((entry) => {
      if (!isRecord(entry)) throw statutoryRuleMalformed(ruleKey, 'a tier entry is not an object')
      const days = entry['days']
      if (typeof days !== 'number' || !Number.isInteger(days) || days < 0) {
        throw statutoryRuleMalformed(ruleKey, 'a tier entry has no whole non-negative `days`')
      }
      const minDays = entry['minServiceDays']
      const minYears = entry['minServiceYears']
      if (minDays === undefined && minYears === undefined) {
        throw statutoryRuleMalformed(ruleKey, 'a tier entry states neither minServiceDays nor minServiceYears')
      }
      return {
        minServiceDays: typeof minDays === 'number' ? minDays : null,
        minServiceYears: typeof minYears === 'number' ? minYears : null,
        days,
        citation: view.citation,
      }
    })

    // Ascending by entitlement — the engine picks the last qualifying tier,
    // so ordering is load-bearing and is imposed here, not assumed.
    tiers.sort((a, b) => a.days - b.days)
    return tiers
  }
}
