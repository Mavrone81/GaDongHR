import { RULE_KEYS, minimumWageRuleKey } from '../statutory'
import type { StatutoryRuleView } from '../config-client'
import { FakeConfigClient } from './fake-config-client'

/**
 * THE 2026 THAI RULE PACK, AS A TEST FIXTURE.
 *
 * This is the ONLY file in this service that contains a Thai statutory
 * figure. Everything here comes from
 * `docs/02-statutory/THAILAND-STATUTORY-RULES-SPEC.md`, is cited to the
 * instrument the spec cites, and stands in for what `svc-config` would
 * serve from a signed rule pack in production. Nothing in `src/` outside
 * `src/testing/` may contain any of these numbers — `no-float.test.ts`'s
 * companion scan asserts that.
 *
 * EFFECTIVE DATING IS THE POINT. Three keys ship as MULTIPLE versions:
 *
 *  - `sso.wage.ceiling`: 15,000 to 2025-12-31, then 17,500 from 2026-01-01
 *    (Spec §5; the exact gazetted 2026 figure is flagged V2).
 *  - `ewf.rate.employee` / `ewf.rate.employer`: NOTHING before 2026-10-01,
 *    0.25% from 2026-10-01, 0.50% from 2031-10-01 (Spec §6). The absence
 *    of a version before 1 October 2026 is not an oversight — it is how
 *    "the obligation does not exist yet" is expressed as data, and it is
 *    what makes the September-versus-October acceptance test pass without
 *    a line of engine code knowing a date.
 */

const OPEN = null

function rule(ruleKey: string, value: unknown, citation: string, effectiveFrom = '2000-01-01', effectiveTo: string | null = OPEN): StatutoryRuleView {
  return { ruleKey, value, statutoryFloor: null, citation, effectiveFrom, effectiveTo }
}

/** Statutory Spec §9 — progressive PIT brackets, default pack effective 1 Jan 2026. */
export const PIT_BRACKETS_2026 = [
  { upTo: '150000', rate: '0' },
  { upTo: '300000', rate: '5' },
  { upTo: '500000', rate: '10' },
  { upTo: '750000', rate: '15' },
  { upTo: '1000000', rate: '20' },
  { upTo: '2000000', rate: '25' },
  { upTo: '5000000', rate: '30' },
  { upTo: null, rate: '35' },
]

/** Statutory Spec §7 — LPA s.118 severance tiers, expressed as data. */
export const SEVERANCE_TIERS = [
  { minServiceDays: 120, days: 30 },
  { minServiceYears: 1, days: 90 },
  { minServiceYears: 3, days: 180 },
  { minServiceYears: 6, days: 240 },
  { minServiceYears: 10, days: 300 },
  { minServiceYears: 20, days: 400 },
]

/** Province codes used across the tests. Statutory Spec §8's 2026 range is roughly 337–400 THB/day; the full 77-province table is flagged V4. */
export const PROVINCE_BANGKOK = 'TH-10'
export const PROVINCE_LOW_BAND = 'TH-96'

