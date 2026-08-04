import { RULE_KEYS, minimumWageRuleKey } from '../statutory'
import type { Cited, StatutoryResolver, TaxBracket } from '../statutory'
import type { Rate, Satang } from '../money'

/**
 * Every statutory figure the gross-to-net engine needs, RESOLVED — the
 * async half of the engine, kept apart from the arithmetic half
 * (`gross-to-net.ts`) on purpose.
 *
 * The split is what makes 100% branch coverage on the engine achievable and
 * meaningful. `computeGrossToNet` is a pure function of `(input, rules)`:
 * no I/O, no clock, no network, so every branch is reachable by choosing
 * arguments, and a test that says "an October 2026 run applies EWF" is
 * literally a test about a resolved rule rather than about HTTP mocking.
 *
 * EWF IS THE ONE FIELD ALLOWED TO BE `null` FOR A DATE REASON.
 * `ewfRateEmployee`/`ewfRateEmployer` are `Cited<Rate> | null`, and they
 * are `null` for exactly one cause: `svc-config` has no version of that
 * rule in force on the period end date. On 2026-09-30 there is none; on
 * 2026-10-31 there is. Nothing in this file or the next compares a date to
 * a literal — the calendar comparison happens inside `svc-config`'s
 * effective-date resolution, against data.
 */
export interface EngineRules {
  ssoRateEmployee: Cited<Rate>
  ssoRateEmployer: Cited<Rate>
  ssoWageFloor: Cited<Satang>
  ssoWageCeiling: Cited<Satang>

  /** `null` ⇒ no EWF obligation is in force on this period's end date. */
  ewfRateEmployee: Cited<Rate> | null
  ewfRateEmployer: Cited<Rate> | null
  /** Does a registered provident fund exempt the employer? (Statutory Spec §6, V3.) */
  ewfExemptsWithProvidentFund: Cited<boolean>
  /** Which base EWF is levied on: `sso_capped_wage` or `sso_wage`. */
  ewfWageBase: Cited<string>
  employerProvidentFundRegistered: Cited<boolean>

  pfRateMin: Cited<Rate>
  pfRateMax: Cited<Rate>

  taxExpenseRate: Cited<Rate>
  taxExpenseCap: Cited<Satang>
  taxAllowancePersonal: Cited<Satang>
  taxAllowanceSpouse: Cited<Satang>
  taxAllowanceChild: Cited<Satang>
  taxAllowanceChildSecond: Cited<Satang>
  taxAllowanceParentalCare: Cited<Satang>
  pitBrackets: TaxBracket[]

  otWorkdayMultiplier: Cited<Rate>
  otHolidayWorkMultiplier: Cited<Rate>
  otHolidayOtMultiplier: Cited<Rate>
  otHourlyBaseDays: Cited<bigint>
  otHourlyBaseHours: Cited<bigint>

  periodsPerYear: Cited<bigint>
  minWageMonthlyDivisor: Cited<bigint>
  /** `null` ⇒ no minimum-wage notification on file for this province. */
  minimumWageDaily: Cited<Satang> | null
}

/** The EWF wage-base selector's two legal values. Which one applies is config, not code. */
export const EWF_BASE_SSO_CAPPED = 'sso_capped_wage'
export const EWF_BASE_SSO_UNCAPPED = 'sso_wage'

/**
 * Resolves the whole rule set for one period and one province. Every call
 * goes through the SAME `StatutoryResolver` instance, which memoises per
 * key — so a 500-employee run resolves each rule once, and cannot observe
 * two different answers for one key inside one run.
 */
export async function resolveEngineRules(resolver: StatutoryResolver, provinceCode: string): Promise<EngineRules> {
  const [
    ssoRateEmployee,
    ssoRateEmployer,
    ssoWageFloor,
    ssoWageCeiling,
    ewfRateEmployee,
    ewfRateEmployer,
    ewfExemptsWithProvidentFund,
    ewfWageBase,
    employerProvidentFundRegistered,
    pfRateMin,
    pfRateMax,
    taxExpenseRate,
    taxExpenseCap,
    taxAllowancePersonal,
    taxAllowanceSpouse,
    taxAllowanceChild,
    taxAllowanceChildSecond,
    taxAllowanceParentalCare,
    pitBrackets,
    otWorkdayMultiplier,
    otHolidayWorkMultiplier,
    otHolidayOtMultiplier,
    otHourlyBaseDays,
    otHourlyBaseHours,
    periodsPerYear,
    minWageMonthlyDivisor,
    minimumWageDaily,
  ] = await Promise.all([
    resolver.requiredPercent(RULE_KEYS.ssoRateEmployee),
    resolver.requiredPercent(RULE_KEYS.ssoRateEmployer),
    resolver.requiredMoney(RULE_KEYS.ssoWageFloor),
    resolver.requiredMoney(RULE_KEYS.ssoWageCeiling),
    resolver.optionalPercent(RULE_KEYS.ewfRateEmployee),
    resolver.optionalPercent(RULE_KEYS.ewfRateEmployer),
    resolver.requiredFlag(RULE_KEYS.ewfExemptionProvidentFund),
    resolver.requiredText(RULE_KEYS.ewfWageBase),
    resolver.requiredFlag(RULE_KEYS.employerProvidentFundRegistered),
    resolver.requiredPercent(RULE_KEYS.pfRateMin),
    resolver.requiredPercent(RULE_KEYS.pfRateMax),
    resolver.requiredPercent(RULE_KEYS.taxExpenseRate),
    resolver.requiredMoney(RULE_KEYS.taxExpenseCap),
    resolver.requiredMoney(RULE_KEYS.taxAllowancePersonal),
    resolver.requiredMoney(RULE_KEYS.taxAllowanceSpouse),
    resolver.requiredMoney(RULE_KEYS.taxAllowanceChild),
    resolver.requiredMoney(RULE_KEYS.taxAllowanceChildSecond),
    resolver.requiredMoney(RULE_KEYS.taxAllowanceParentalCare),
    resolver.pitBrackets(),
    resolver.requiredMultiplier(RULE_KEYS.otWorkdayMultiplier),
    resolver.requiredMultiplier(RULE_KEYS.otHolidayWorkMultiplier),
    resolver.requiredMultiplier(RULE_KEYS.otHolidayOtMultiplier),
    resolver.requiredCount(RULE_KEYS.otHourlyBaseDays),
    resolver.requiredCount(RULE_KEYS.otHourlyBaseHours),
    resolver.requiredCount(RULE_KEYS.periodsPerYear),
    resolver.requiredCount(RULE_KEYS.minWageMonthlyDivisor),
    resolver.optionalMoney(minimumWageRuleKey(provinceCode)),
  ])

  return {
    ssoRateEmployee,
    ssoRateEmployer,
    ssoWageFloor,
    ssoWageCeiling,
    ewfRateEmployee,
    ewfRateEmployer,
    ewfExemptsWithProvidentFund,
    ewfWageBase,
    employerProvidentFundRegistered,
    pfRateMin,
    pfRateMax,
    taxExpenseRate,
    taxExpenseCap,
    taxAllowancePersonal,
    taxAllowanceSpouse,
    taxAllowanceChild,
    taxAllowanceChildSecond,
    taxAllowanceParentalCare,
    pitBrackets,
    otWorkdayMultiplier,
    otHolidayWorkMultiplier,
    otHolidayOtMultiplier,
    otHourlyBaseDays,
    otHourlyBaseHours,
    periodsPerYear,
    minWageMonthlyDivisor,
    minimumWageDaily,
  }
}
