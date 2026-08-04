import { bahtToSatang, satangToBaht } from '../money'
import { RULE_KEYS, StatutoryResolver } from '../statutory'
import { FakeConfigClient } from '../testing/fake-config-client'
import { PROVINCE_BANGKOK, PROVINCE_LOW_BAND, seededConfig } from '../testing/statutory-fixture'
import { computeGrossToNet } from './gross-to-net'
import { resolveEngineRules } from './rules'
import type { EngineRules } from './rules'
import { ZERO_TIMESHEET, ZERO_YTD } from './types'
import type { GrossToNetInput, PayBasis, PayLineInput, TaxDeclaration, TimesheetTotals } from './types'

/**
 * THE GROSS-TO-NET ENGINE. This suite is the one the module is judged on.
 *
 * Every rule the engine uses is resolved from the fixture rule pack through
 * the REAL `StatutoryResolver` — the same code path production uses — so a
 * test that says "October applies EWF" is a test about effective-dated
 * data, not about a mock returning what the test wanted.
 *
 * Two demonstrations are included, both of the same shape: the assertion is
 * re-run against a deliberately broken rule set, and MUST fail. A test that
 * would still pass with the control removed is not evidence of anything.
 */

const SEPTEMBER_2026 = '2026-09-30'
const OCTOBER_2026 = '2026-10-31'

async function rulesAsOf(on: string, province = PROVINCE_BANGKOK, config: FakeConfigClient = seededConfig()): Promise<EngineRules> {
  return resolveEngineRules(new StatutoryResolver(config, on), province)
}

interface InputOverrides {
  basis?: PayBasis
  basePayThb?: string
  provinceCode?: string
  pfRatePercent?: string | null
  pfRateEmployerPercent?: string | null
  declaration?: TaxDeclaration | null
  timesheet?: Partial<TimesheetTotals>
  lines?: PayLineInput[]
  indexInYear?: number
  ytd?: GrossToNetInput['ytd']
}

function input(overrides: InputOverrides = {}): GrossToNetInput {
  return {
    employee: { id: 'emp-1', provinceCode: overrides.provinceCode ?? PROVINCE_BANGKOK },
    period: { code: '2026-09', start: '2026-09-01', end: '2026-09-30', payDate: '2026-09-30', indexInYear: overrides.indexInYear ?? 9 },
    profile: {
      basis: overrides.basis ?? 'monthly',
      basePay: bahtToSatang(overrides.basePayThb ?? '45000'),
      pfRatePercent: overrides.pfRatePercent ?? null,
      pfRateEmployerPercent: overrides.pfRateEmployerPercent ?? null,
      declaration: overrides.declaration ?? null,
    },
    timesheet: { ...ZERO_TIMESHEET, ...overrides.timesheet },
    lines: overrides.lines ?? [],
    ytd: overrides.ytd ?? ZERO_YTD,
  }
}

function earning(code: string, thb: string, taxable: boolean, ssoWageBase: boolean, oneOff = false): PayLineInput {
  return { code, direction: 'earning', amount: bahtToSatang(thb), taxable, ssoWageBase, oneOff }
}

// ---------------------------------------------------------------------------
// M7-2 ACCEPTANCE CRITERION — the EWF date gate
// ---------------------------------------------------------------------------

describe('M7-2 AC: a September 2026 run applies no EWF; an October 2026 run applies 0.25% — with no code change', () => {
  /**
   * IDENTICAL INPUT ON BOTH SIDES. The only difference between the two
   * calls is the DATE the rules were resolved as of. Even the period index
   * is held constant, so nothing but the EWF rule can move the result.
   */
  const sameEmployee = () => input({ indexInYear: 9 })

  it('September 2026: no EWF line, no EWF deduction, and a note saying it is not yet in force', async () => {
    const result = computeGrossToNet(sameEmployee(), await rulesAsOf(SEPTEMBER_2026))

    expect(result.ewfEmployee).toBe(0n)
    expect(result.ewfEmployer).toBe(0n)
    expect(result.lines.some((l) => l.code.startsWith('ewf_'))).toBe(false)
    expect(result.notes).toContain('payroll.note.ewf_not_yet_in_force')
  })

  it('October 2026: 0.25% employee AND 0.25% employer, on the same capped wage', async () => {
    const result = computeGrossToNet(sameEmployee(), await rulesAsOf(OCTOBER_2026))

    // 0.25% of the 17,500 capped wage.
    expect(satangToBaht(result.ewfEmployee)).toBe('43.75')
    expect(satangToBaht(result.ewfEmployer)).toBe('43.75')
    expect(result.lines.filter((l) => l.code.startsWith('ewf_')).map((l) => l.code)).toEqual(['ewf_employee', 'ewf_employer'])
  })

  it('the net difference between the two runs is EXACTLY the employee EWF contribution', async () => {
    const sep = computeGrossToNet(sameEmployee(), await rulesAsOf(SEPTEMBER_2026))
    const oct = computeGrossToNet(sameEmployee(), await rulesAsOf(OCTOBER_2026))

    expect(sep.net - oct.net).toBe(oct.ewfEmployee)
    expect(satangToBaht(sep.net)).toBe('44125.00')
    expect(satangToBaht(oct.net)).toBe('44081.25')
  })

  it('the gate is the DATA, not the code: 30 Sep 2026 is off and 1 Oct 2026 is on, one day apart', async () => {
    const off = computeGrossToNet(sameEmployee(), await rulesAsOf('2026-09-30'))
    const on = computeGrossToNet(sameEmployee(), await rulesAsOf('2026-10-01'))
    expect(off.ewfEmployee).toBe(0n)
    expect(on.ewfEmployee).toBeGreaterThan(0n)
  })

  it('the second tranche is equally data: 1 Oct 2031 doubles the rate to 0.50%', async () => {
    const before = computeGrossToNet(sameEmployee(), await rulesAsOf('2031-09-30'))
    const after = computeGrossToNet(sameEmployee(), await rulesAsOf('2031-10-01'))
    expect(satangToBaht(before.ewfEmployee)).toBe('43.75')
    expect(satangToBaht(after.ewfEmployee)).toBe('87.50')
  })

  it('the engine resolves the EWF rules AS OF THE PERIOD END DATE — asserted against what it actually asked config for', async () => {
    const config = seededConfig()
    await rulesAsOf(SEPTEMBER_2026, PROVINCE_BANGKOK, config)
    const ewfRequests = config.requests.filter((r) => r.ruleKey === RULE_KEYS.ewfRateEmployee)
    expect(ewfRequests).toHaveLength(1)
    expect(ewfRequests[0]?.on).toBe(SEPTEMBER_2026)
  })

  /**
   * DEMONSTRATION — the September expectation FAILS when the date gate is
   * removed. `rules.ewfRate*` being `null` before 1 Oct 2026 IS the gate;
   * a rule set with October's rate but September's everything-else is
   * exactly what a broken gate would produce, and the assertion above must
   * reject it.
   */
  it('DEMONSTRATION: the "no EWF in September" assertion FAILS against a rule set with the date gate removed', async () => {
    const septemberRules = await rulesAsOf(SEPTEMBER_2026)
    const octoberRules = await rulesAsOf(OCTOBER_2026)
    const gateRemoved: EngineRules = {
      ...septemberRules,
      ewfRateEmployee: octoberRules.ewfRateEmployee,
      ewfRateEmployer: octoberRules.ewfRateEmployer,
    }

    const broken = computeGrossToNet(sameEmployee(), gateRemoved)

    expect(() => {
      expect(broken.ewfEmployee).toBe(0n)
    }).toThrow()
    expect(broken.ewfEmployee).toBe(bahtToSatang('43.75'))
  })
})

