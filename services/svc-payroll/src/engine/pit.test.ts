import { bahtToSatang, satangToBaht } from '../money'
import { StatutoryResolver } from '../statutory'
import type { TaxBracket } from '../statutory'
import { seededConfig } from '../testing/statutory-fixture'
import { annualisedWithholding, progressiveTax } from './pit'

/**
 * PIT — every bracket boundary, on BOTH sides, and the annualised method.
 *
 * The brackets are loaded from the same fixture rule pack the engine loads
 * from in every other test, through the real `StatutoryResolver`. No
 * bracket is written into this file as an expectation of what the engine
 * "should" contain; the expectations are TAX AMOUNTS, computed from the
 * statutory table in `docs/02-statutory/THAILAND-STATUTORY-RULES-SPEC.md`
 * §9 by hand.
 */

async function brackets(): Promise<TaxBracket[]> {
  return new StatutoryResolver(seededConfig(), '2026-06-30').pitBrackets()
}

describe('progressiveTax — every bracket edge, both sides', () => {
  /**
   * The statutory table is written "0 – 150,000: 0%" then "150,001 –
   * 300,000: 5%". So income of EXACTLY 150,000 pays nothing, and 150,001
   * pays 5% of one baht — not 5% of 150,001. Marginal accumulation gives
   * that for free; a banded lookup would get it catastrophically wrong.
   */
  const cases: Array<[string, string, string]> = [
    ['bottom of the 0% band', '0', '0.00'],
    ['top of the 0% band — exactly 150,000 pays nothing', '150000', '0.00'],
    ['one baht into the 5% band', '150001', '0.05'],
    ['top of the 5% band', '300000', '7500.00'],
    ['one baht into the 10% band', '300001', '7500.10'],
    ['top of the 10% band', '500000', '27500.00'],
    ['one baht into the 15% band', '500001', '27500.15'],
    ['top of the 15% band', '750000', '65000.00'],
    ['one baht into the 20% band', '750001', '65000.20'],
    ['top of the 20% band', '1000000', '115000.00'],
    ['one baht into the 25% band', '1000001', '115000.25'],
    ['top of the 25% band', '2000000', '365000.00'],
    ['one baht into the 30% band', '2000001', '365000.30'],
    ['top of the 30% band', '5000000', '1265000.00'],
    ['one baht into the open-ended 35% band', '5000001', '1265000.35'],
    ['well into the 35% band', '10000000', '3015000.00'],
  ]

  it.each(cases)('%s: net annual %s THB -> %s THB tax', async (_label, income, expected) => {
    expect(satangToBaht(progressiveTax(bahtToSatang(income), await brackets()))).toBe(expected)
  })

  it('a negative net annual income is floored at zero, never a negative tax', async () => {
    expect(progressiveTax(bahtToSatang('-500000'), await brackets())).toBe(0n)
  })

  it('an empty bracket table produces no tax rather than throwing — the resolver is what refuses one', () => {
    expect(progressiveTax(bahtToSatang('1000000'), [])).toBe(0n)
  })

  it('the brackets are DATA: raising the top rate in config raises the tax on the same income', async () => {
    const config = seededConfig()
    const before = progressiveTax(bahtToSatang('6000000'), await new StatutoryResolver(config, '2026-06-30').pitBrackets())

    const amended = seededConfig()
    amended.amend('tax.pit.brackets', '2026-06-30', [
      { upTo: '150000', rate: '0' },
      { upTo: null, rate: '35' },
    ])
    const after = progressiveTax(bahtToSatang('6000000'), await new StatutoryResolver(amended, '2026-06-30').pitBrackets())

    expect(after).toBeGreaterThan(before)
  })
})