export function statutoryRules(): StatutoryRuleView[] {
  return [
    // --- §5 Social Security ---
    rule(RULE_KEYS.ssoRateEmployee, '5', 'Social Security Act B.E. 2533'),
    rule(RULE_KEYS.ssoRateEmployer, '5', 'Social Security Act B.E. 2533'),
    rule(RULE_KEYS.ssoWageFloor, '1650', 'Social Security Act B.E. 2533'),
    // The staged ceiling increase, as two effective-dated versions.
    rule(RULE_KEYS.ssoWageCeiling, '15000', 'SSO ceiling notification (pre-2026)', '2000-01-01', '2025-12-31'),
    rule(RULE_KEYS.ssoWageCeiling, '17500', 'SSO ceiling increase effective 1 Jan 2026 (Spec §12 V2 — verify gazetted figure)', '2026-01-01'),

    // --- §6 Employee Welfare Fund ---
    // No version before 2026-10-01. THAT ABSENCE IS THE DATE GATE.
    rule(RULE_KEYS.ewfRateEmployee, '0.25', 'Employee Welfare Fund, in force 1 Oct 2026', '2026-10-01', '2031-09-30'),
    rule(RULE_KEYS.ewfRateEmployee, '0.50', 'Employee Welfare Fund, second tranche 1 Oct 2031', '2031-10-01'),
    rule(RULE_KEYS.ewfRateEmployer, '0.25', 'Employee Welfare Fund, in force 1 Oct 2026', '2026-10-01', '2031-09-30'),
    rule(RULE_KEYS.ewfRateEmployer, '0.50', 'Employee Welfare Fund, second tranche 1 Oct 2031', '2031-10-01'),
    rule(RULE_KEYS.ewfExemptionProvidentFund, true, 'EWF exemption for employers with a registered provident fund (Spec §12 V3 — verify scope)'),
    rule(RULE_KEYS.ewfWageBase, 'sso_capped_wage', 'EWF wage base — not stated in the Spec; see the M7 report open-figures list'),

    // --- Provident fund ---
    rule(RULE_KEYS.employerProvidentFundRegistered, false, 'Tenant configuration (COMPANY_POLICY)'),
    rule(RULE_KEYS.pfRateMin, '2', 'Provident Fund Act B.E. 2530'),
    rule(RULE_KEYS.pfRateMax, '15', 'Provident Fund Act B.E. 2530'),

    // --- §9 Personal income tax ---
    rule(RULE_KEYS.taxExpenseRate, '50', 'Revenue Code — expense deduction'),
    rule(RULE_KEYS.taxExpenseCap, '100000', 'Revenue Code — expense deduction cap'),
    rule(RULE_KEYS.taxAllowancePersonal, '60000', 'Revenue Code — personal allowance'),
    rule(RULE_KEYS.taxAllowanceSpouse, '60000', 'Revenue Code — spouse allowance'),
    rule(RULE_KEYS.taxAllowanceChild, '30000', 'Revenue Code — child allowance'),
    rule(RULE_KEYS.taxAllowanceChildSecond, '60000', 'Revenue Code — 2nd+ child born 2018 onward'),
    rule(RULE_KEYS.taxAllowanceParentalCare, '30000', 'Revenue Code — parental care, per parent'),
    rule(RULE_KEYS.taxPitBrackets, PIT_BRACKETS_2026, 'Revenue Code — progressive PIT brackets, pack effective 1 Jan 2026'),

    // --- §4 Working hours and overtime ---
    rule(RULE_KEYS.otWorkdayMultiplier, '1.5', 'LPA s.61'),
    rule(RULE_KEYS.otHolidayWorkMultiplier, '2', 'LPA s.62'),
    rule(RULE_KEYS.otHolidayOtMultiplier, '3', 'LPA s.63'),
    rule(RULE_KEYS.otHourlyBaseDays, '30', 'ot.hourly_base.formula — monthly ÷ 30 ÷ 8 (Spec §4, divisor configurable)'),
    rule(RULE_KEYS.otHourlyBaseHours, '8', 'LPA s.23 — 8-hour working day'),

    // --- §8 Minimum wage ---
    rule(RULE_KEYS.minWageMonthlyDivisor, '30', 'Spec §8 — monthly-equivalent ÷30'),
    rule(minimumWageRuleKey(PROVINCE_BANGKOK), '400', 'Wage Committee notification (Spec §12 V4 — verify)', '2025-01-01'),
    rule(minimumWageRuleKey(PROVINCE_LOW_BAND), '337', 'Wage Committee notification (Spec §12 V4 — verify)', '2025-01-01'),

    // --- §7 Termination ---
    rule(RULE_KEYS.severanceTiers, SEVERANCE_TIERS, 'LPA s.118'),
    rule(RULE_KEYS.severanceDailyWageDivisor, '30', 'Day of last wage for a monthly employee'),
    rule(RULE_KEYS.noticePeriods, '1', 'LPA s.17 — at least one pay period'),

    // --- Payroll cycle / classification ---
    rule(RULE_KEYS.periodsPerYear, '12', 'Monthly payroll cycle'),
    rule(RULE_KEYS.varianceThresholdPercent, '10', 'Company policy — variance review threshold'),
    rule(RULE_KEYS.leavePayoutTaxable, true, 'LPA s.67 payout treated as employment income (M7 report open-figures list)'),
    rule(RULE_KEYS.leavePayoutSsoWageBase, false, 'Leave payout outside the SSO wage base (M7 report open-figures list)'),
    rule(RULE_KEYS.severanceTaxable, true, 'LPA s.118 severance treated as assessable income (M7 report open-figures list)'),
    rule(RULE_KEYS.severanceSsoWageBase, false, 'Severance outside the SSO wage base (M7 report open-figures list)'),

    // --- Employer identity ---
    rule(RULE_KEYS.employerName, 'Bevora (Thailand) Co., Ltd.', 'Tenant configuration'),
    rule(RULE_KEYS.employerSsoNumber, '1000000000', 'Tenant configuration'),
    rule(RULE_KEYS.employerTaxId, '0105500000000', 'Tenant configuration'),
    rule(RULE_KEYS.employerDisbursementAccount, '1234567890', 'Tenant configuration'),
  ]
}

export function seededConfig(): FakeConfigClient {
  const config = new FakeConfigClient()
  config.seedMany(statutoryRules())
  return config
}