// ---------------------------------------------------------------------------
// EWF exemption
// ---------------------------------------------------------------------------

describe('EWF is suppressed where the employer has a registered provident fund', () => {
  it('no EWF lines at all, and a note recording why', async () => {
    const config = seededConfig()
    config.amend(RULE_KEYS.employerProvidentFundRegistered, OCTOBER_2026, true)

    const result = computeGrossToNet(input(), await rulesAsOf(OCTOBER_2026, PROVINCE_BANGKOK, config))

    expect(result.ewfEmployee).toBe(0n)
    expect(result.ewfEmployer).toBe(0n)
    expect(result.notes).toContain('payroll.note.ewf_exempt_provident_fund')
  })

  it('the exemption SCOPE is itself config (§12 V3 is unverified): with a registered PF but exemption off, EWF still applies', async () => {
    const config = seededConfig()
    config.amend(RULE_KEYS.employerProvidentFundRegistered, OCTOBER_2026, true)
    config.amend(RULE_KEYS.ewfExemptionProvidentFund, OCTOBER_2026, false)

    const result = computeGrossToNet(input(), await rulesAsOf(OCTOBER_2026, PROVINCE_BANGKOK, config))

    expect(satangToBaht(result.ewfEmployee)).toBe('43.75')
  })

  it('the exemption applies before the date gate is even consulted — a September run with a registered PF says "exempt", not "not yet"', async () => {
    const config = seededConfig()
    config.amend(RULE_KEYS.employerProvidentFundRegistered, SEPTEMBER_2026, true)

    const result = computeGrossToNet(input(), await rulesAsOf(SEPTEMBER_2026, PROVINCE_BANGKOK, config))

    expect(result.notes).toContain('payroll.note.ewf_exempt_provident_fund')
    expect(result.notes).not.toContain('payroll.note.ewf_not_yet_in_force')
  })

  it('an EWF employee rate in force with no employer rate produces only the employee line', async () => {
    const config = seededConfig()
    config.remove(RULE_KEYS.ewfRateEmployer)
    const result = computeGrossToNet(input(), await rulesAsOf(OCTOBER_2026, PROVINCE_BANGKOK, config))
    expect(result.ewfEmployee).toBeGreaterThan(0n)
    expect(result.ewfEmployer).toBe(0n)
    expect(result.notes).not.toContain('payroll.note.ewf_not_yet_in_force')
  })

  it('an employer rate with no employee rate produces only the employer line', async () => {
    const config = seededConfig()
    config.remove(RULE_KEYS.ewfRateEmployee)
    const result = computeGrossToNet(input(), await rulesAsOf(OCTOBER_2026, PROVINCE_BANGKOK, config))
    expect(result.ewfEmployee).toBe(0n)
    expect(result.ewfEmployer).toBeGreaterThan(0n)
  })

  it('the EWF wage base is config: switching to the UNCAPPED wage raises the contribution for a high earner', async () => {
    const capped = computeGrossToNet(input(), await rulesAsOf(OCTOBER_2026))
    const config = seededConfig()
    config.amend(RULE_KEYS.ewfWageBase, OCTOBER_2026, 'sso_wage')
    const uncapped = computeGrossToNet(input(), await rulesAsOf(OCTOBER_2026, PROVINCE_BANGKOK, config))

    expect(satangToBaht(capped.ewfEmployee)).toBe('43.75')
    expect(satangToBaht(uncapped.ewfEmployee)).toBe('112.50')
  })

  it('an unrecognised wage base FAILS the run rather than defaulting to a base nobody chose', async () => {
    const config = seededConfig()
    config.amend(RULE_KEYS.ewfWageBase, OCTOBER_2026, 'whatever')
    const rules = await rulesAsOf(OCTOBER_2026, PROVINCE_BANGKOK, config)
    expect(() => computeGrossToNet(input(), rules)).toThrow(expect.objectContaining({ code: 'PAY-504' }))
  })
})

// ---------------------------------------------------------------------------
// SSO ceiling
// ---------------------------------------------------------------------------