describe('progressiveTax — bracket table integrity is enforced, not assumed', () => {
  it('a table arriving out of order is sorted before use, so a mis-ordered pack cannot silently mis-tax', async () => {
    const config = seededConfig()
    config.amend('tax.pit.brackets', '2026-06-30', [
      { upTo: null, rate: '35' },
      { upTo: '300000', rate: '5' },
      { upTo: '150000', rate: '0' },
    ])
    const sorted = await new StatutoryResolver(config, '2026-06-30').pitBrackets()
    expect(sorted.map((b) => (b.upTo === null ? 'open' : satangToBaht(b.upTo)))).toEqual(['150000.00', '300000.00', 'open'])
    expect(satangToBaht(progressiveTax(bahtToSatang('300000'), sorted))).toBe('7500.00')
  })

  it('a table with no open-ended top bracket is refused — income above the last edge would otherwise go untaxed', async () => {
    const config = seededConfig()
    config.amend('tax.pit.brackets', '2026-06-30', [{ upTo: '150000', rate: '0' }])
    await expect(new StatutoryResolver(config, '2026-06-30').pitBrackets()).rejects.toMatchObject({ code: 'PAY-504' })
  })

  it('a table with two open-ended brackets is refused', async () => {
    const config = seededConfig()
    config.amend('tax.pit.brackets', '2026-06-30', [
      { upTo: null, rate: '30' },
      { upTo: null, rate: '35' },
    ])
    await expect(new StatutoryResolver(config, '2026-06-30').pitBrackets()).rejects.toMatchObject({ code: 'PAY-504' })
  })

  it('an entry with no rate is refused rather than defaulted to zero', async () => {
    const config = seededConfig()
    config.amend('tax.pit.brackets', '2026-06-30', [{ upTo: '150000' }, { upTo: null, rate: '35' }])
    await expect(new StatutoryResolver(config, '2026-06-30').pitBrackets()).rejects.toMatchObject({ code: 'PAY-504' })
  })

  it('a non-array value is refused', async () => {
    const config = seededConfig()
    config.amend('tax.pit.brackets', '2026-06-30', '35%')
    await expect(new StatutoryResolver(config, '2026-06-30').pitBrackets()).rejects.toMatchObject({ code: 'PAY-504' })
  })
})

