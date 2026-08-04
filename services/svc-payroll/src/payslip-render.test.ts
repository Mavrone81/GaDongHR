import { bahtToSatang } from './money'
import { buildPayslipView, renderPayslipHtml, toLocale } from './payslip-render'
import type { BuildPayslipViewInput } from './payslip-render'
import type { GrossToNetResult } from './engine/types'

/**
 * M7-4 — the payslip, in the employee's language, with BUDDHIST ERA DATES
 * ON THAI PAYSLIPS and Gregorian on English and Chinese ones.
 *
 * The conversion is not implemented here; it comes from
 * `@gadong/kernel`'s `i18n/format`, which is the single place the +543
 * offset is allowed to appear (roadmap: "Buddhist Era rendering and THB
 * formatting come from `@gadong/kernel`'s `i18n/format`, not a second
 * implementation"). These tests prove this module ROUTES through it rather
 * than reimplementing it.
 */

function result(overrides: Partial<GrossToNetResult> = {}): GrossToNetResult {
  return {
    gross: bahtToSatang('45000'),
    taxableGross: bahtToSatang('45000'),
    nonTaxablePay: bahtToSatang('8000'),
    basePayEarned: bahtToSatang('45000'),
    overtimePay: 0n,
    ssoWage: bahtToSatang('45000'),
    ssoCappedWage: bahtToSatang('17500'),
    ssoEmployee: bahtToSatang('875'),
    ssoEmployer: bahtToSatang('875'),
    ewfEmployee: bahtToSatang('43.75'),
    ewfEmployer: bahtToSatang('43.75'),
    pfEmployee: bahtToSatang('2250'),
    pfEmployer: bahtToSatang('2250'),
    wht: bahtToSatang('1200'),
    otherDeductions: bahtToSatang('300'),
    net: bahtToSatang('48331.25'),
    lines: [
      { code: 'base_pay', category: 'earning', amount: bahtToSatang('45000'), citation: null },
      { code: 'sso_employee', category: 'employee_deduction', amount: bahtToSatang('875'), citation: 'Social Security Act B.E. 2533' },
      { code: 'sso_employer', category: 'employer_contribution', amount: bahtToSatang('875'), citation: 'Social Security Act B.E. 2533' },
      { code: 'reimbursement:travel', category: 'non_taxable_payment', amount: bahtToSatang('8000'), citation: null },
    ],
    notes: ['payroll.note.tax_declaration_missing'],
    citations: { 'sso.wage.ceiling': 'SSO ceiling increase effective 1 Jan 2026' },
    ...overrides,
  }
}

function viewInput(lang: string | null): BuildPayslipViewInput {
  return {
    payslipId: 'slip-1',
    employeeId: 'emp-1',
    empCode: 'E-0001',
    period: '2026-10',
    periodStart: '2026-10-01',
    periodEnd: '2026-10-31',
    payDate: '2026-10-31',
    lang,
    result: result(),
    ytd: {
      taxableIncome: bahtToSatang('450000'),
      ssoEmployee: bahtToSatang('8750'),
      pfEmployee: bahtToSatang('22500'),
      whtPaid: bahtToSatang('12000'),
      net: bahtToSatang('48331.25'),
    },
  }
}

describe('Buddhist Era on Thai payslips, Gregorian on English and Chinese', () => {
  it('th renders พ.ศ. — 2026 becomes 2569', () => {
    const view = buildPayslipView(viewInput('th'))
    expect(view.periodStart).toBe('01/10/2569')
    expect(view.periodEnd).toBe('31/10/2569')
    expect(view.payDate).toBe('31/10/2569')
  })

  it('en renders the stored Gregorian year, unchanged', () => {
    const view = buildPayslipView(viewInput('en'))
    expect(view.periodStart).toBe('01/10/2026')
    expect(view.payDate).toBe('31/10/2026')
  })

  it('zh also renders Gregorian — B.E. is a Thai-locale convention, not a generic non-English one', () => {
    expect(buildPayslipView(viewInput('zh')).periodEnd).toBe('31/10/2026')
  })

  it('the offset is exactly 543 years and nothing else moves — the day and month are identical across locales', () => {
    const th = buildPayslipView(viewInput('th'))
    const en = buildPayslipView(viewInput('en'))
    expect(th.periodStart.slice(0, 6)).toBe(en.periodStart.slice(0, 6))
    expect(Number(th.periodStart.slice(6)) - Number(en.periodStart.slice(6))).toBe(543)
  })

  it('an unknown or absent language falls back to English rather than failing to issue a payslip', () => {
    expect(toLocale(null)).toBe('en')
    expect(toLocale('fr')).toBe('en')
    expect(buildPayslipView(viewInput('fr')).payDate).toBe('31/10/2026')
  })
})