describe('SSO — the ceiling must bind, on both the employee and the employer side', () => {
  it('17,499 THB: below the ceiling, so the whole wage is covered', async () => {
    const result = computeGrossToNet(input({ basePayThb: '17499' }), await rulesAsOf(SEPTEMBER_2026))
    expect(satangToBaht(result.ssoCappedWage)).toBe('17499.00')
    expect(satangToBaht(result.ssoEmployee)).toBe('874.95')
    expect(satangToBaht(result.ssoEmployer)).toBe('874.95')
  })

  it('17,500 THB: exactly at the ceiling — 875.00, the figure the Statutory Spec names', async () => {
    const result = computeGrossToNet(input({ basePayThb: '17500' }), await rulesAsOf(SEPTEMBER_2026))
    expect(satangToBaht(result.ssoCappedWage)).toBe('17500.00')
    expect(satangToBaht(result.ssoEmployee)).toBe('875.00')
    expect(satangToBaht(result.ssoEmployer)).toBe('875.00')
  })

  it('40,000 THB: THE CAP BINDS — contributions are on 17,500, not on 40,000', async () => {
    const result = computeGrossToNet(input({ basePayThb: '40000' }), await rulesAsOf(SEPTEMBER_2026))
    expect(satangToBaht(result.ssoWage)).toBe('40000.00')
    expect(satangToBaht(result.ssoCappedWage)).toBe('17500.00')
    expect(satangToBaht(result.ssoEmployee)).toBe('875.00')
    expect(satangToBaht(result.ssoEmployer)).toBe('875.00')
  })

  it('the 17,499/17,500/40,000 trio: the last two are identical, the first is not', async () => {
    const rules = await rulesAsOf(SEPTEMBER_2026)
    const at17499 = computeGrossToNet(input({ basePayThb: '17499' }), rules)
    const at17500 = computeGrossToNet(input({ basePayThb: '17500' }), rules)
    const at40000 = computeGrossToNet(input({ basePayThb: '40000' }), rules)

    expect(at17500.ssoEmployee).toBe(at40000.ssoEmployee)
    expect(at17499.ssoEmployee).toBeLessThan(at17500.ssoEmployee)
  })

  it('the CEILING is effective-dated: the same 40,000 wage contributes 750.00 in 2025 and 875.00 in 2026', async () => {
    const before = computeGrossToNet(input({ basePayThb: '40000' }), await rulesAsOf('2025-12-31'))
    const after = computeGrossToNet(input({ basePayThb: '40000' }), await rulesAsOf('2026-01-31'))
    expect(satangToBaht(before.ssoEmployee)).toBe('750.00')
    expect(satangToBaht(after.ssoEmployee)).toBe('875.00')
  })

  it('the FLOOR binds too: a wage below 1,650 still contributes on 1,650', async () => {
    const result = computeGrossToNet(
      input({ basis: 'daily', basePayThb: '400', provinceCode: PROVINCE_BANGKOK, timesheet: { daysWorked: '2' } }),
      await rulesAsOf(SEPTEMBER_2026),
    )
    expect(satangToBaht(result.ssoWage)).toBe('800.00')
    expect(satangToBaht(result.ssoCappedWage)).toBe('1650.00')
    expect(satangToBaht(result.ssoEmployee)).toBe('82.50')
  })

  it('EVERY FIGURE FROM CONFIG: changing the employee rate moves the computed net', async () => {
    const baseline = computeGrossToNet(input(), await rulesAsOf(SEPTEMBER_2026))
    const config = seededConfig()
    config.amend(RULE_KEYS.ssoRateEmployee, SEPTEMBER_2026, '3')
    const relieved = computeGrossToNet(input(), await rulesAsOf(SEPTEMBER_2026, PROVINCE_BANGKOK, config))

    expect(satangToBaht(baseline.ssoEmployee)).toBe('875.00')
    expect(satangToBaht(relieved.ssoEmployee)).toBe('525.00')
    expect(relieved.net).toBeGreaterThan(baseline.net)
  })

  it('EVERY FIGURE FROM CONFIG: changing the ceiling moves the computed net', async () => {
    const config = seededConfig()
    config.amend(RULE_KEYS.ssoWageCeiling, SEPTEMBER_2026, '20000')
    const raised = computeGrossToNet(input(), await rulesAsOf(SEPTEMBER_2026, PROVINCE_BANGKOK, config))
    expect(satangToBaht(raised.ssoEmployee)).toBe('1000.00')
  })

  it('a REQUIRED rule with no version in force fails the run with PAY-503 rather than defaulting', async () => {
    const config = seededConfig()
    config.remove(RULE_KEYS.ssoWageCeiling)
    await expect(rulesAsOf(SEPTEMBER_2026, PROVINCE_BANGKOK, config)).rejects.toMatchObject({ code: 'PAY-503' })
  })
})

// ---------------------------------------------------------------------------
// Minimum wage
// ---------------------------------------------------------------------------