describe('annualisedWithholding — the Revenue Department method', () => {
  async function baseInput(overrides: Partial<Parameters<typeof annualisedWithholding>[0]> = {}) {
    return {
      recurringTaxableThisPeriod: bahtToSatang('100000'),
      oneOffTaxableThisPeriod: 0n,
      ytdTaxableIncome: 0n,
      ytdSsoEmployee: 0n,
      ssoEmployeeThisPeriod: bahtToSatang('875'),
      ytdPfEmployee: 0n,
      pfEmployeeThisPeriod: 0n,
      ytdWhtPaid: 0n,
      remainingPeriods: 12n,
      expenseRate: { num: 50n, den: 100n },
      expenseCap: bahtToSatang('100000'),
      personalAllowance: bahtToSatang('60000'),
      spouseAllowance: bahtToSatang('60000'),
      childAllowance: bahtToSatang('30000'),
      childSecondAllowance: bahtToSatang('60000'),
      parentalCareAllowance: bahtToSatang('30000'),
      brackets: await brackets(),
      spouse: false,
      children: 0,
      childrenSecondFrom2018: 0,
      parentsCaredFor: 0,
      declaredOtherAllowances: 0n,
      ...overrides,
    }
  }

  it('annualises: 100,000/month over 12 remaining periods projects 1,200,000', async () => {
    const out = annualisedWithholding(await baseInput())
    expect(satangToBaht(out.projectedAnnualIncome)).toBe('1200000.00')
    // Expense deduction is 50% capped at 100,000 — the cap binds here.
    expect(satangToBaht(out.expenseDeduction)).toBe('100000.00')
    // 60,000 personal + 875 x 12 SSO.
    expect(satangToBaht(out.totalAllowances)).toBe('70500.00')
    expect(satangToBaht(out.netAnnualIncome)).toBe('1029500.00')
    // 115,000 + 25% of 29,500 = 122,375.
    expect(satangToBaht(out.annualTax)).toBe('122375.00')
    expect(satangToBaht(out.wht)).toBe('10197.92')
  })

  it('the expense CAP binds only above 200,000 projected income; below it the 50% rate governs', async () => {
    const out = annualisedWithholding(await baseInput({ recurringTaxableThisPeriod: bahtToSatang('10000') }))
    expect(satangToBaht(out.projectedAnnualIncome)).toBe('120000.00')
    expect(satangToBaht(out.expenseDeduction)).toBe('60000.00')
  })

  it('a one-off (bonus) is added ONCE, not multiplied across the remaining periods', async () => {
    const withoutBonus = annualisedWithholding(await baseInput())
    const withBonus = annualisedWithholding(await baseInput({ oneOffTaxableThisPeriod: bahtToSatang('100000') }))
    expect(withBonus.projectedAnnualIncome - withoutBonus.projectedAnnualIncome).toBe(bahtToSatang('100000'))
  })

  it('declared allowances reduce the tax — and each one moves it independently', async () => {
    const none = annualisedWithholding(await baseInput())
    const spouse = annualisedWithholding(await baseInput({ spouse: true }))
    const children = annualisedWithholding(await baseInput({ children: 2 }))
    const second = annualisedWithholding(await baseInput({ childrenSecondFrom2018: 1 }))
    const parents = annualisedWithholding(await baseInput({ parentsCaredFor: 2 }))
    const other = annualisedWithholding(await baseInput({ declaredOtherAllowances: bahtToSatang('100000') }))

    expect(spouse.annualTax).toBeLessThan(none.annualTax)
    expect(children.annualTax).toBeLessThan(none.annualTax)
    expect(second.annualTax).toBeLessThan(none.annualTax)
    expect(parents.annualTax).toBeLessThan(none.annualTax)
    expect(other.annualTax).toBeLessThan(none.annualTax)
    // 2 x 30,000 children vs 1 x 60,000 second-child: equal allowance, equal tax.
    expect(children.annualTax).toEqual(second.annualTax)
  })

  it('provident-fund contributions are deductible and annualised alongside SSO', async () => {
    const withoutPf = annualisedWithholding(await baseInput())
    const withPf = annualisedWithholding(await baseInput({ pfEmployeeThisPeriod: bahtToSatang('5000') }))
    expect(withPf.totalAllowances - withoutPf.totalAllowances).toBe(bahtToSatang('60000'))
  })

  it('only the UNWITHHELD balance is spread — tax already paid this year is credited', async () => {
    const fresh = annualisedWithholding(await baseInput())
    const partway = annualisedWithholding(await baseInput({ ytdWhtPaid: bahtToSatang('50000') }))
    expect(partway.wht).toBeLessThan(fresh.wht)
  })

  it('an over-withheld employee is never paid back through a NEGATIVE deduction — that refund is the annual filing\'s job', async () => {
    const out = annualisedWithholding(await baseInput({ ytdWhtPaid: bahtToSatang('999999') }))
    expect(out.wht).toBe(0n)
  })

  it('in the final period the whole remaining liability lands, undivided', async () => {
    const out = annualisedWithholding(await baseInput({ remainingPeriods: 1n, ytdTaxableIncome: bahtToSatang('1100000') }))
    expect(out.wht).toBe(out.annualTax)
  })

  it('refuses a period outside the tax year rather than dividing by zero', async () => {
    await expect(async () => annualisedWithholding(await baseInput({ remainingPeriods: 0n }))).rejects.toThrow(/remainingPeriods/)
  })

  it('income below every allowance produces zero tax, not a negative net annual income', async () => {
    const out = annualisedWithholding(await baseInput({ recurringTaxableThisPeriod: bahtToSatang('1000') }))
    expect(out.netAnnualIncome).toBe(0n)
    expect(out.annualTax).toBe(0n)
    expect(out.wht).toBe(0n)
  })
})