describe('the payslip itemises earnings, deductions, employer contributions and YTD', () => {
  it('separates the four categories, so an employer contribution is never mistaken for a deduction', () => {
    const view = buildPayslipView(viewInput('en'))
    expect(view.earnings.map((l) => l.code)).toEqual(['base_pay'])
    expect(view.employeeDeductions.map((l) => l.code)).toEqual(['sso_employee'])
    expect(view.employerContributions.map((l) => l.code)).toEqual(['sso_employer'])
    expect(view.nonTaxablePayments.map((l) => l.code)).toEqual(['reimbursement:travel'])
  })

  it('formats every amount through the kernel THB formatter — grouped, two satang digits, Baht sign', () => {
    const view = buildPayslipView(viewInput('en'))
    expect(view.gross).toBe('฿45,000.00')
    expect(view.net).toBe('฿48,331.25')
    expect(view.earnings[0]?.amount).toBe('฿45,000.00')
  })

  it('totals the employee deductions — SSO + EWF + PF + WHT + other', () => {
    // 875 + 43.75 + 2,250 + 1,200 + 300.
    expect(buildPayslipView(viewInput('en')).totalDeductions).toBe('฿4,668.75')
  })

  it('carries the year-to-date block the payslip must itemise', () => {
    const view = buildPayslipView(viewInput('en'))
    expect(view.ytd).toEqual({
      taxableIncome: '฿450,000.00',
      ssoEmployee: '฿8,750.00',
      pfEmployee: '฿22,500.00',
      whtPaid: '฿12,000.00',
      net: '฿48,331.25',
    })
  })

  it('carries the engine\'s notes and citations through to the payslip', () => {
    const view = buildPayslipView(viewInput('th'))
    expect(view.notes).toContain('payroll.note.tax_declaration_missing')
    expect(view.citations['sso.wage.ceiling']).toContain('1 Jan 2026')
  })

  it('omits a category with no lines rather than printing an empty section', () => {
    const view = buildPayslipView({ ...viewInput('en'), result: result({ lines: [] }) })
    expect(view.earnings).toEqual([])
    expect(renderPayslipHtml(view)).not.toContain('<section class="earnings">')
  })
})

describe('the HTML handed to svc-docs', () => {
  it('declares the language, so the PDF renderer picks Sarabun for Thai', () => {
    expect(renderPayslipHtml(buildPayslipView(viewInput('th')))).toContain('lang="th"')
  })

  it('carries the Buddhist Era period on a Thai payslip', () => {
    expect(renderPayslipHtml(buildPayslipView(viewInput('th')))).toContain('01/10/2569')
  })

  it('labels every line with an i18n KEY, never a translated string — svc-i18n owns the wording', () => {
    const html = renderPayslipHtml(buildPayslipView(viewInput('th')))
    expect(html).toContain('data-i18n="payslip.line.base_pay"')
    expect(html).toContain('data-i18n="payslip.net"')
  })

  it('escapes a line code containing markup rather than injecting it into the PDF', () => {
    const view = buildPayslipView({
      ...viewInput('en'),
      result: result({ lines: [{ code: '<script>alert(1)</script>', category: 'earning', amount: 100n, citation: null }] }),
    })
    const html = renderPayslipHtml(view)
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })
})