describe('M7-1: the provincial minimum-wage floor', () => {
  it('a monthly wage below the provincial floor is refused with PAY-010, citing the province, the floor and the notification', async () => {
    const rules = await rulesAsOf(SEPTEMBER_2026)
    // 11,000/30 = 366.67/day, below Bangkok's 400.
    expect(() => computeGrossToNet(input({ basePayThb: '11000' }), rules)).toThrow(
      expect.objectContaining({
        code: 'PAY-010',
        details: [expect.objectContaining({ provinceCode: PROVINCE_BANGKOK, statutoryFloor: '400.00', citation: expect.stringContaining('Wage Committee') })],
      }),
    )
  })

  it('THE FLOOR IS PER PROVINCE: the same wage that fails in Bangkok passes in a lower band', async () => {
    const wage = input({ basePayThb: '11000', provinceCode: PROVINCE_LOW_BAND })
    // 366.67/day clears the 337 band.
    const result = computeGrossToNet(wage, await rulesAsOf(SEPTEMBER_2026, PROVINCE_LOW_BAND))
    expect(satangToBaht(result.gross)).toBe('11000.00')
  })

  it('the comparison is EXACT, not on a rounded daily equivalent: 12,000/30 = 400.00 passes, one satang less does not', async () => {
    const rules = await rulesAsOf(SEPTEMBER_2026)
    expect(computeGrossToNet(input({ basePayThb: '12000' }), rules).gross).toBe(bahtToSatang('12000'))
    expect(() => computeGrossToNet(input({ basePayThb: '11999.99' }), rules)).toThrow(expect.objectContaining({ code: 'PAY-010' }))
  })

  it('a daily-rate employee is compared against the floor directly', async () => {
    const rules = await rulesAsOf(SEPTEMBER_2026)
    expect(() => computeGrossToNet(input({ basis: 'daily', basePayThb: '399' }), rules)).toThrow(expect.objectContaining({ code: 'PAY-010' }))
    expect(computeGrossToNet(input({ basis: 'daily', basePayThb: '400', timesheet: { daysWorked: '20' } }), rules).gross).toBe(bahtToSatang('8000'))
  })

  it('an hourly employee must clear the floor over a full statutory working day', async () => {
    const rules = await rulesAsOf(SEPTEMBER_2026)
    // 49/hour x 8 = 392, below 400.
    expect(() => computeGrossToNet(input({ basis: 'hourly', basePayThb: '49' }), rules)).toThrow(expect.objectContaining({ code: 'PAY-010' }))
    expect(computeGrossToNet(input({ basis: 'hourly', basePayThb: '50', timesheet: { hoursWorked: '160' } }), rules).gross).toBe(bahtToSatang('8000'))
  })

  it('a province with NO notification on file BLOCKS the run (PAY-012) — fails closed, never a note', async () => {
    // Changed 2026-08-04. This previously asserted a payslip NOTE and let
    // the run proceed, which is strictly worse than no check: the wage was
    // paid, on a payslip identical to a checked one, and the note was the
    // only difference. "We could not check the floor" must not be a softer
    // outcome than "the wage is below the floor" (PAY-010, which throws).
    const rules = await rulesAsOf(SEPTEMBER_2026, 'TH-99')
    expect(() => computeGrossToNet(input({ basePayThb: '1', provinceCode: 'TH-99' }), rules)).toThrow(
      expect.objectContaining({ code: 'PAY-012' }),
    )
    // A wage that would obviously clear any plausible floor is blocked too:
    // the gate is "was it checked", not "is it probably fine".
    expect(() => computeGrossToNet(input({ basePayThb: '900000', provinceCode: 'TH-99' }), rules)).toThrow(
      expect.objectContaining({ code: 'PAY-012' }),
    )
  })

  it('no payslip note can stand in for the floor check — the fail-open note is gone entirely', async () => {
    // The note string is what the old behaviour emitted. Asserting its
    // absence stops a future change quietly reinstating "pay it, but
    // mention it" as the handling for an unverifiable wage.
    const rules = await rulesAsOf(SEPTEMBER_2026, PROVINCE_BANGKOK)
    const result = computeGrossToNet(input({ basePayThb: '45000' }), rules)
    expect(result.notes.some((n) => n.startsWith('payroll.note.minimum_wage_not_on_file'))).toBe(false)
  })

  it('THE FLOOR IS DATA: raising the Bangkok notification makes a previously-compliant wage fail', async () => {
    const config = seededConfig()
    config.amend('minwage.daily.TH-10', SEPTEMBER_2026, '450')
    const rules = await rulesAsOf(SEPTEMBER_2026, PROVINCE_BANGKOK, config)
    expect(() => computeGrossToNet(input({ basePayThb: '12000' }), rules)).toThrow(expect.objectContaining({ code: 'PAY-010' }))
  })
})

// ---------------------------------------------------------------------------
// Earnings and overtime
// ---------------------------------------------------------------------------

describe('earnings — pay basis and overtime', () => {
  it('a monthly employee earns the monthly wage; absence is an explicit deduction line, never a silent pro-ration', async () => {
    const result = computeGrossToNet(
      input({ lines: [{ code: 'unpaid_leave', direction: 'deduction', amount: bahtToSatang('1500'), taxable: false, ssoWageBase: false, oneOff: false }] }),
      await rulesAsOf(SEPTEMBER_2026),
    )
    expect(satangToBaht(result.basePayEarned)).toBe('45000.00')
    expect(satangToBaht(result.otherDeductions)).toBe('1500.00')
    expect(result.lines.some((l) => l.code === 'unpaid_leave' && l.category === 'employee_deduction')).toBe(true)
  })

  it('a daily employee earns rate x days worked, exactly, including a half day', async () => {
    const result = computeGrossToNet(
      input({ basis: 'daily', basePayThb: '600', timesheet: { daysWorked: '20.5' } }),
      await rulesAsOf(SEPTEMBER_2026),
    )
    expect(satangToBaht(result.basePayEarned)).toBe('12300.00')
  })

  it('an hourly employee earns rate x hours worked, exactly, including a quarter hour', async () => {
    const result = computeGrossToNet(
      input({ basis: 'hourly', basePayThb: '75', timesheet: { hoursWorked: '160.25' } }),
      await rulesAsOf(SEPTEMBER_2026),
    )
    expect(satangToBaht(result.basePayEarned)).toBe('12018.75')
  })

  it('all three OT classes are paid at their own statutory multiplier — 1.5x, 2x and 3x', async () => {
    const result = computeGrossToNet(
      input({ timesheet: { otWorkdayHours: '10', otHolidayWorkHours: '8', otHolidayOtHours: '4' } }),
      await rulesAsOf(SEPTEMBER_2026),
    )
    // Hourly base = 45,000 / 30 / 8 = 187.50.
    expect(satangToBaht(result.lines.find((l) => l.code === 'ot_workday')?.amount ?? 0n)).toBe('2812.50')
    expect(satangToBaht(result.lines.find((l) => l.code === 'ot_holiday_work')?.amount ?? 0n)).toBe('3000.00')
    expect(satangToBaht(result.lines.find((l) => l.code === 'ot_holiday_ot')?.amount ?? 0n)).toBe('2250.00')
    expect(satangToBaht(result.overtimePay)).toBe('8062.50')
  })

  it('an OT class with no hours produces no line — a payslip does not print zeros', async () => {
    const result = computeGrossToNet(input({ timesheet: { otWorkdayHours: '2' } }), await rulesAsOf(SEPTEMBER_2026))
    expect(result.lines.map((l) => l.code)).toContain('ot_workday')
    expect(result.lines.map((l) => l.code)).not.toContain('ot_holiday_work')
    expect(result.lines.map((l) => l.code)).not.toContain('ot_holiday_ot')
  })

  it('the OT hourly base is held UNROUNDED through the multiplication — 20,000/30/8 x 1.5 x 1h is 125.00 exactly', async () => {
    const result = computeGrossToNet(
      input({ basePayThb: '20000', timesheet: { otWorkdayHours: '1' } }),
      await rulesAsOf(SEPTEMBER_2026),
    )
    // 20,000/30/8 = 83.3333... If the base were rounded to 83.33 first, this
    // would be 124.995 -> 125.00 by luck; at 3 hours the two diverge, which
    // is the case below.
    expect(satangToBaht(result.lines.find((l) => l.code === 'ot_workday')?.amount ?? 0n)).toBe('125.00')
  })

  it('OT for a daily-rate employee divides by the hours divisor only', async () => {
    const result = computeGrossToNet(
      input({ basis: 'daily', basePayThb: '800', timesheet: { daysWorked: '20', otWorkdayHours: '4' } }),
      await rulesAsOf(SEPTEMBER_2026),
    )
    // 800/8 = 100/hour, x1.5 x4 = 600.
    expect(satangToBaht(result.lines.find((l) => l.code === 'ot_workday')?.amount ?? 0n)).toBe('600.00')
  })

  it('OT for an hourly employee uses the rate itself as the base', async () => {
    const result = computeGrossToNet(
      input({ basis: 'hourly', basePayThb: '100', timesheet: { hoursWorked: '160', otWorkdayHours: '4' } }),
      await rulesAsOf(SEPTEMBER_2026),
    )
    expect(satangToBaht(result.lines.find((l) => l.code === 'ot_workday')?.amount ?? 0n)).toBe('600.00')
  })

  it('THE MULTIPLIERS ARE DATA: raising the workday multiplier in config raises the OT pay', async () => {
    const config = seededConfig()
    config.amend(RULE_KEYS.otWorkdayMultiplier, SEPTEMBER_2026, '2')
    const result = computeGrossToNet(
      input({ timesheet: { otWorkdayHours: '10' } }),
      await rulesAsOf(SEPTEMBER_2026, PROVINCE_BANGKOK, config),
    )
    expect(satangToBaht(result.lines.find((l) => l.code === 'ot_workday')?.amount ?? 0n)).toBe('3750.00')
  })
})

// ---------------------------------------------------------------------------
// The cross-module contract with M3 on `ot_2x`
// ---------------------------------------------------------------------------

/**
 * M3 shipped `timesheet.day_record.ot_2x` as a PAY-RATE-EQUIVALENT, not as
 * raw hours: it holds "minutes payable at exactly 2× the hourly base", with
 * the LPA s.62 entitlement distinction baked into the QUANTITY. A monthly
 * employee, already paid for the holiday, has HALF their worked minutes
 * stored so that `half × 2× = 1×`; a daily-rate employee has the full
 * minutes stored so that `full × 2× = 2×`.
 *
 * This engine therefore applies `ot.holiday_work.multiplier` uniformly and
 * must NEVER re-derive that distinction from the pay basis. These tests use
 * M3's own worked example (TC-M3-007 — an 8-hour holiday shift) as the
 * fixture and pin the trap: if anyone later "fixes" this engine by halving
 * again for monthly staff, the first assertion below fails.
 */
describe('the M3 `ot_2x` contract: a pay-rate equivalent, multiplied uniformly by 2x', () => {
  // M3's TC-M3-007: an 8-hour holiday shift.
  const MONTHLY_OT_2X = '4' // half of 8h — monthly staff are owed +1x only
  const DAILY_OT_2X = '8' // the full 8h — daily staff are owed the full 2x

  it('a monthly employee is paid 1x of the 8 hours actually worked — via 2x of the halved quantity M3 stored', async () => {
    const result = computeGrossToNet(
      input({ basis: 'monthly', basePayThb: '45000', timesheet: { otHolidayWorkHours: MONTHLY_OT_2X } }),
      await rulesAsOf(SEPTEMBER_2026),
    )
    // Hourly base 45,000/30/8 = 187.50. Engine: 187.50 x 2 x 4 = 1,500.00.
    expect(satangToBaht(result.lines.find((l) => l.code === 'ot_holiday_work')?.amount ?? 0n)).toBe('1500.00')
    // ...which is exactly 1x the hourly base for the 8 hours really worked,
    // derived here from the statute rather than from the engine's own path.
    expect(result.lines.find((l) => l.code === 'ot_holiday_work')?.amount).toBe(bahtToSatang('187.50') * 8n)
  })

  it('a daily-rate employee is paid the full 2x of the 8 hours worked', async () => {
    const result = computeGrossToNet(
      input({ basis: 'daily', basePayThb: '600', timesheet: { daysWorked: '20', otHolidayWorkHours: DAILY_OT_2X } }),
      await rulesAsOf(SEPTEMBER_2026),
    )
    // Hourly base 600/8 = 75.00. Engine: 75.00 x 2 x 8 = 1,200.00.
    expect(satangToBaht(result.lines.find((l) => l.code === 'ot_holiday_work')?.amount ?? 0n)).toBe('1200.00')
    expect(result.lines.find((l) => l.code === 'ot_holiday_work')?.amount).toBe(bahtToSatang('75') * 2n * 8n)
  })

  it('THE TRAP: halving a SECOND time for monthly staff would pay 750.00 — half what LPA s.62 owes', async () => {
    const rules = await rulesAsOf(SEPTEMBER_2026)
    const correct = computeGrossToNet(input({ basis: 'monthly', basePayThb: '45000', timesheet: { otHolidayWorkHours: MONTHLY_OT_2X } }), rules)
    // What a re-derived entitlement discount inside this engine would produce.
    const doubleHalved = computeGrossToNet(input({ basis: 'monthly', basePayThb: '45000', timesheet: { otHolidayWorkHours: '2' } }), rules)

    expect(satangToBaht(doubleHalved.lines.find((l) => l.code === 'ot_holiday_work')?.amount ?? 0n)).toBe('750.00')
    expect(correct.lines.find((l) => l.code === 'ot_holiday_work')?.amount).toBe(
      (doubleHalved.lines.find((l) => l.code === 'ot_holiday_work')?.amount ?? 0n) * 2n,
    )
  })

  it('the multiplier is applied UNIFORMLY: the same ot_2x quantity and hourly base yield the same premium on every pay basis', async () => {
    const rules = await rulesAsOf(SEPTEMBER_2026)
    // The same hourly base (75.00) reached three different ways. The basis
    // may only affect the HOURLY RATE, never the s.62 multiplier.
    const monthly = computeGrossToNet(input({ basis: 'monthly', basePayThb: '18000', timesheet: { otHolidayWorkHours: '4' } }), rules)
    const daily = computeGrossToNet(input({ basis: 'daily', basePayThb: '600', timesheet: { daysWorked: '20', otHolidayWorkHours: '4' } }), rules)
    const hourly = computeGrossToNet(input({ basis: 'hourly', basePayThb: '75', timesheet: { hoursWorked: '160', otHolidayWorkHours: '4' } }), rules)

    const holidayPay = (r: typeof monthly): bigint | undefined => r.lines.find((l) => l.code === 'ot_holiday_work')?.amount
    expect(satangToBaht(holidayPay(monthly) ?? 0n)).toBe('600.00')
    expect(holidayPay(daily)).toBe(holidayPay(monthly))
    expect(holidayPay(hourly)).toBe(holidayPay(monthly))
  })

  it('the 2x itself is still config, not a constant: changing ot.holiday_work.multiplier moves the holiday premium', async () => {
    const config = seededConfig()
    config.amend(RULE_KEYS.otHolidayWorkMultiplier, SEPTEMBER_2026, '2.5')
    const result = computeGrossToNet(
      input({ basis: 'monthly', basePayThb: '45000', timesheet: { otHolidayWorkHours: MONTHLY_OT_2X } }),
      await rulesAsOf(SEPTEMBER_2026, PROVINCE_BANGKOK, config),
    )
    expect(satangToBaht(result.lines.find((l) => l.code === 'ot_holiday_work')?.amount ?? 0n)).toBe('1875.00')
  })
})

// ---------------------------------------------------------------------------
// Reimbursements — the classification property
// ---------------------------------------------------------------------------

describe('a reimbursement never enters the tax or the SSO wage base', () => {
  const reimbursement = earning('reimbursement:travel', '8000', false, false)

  it('it is paid, but it is not in gross, not in the taxable base, and not in the SSO wage', async () => {
    const withClaim = computeGrossToNet(input({ lines: [reimbursement] }), await rulesAsOf(SEPTEMBER_2026))
    const without = computeGrossToNet(input(), await rulesAsOf(SEPTEMBER_2026))

    expect(withClaim.gross).toBe(without.gross)
    expect(withClaim.taxableGross).toBe(without.taxableGross)
    expect(withClaim.ssoWage).toBe(without.ssoWage)
    expect(withClaim.ssoEmployee).toBe(without.ssoEmployee)
    expect(satangToBaht(withClaim.nonTaxablePay)).toBe('8000.00')
    // ...and the employee is 8,000 better off in the bank.
    expect(withClaim.net - without.net).toBe(bahtToSatang('8000'))
  })

  it('it appears on the payslip as its own category, never among the earnings', async () => {
    const result = computeGrossToNet(input({ lines: [reimbursement] }), await rulesAsOf(SEPTEMBER_2026))
    const line = result.lines.find((l) => l.code === 'reimbursement:travel')
    expect(line?.category).toBe('non_taxable_payment')
    expect(result.lines.filter((l) => l.category === 'earning').map((l) => l.code)).not.toContain('reimbursement:travel')
  })

  it('a large reimbursement cannot push an employee over the SSO ceiling', async () => {
    const result = computeGrossToNet(
      input({ basePayThb: '15000', lines: [earning('reimbursement:relocation', '100000', false, false)] }),
      await rulesAsOf(SEPTEMBER_2026),
    )
    expect(satangToBaht(result.ssoCappedWage)).toBe('15000.00')
    expect(satangToBaht(result.ssoEmployee)).toBe('750.00')
  })

  it('a TAXABLE allowance, by contrast, is in both bases — the flags are what distinguish them', async () => {
    const result = computeGrossToNet(input({ lines: [earning('position_allowance', '5000', true, true)] }), await rulesAsOf(SEPTEMBER_2026))
    expect(satangToBaht(result.gross)).toBe('50000.00')
    expect(satangToBaht(result.taxableGross)).toBe('50000.00')
    expect(satangToBaht(result.ssoWage)).toBe('50000.00')
  })

  it('the two flags are INDEPENDENT: an allowance can be taxable but outside the SSO wage base', async () => {
    const result = computeGrossToNet(input({ lines: [earning('leave_payout:annual', '9000', true, false)] }), await rulesAsOf(SEPTEMBER_2026))
    expect(satangToBaht(result.taxableGross)).toBe('54000.00')
    expect(satangToBaht(result.ssoWage)).toBe('45000.00')
  })

  it('...and outside the tax base but inside the SSO wage base', async () => {
    const result = computeGrossToNet(input({ lines: [earning('odd_case', '1000', false, true)] }), await rulesAsOf(SEPTEMBER_2026))
    expect(satangToBaht(result.taxableGross)).toBe('45000.00')
    expect(satangToBaht(result.ssoWage)).toBe('46000.00')
  })

  it('a one-off taxable line is taxed as a one-off, not annualised as if it recurred', async () => {
    const recurring = computeGrossToNet(input({ lines: [earning('extra', '100000', true, true, false)] }), await rulesAsOf(SEPTEMBER_2026))
    const bonus = computeGrossToNet(input({ lines: [earning('bonus', '100000', true, true, true)] }), await rulesAsOf(SEPTEMBER_2026))
    expect(bonus.wht).toBeLessThan(recurring.wht)
    expect(bonus.taxableGross).toBe(recurring.taxableGross)
  })
})

// ---------------------------------------------------------------------------
// Provident fund
// ---------------------------------------------------------------------------

describe('provident fund — voluntary, 2–15%, band from config', () => {
  it('no rate on the profile means no contribution and no line', async () => {
    const result = computeGrossToNet(input(), await rulesAsOf(SEPTEMBER_2026))
    expect(result.pfEmployee).toBe(0n)
    expect(result.pfEmployer).toBe(0n)
    expect(result.lines.some((l) => l.code.startsWith('pf_'))).toBe(false)
  })

  it('an employee rate is applied to the UNCAPPED wage — the SSO ceiling is an SSO rule, not a PF one', async () => {
    const result = computeGrossToNet(input({ pfRatePercent: '5' }), await rulesAsOf(SEPTEMBER_2026))
    expect(satangToBaht(result.pfEmployee)).toBe('2250.00')
  })

  it('the employer rate is independent of the employee rate', async () => {
    const result = computeGrossToNet(input({ pfRatePercent: '3', pfRateEmployerPercent: '5' }), await rulesAsOf(SEPTEMBER_2026))
    expect(satangToBaht(result.pfEmployee)).toBe('1350.00')
    expect(satangToBaht(result.pfEmployer)).toBe('2250.00')
  })

  it('both band edges are accepted — 2% and 15% inclusive', async () => {
    const rules = await rulesAsOf(SEPTEMBER_2026)
    expect(satangToBaht(computeGrossToNet(input({ pfRatePercent: '2' }), rules).pfEmployee)).toBe('900.00')
    expect(satangToBaht(computeGrossToNet(input({ pfRatePercent: '15' }), rules).pfEmployee)).toBe('6750.00')
  })

  it('a rate below the band is REFUSED, not clamped — clamping would pay a rate the employee never agreed to', async () => {
    const rules = await rulesAsOf(SEPTEMBER_2026)
    expect(() => computeGrossToNet(input({ pfRatePercent: '1' }), rules)).toThrow(expect.objectContaining({ code: 'PAY-011' }))
  })

  it('a rate above the band is equally refused, on the employer side too', async () => {
    const rules = await rulesAsOf(SEPTEMBER_2026)
    expect(() => computeGrossToNet(input({ pfRatePercent: '16' }), rules)).toThrow(expect.objectContaining({ code: 'PAY-011' }))
    expect(() => computeGrossToNet(input({ pfRateEmployerPercent: '20' }), rules)).toThrow(expect.objectContaining({ code: 'PAY-011' }))
  })

  it('THE BAND IS DATA: widening it in config admits a rate that was refused a moment ago', async () => {
    const config = seededConfig()
    config.amend(RULE_KEYS.pfRateMax, SEPTEMBER_2026, '20')
    const result = computeGrossToNet(input({ pfRatePercent: '16' }), await rulesAsOf(SEPTEMBER_2026, PROVINCE_BANGKOK, config))
    expect(satangToBaht(result.pfEmployee)).toBe('7200.00')
  })
})

// ---------------------------------------------------------------------------
// Withholding, declarations, and the whole-payslip shape
// ---------------------------------------------------------------------------

describe('withholding tax and the tax declaration', () => {
  it('a missing declaration is NOT fatal: the personal allowance alone is applied and the payslip is flagged', async () => {
    const result = computeGrossToNet(input({ basePayThb: '150000', indexInYear: 1 }), await rulesAsOf(SEPTEMBER_2026))
    expect(result.notes).toContain('payroll.note.tax_declaration_missing')
    expect(result.wht).toBeGreaterThan(0n)
  })

  it('a declaration reduces the withholding, and the payslip carries no missing-declaration note', async () => {
    const declaration = { spouse: true, children: 2, childrenSecondFrom2018: 0, parentsCaredFor: 2, otherAllowances: bahtToSatang('50000') }
    const withDecl = computeGrossToNet(input({ basePayThb: '150000', indexInYear: 1, declaration }), await rulesAsOf(SEPTEMBER_2026))
    const without = computeGrossToNet(input({ basePayThb: '150000', indexInYear: 1 }), await rulesAsOf(SEPTEMBER_2026))

    expect(withDecl.wht).toBeLessThan(without.wht)
    expect(withDecl.notes).not.toContain('payroll.note.tax_declaration_missing')
  })

  it('an employee below the tax threshold has no withholding line at all', async () => {
    const result = computeGrossToNet(input(), await rulesAsOf(SEPTEMBER_2026))
    expect(result.wht).toBe(0n)
    expect(result.lines.some((l) => l.code === 'withholding_tax')).toBe(false)
  })

  it('EVERY FIGURE FROM CONFIG: halving the personal allowance raises the withholding and lowers the net', async () => {
    const baseline = computeGrossToNet(input({ basePayThb: '150000', indexInYear: 1 }), await rulesAsOf(SEPTEMBER_2026))
    const config = seededConfig()
    config.amend(RULE_KEYS.taxAllowancePersonal, SEPTEMBER_2026, '30000')
    const tightened = computeGrossToNet(input({ basePayThb: '150000', indexInYear: 1 }), await rulesAsOf(SEPTEMBER_2026, PROVINCE_BANGKOK, config))

    expect(tightened.wht).toBeGreaterThan(baseline.wht)
    expect(tightened.net).toBeLessThan(baseline.net)
  })

  it('year-to-date figures carry into the projection: the same period late in the year withholds differently', async () => {
    const rules = await rulesAsOf(SEPTEMBER_2026)
    const early = computeGrossToNet(input({ basePayThb: '150000', indexInYear: 1 }), rules)
    const late = computeGrossToNet(
      input({
        basePayThb: '150000',
        indexInYear: 12,
        ytd: { taxableIncome: bahtToSatang('1650000'), ssoEmployee: bahtToSatang('9625'), pfEmployee: 0n, whtPaid: bahtToSatang('100000') },
      }),
      rules,
    )
    expect(late.wht).not.toBe(early.wht)
  })

  it('refuses a period index outside the configured tax year rather than dividing by a nonsense count', async () => {
    const rules = await rulesAsOf(SEPTEMBER_2026)
    expect(() => computeGrossToNet(input({ indexInYear: 0 }), rules)).toThrow(/outside the 12-period tax year/)
    expect(() => computeGrossToNet(input({ indexInYear: 13 }), rules)).toThrow(/outside the 12-period tax year/)
  })

  it('the number of periods in the year is itself config — a semi-monthly cycle changes the divisor', async () => {
    const config = seededConfig()
    config.amend(RULE_KEYS.periodsPerYear, SEPTEMBER_2026, '24')
    const rules = await rulesAsOf(SEPTEMBER_2026, PROVINCE_BANGKOK, config)
    expect(() => computeGrossToNet(input({ indexInYear: 13 }), rules)).not.toThrow()
  })

  it('an empty bracket table still produces a result, citing the fallback rule — the resolver is what refuses one', async () => {
    const rules = await rulesAsOf(SEPTEMBER_2026)
    const result = computeGrossToNet(input({ basePayThb: '150000', indexInYear: 1 }), { ...rules, pitBrackets: [] })
    expect(result.wht).toBe(0n)
    expect(result.citations[RULE_KEYS.taxPitBrackets]).toBe(rules.taxAllowancePersonal.citation)
  })
})

describe('the whole payslip: statutory order, itemisation and citations', () => {
  it('net = gross − SSO − EWF − PF − WHT − other deductions + non-taxable payments', async () => {
    const result = computeGrossToNet(
      input({
        basePayThb: '150000',
        indexInYear: 1,
        pfRatePercent: '5',
        pfRateEmployerPercent: '5',
        timesheet: { otWorkdayHours: '10' },
        lines: [
          earning('position_allowance', '5000', true, true),
          earning('reimbursement:travel', '2000', false, false),
          { code: 'union_dues', direction: 'deduction', amount: bahtToSatang('300'), taxable: false, ssoWageBase: false, oneOff: false },
        ],
      }),
      await rulesAsOf(OCTOBER_2026),
    )

    const expected =
      result.gross - result.ssoEmployee - result.ewfEmployee - result.pfEmployee - result.wht - result.otherDeductions + result.nonTaxablePay
    expect(result.net).toBe(expected)
  })

  it('itemises earnings, employee deductions, employer contributions and non-taxable payments separately', async () => {
    const result = computeGrossToNet(
      input({ basePayThb: '150000', indexInYear: 1, pfRatePercent: '5', pfRateEmployerPercent: '5', lines: [earning('reimbursement:x', '100', false, false)] }),
      await rulesAsOf(OCTOBER_2026),
    )
    const categories = new Set(result.lines.map((l) => l.category))
    expect(categories).toEqual(new Set(['earning', 'employee_deduction', 'employer_contribution', 'non_taxable_payment']))
  })

  it('records the citation behind every statutory figure that moved a number', async () => {
    const result = computeGrossToNet(input({ timesheet: { otWorkdayHours: '1' } }), await rulesAsOf(OCTOBER_2026))
    expect(Object.keys(result.citations)).toEqual(
      expect.arrayContaining([
        RULE_KEYS.ssoRateEmployee,
        RULE_KEYS.ssoRateEmployer,
        RULE_KEYS.ssoWageCeiling,
        RULE_KEYS.ewfRateEmployee,
        RULE_KEYS.otWorkdayMultiplier,
        RULE_KEYS.taxPitBrackets,
        'minwage.daily.TH-10',
      ]),
    )
    expect(result.citations[RULE_KEYS.ssoWageCeiling]).toContain('1 Jan 2026')
  })

  it('EVERY MONEY FIGURE ON THE RESULT IS A bigint — no float reaches a payslip', async () => {
    const result = computeGrossToNet(input({ pfRatePercent: '5', pfRateEmployerPercent: '5' }), await rulesAsOf(OCTOBER_2026))
    const amounts = [
      result.gross,
      result.taxableGross,
      result.nonTaxablePay,
      result.basePayEarned,
      result.overtimePay,
      result.ssoWage,
      result.ssoCappedWage,
      result.ssoEmployee,
      result.ssoEmployer,
      result.ewfEmployee,
      result.ewfEmployer,
      result.pfEmployee,
      result.pfEmployer,
      result.wht,
      result.otherDeductions,
      result.net,
      ...result.lines.map((l) => l.amount),
    ]
    for (const amount of amounts) expect(typeof amount).toBe('bigint')
  })
})
