import { formatDate, formatTHB } from '@gadong/kernel'
import type { Locale } from '@gadong/kernel'
import type { Satang } from './money'
import type { ComputedLine, GrossToNetResult } from './engine/types'

/**
 * M7-4 — the payslip, itemised, in the employee's language, with Buddhist
 * Era dates on Thai payslips.
 *
 * Both localisation rules come from `@gadong/kernel`'s `i18n/format`, not
 * from a second implementation here. `formatDate(iso, 'th')` renders พ.ศ.
 * (C.E. + 543); `'en'` and `'zh'` render the stored Gregorian year
 * unchanged. `formatTHB` splits `bigint` satang into baht and satang at the
 * very last step. The roadmap makes this explicit — "Buddhist Era rendering
 * and THB formatting come from `@gadong/kernel`'s `i18n/format`, not a
 * second implementation" — and the reason is that a payslip is a legal
 * document: two implementations of a calendar conversion is two chances to
 * date one wrongly.
 *
 * NOTHING IS ROUNDED BEFORE THIS FILE. The engine works in satang
 * throughout; rendering is where a figure first becomes a string, exactly
 * once.
 */

export type PayslipLocale = Locale

/** Falls back to English for any language the formatter does not know, rather than throwing on a payslip. */
export function toLocale(lang: string | null): PayslipLocale {
  if (lang === 'th' || lang === 'en' || lang === 'zh') return lang
  return 'en'
}

export interface RenderedLine {
  code: string
  amount: string
}

export interface PayslipYearToDate {
  taxableIncome: Satang
  ssoEmployee: Satang
  pfEmployee: Satang
  whtPaid: Satang
  net: Satang
}

export interface PayslipView {
  payslipId: string
  employeeId: string
  empCode: string | null
  period: string
  lang: PayslipLocale
  periodStart: string
  periodEnd: string
  payDate: string
  earnings: RenderedLine[]
  employeeDeductions: RenderedLine[]
  employerContributions: RenderedLine[]
  nonTaxablePayments: RenderedLine[]
  gross: string
  taxableGross: string
  totalDeductions: string
  net: string
  ytd: {
    taxableIncome: string
    ssoEmployee: string
    pfEmployee: string
    whtPaid: string
    net: string
  }
  notes: string[]
  citations: Record<string, string>
}

function linesOf(lines: readonly ComputedLine[], category: ComputedLine['category'], locale: PayslipLocale): RenderedLine[] {
  return lines.filter((l) => l.category === category).map((l) => ({ code: l.code, amount: formatTHB(l.amount, locale) }))
}

export interface BuildPayslipViewInput {
  payslipId: string
  employeeId: string
  empCode: string | null
  period: string
  periodStart: string
  periodEnd: string
  payDate: string
  lang: string | null
  result: GrossToNetResult
  ytd: PayslipYearToDate
}

export function buildPayslipView(input: BuildPayslipViewInput): PayslipView {
  const locale = toLocale(input.lang)
  const totalDeductions =
    input.result.ssoEmployee + input.result.ewfEmployee + input.result.pfEmployee + input.result.wht + input.result.otherDeductions

  return {
    payslipId: input.payslipId,
    employeeId: input.employeeId,
    empCode: input.empCode,
    period: input.period,
    lang: locale,
    // Buddhist Era on Thai payslips; Gregorian on English and Chinese —
    // decided entirely by the kernel formatter.
    periodStart: formatDate(input.periodStart, locale),
    periodEnd: formatDate(input.periodEnd, locale),
    payDate: formatDate(input.payDate, locale),
    earnings: linesOf(input.result.lines, 'earning', locale),
    employeeDeductions: linesOf(input.result.lines, 'employee_deduction', locale),
    employerContributions: linesOf(input.result.lines, 'employer_contribution', locale),
    nonTaxablePayments: linesOf(input.result.lines, 'non_taxable_payment', locale),
    gross: formatTHB(input.result.gross, locale),
    taxableGross: formatTHB(input.result.taxableGross, locale),
    totalDeductions: formatTHB(totalDeductions, locale),
    net: formatTHB(input.result.net, locale),
    ytd: {
      taxableIncome: formatTHB(input.ytd.taxableIncome, locale),
      ssoEmployee: formatTHB(input.ytd.ssoEmployee, locale),
      pfEmployee: formatTHB(input.ytd.pfEmployee, locale),
      whtPaid: formatTHB(input.ytd.whtPaid, locale),
      net: formatTHB(input.ytd.net, locale),
    },
    notes: input.result.notes,
    citations: input.result.citations,
  }
}

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c)
}

function section(title: string, lines: readonly RenderedLine[]): string {
  if (lines.length === 0) return ''
  const rows = lines
    .map((l) => `<tr><td class="code" data-i18n="payslip.line.${escapeHtml(l.code)}">${escapeHtml(l.code)}</td><td class="amount">${escapeHtml(l.amount)}</td></tr>`)
    .join('')
  return `<section class="${escapeHtml(title)}"><table>${rows}</table></section>`
}

/**
 * The HTML `svc-docs` turns into a PDF (Sarabun for Thai, Noto Sans SC for
 * Chinese, per the roadmap's font contract). Line labels carry `data-i18n`
 * keys rather than translated strings: this service does not own the
 * wording, `svc-i18n` does, and a payslip with hard-coded Thai in it is
 * exactly the thing that has to be rewritten later.
 */
export function renderPayslipHtml(view: PayslipView): string {
  return [
    `<article class="payslip" lang="${escapeHtml(view.lang)}" data-payslip-id="${escapeHtml(view.payslipId)}">`,
    `<header><h1 data-i18n="payslip.title">payslip.title</h1>`,
    `<p class="period">${escapeHtml(view.periodStart)} — ${escapeHtml(view.periodEnd)}</p>`,
    `<p class="pay-date" data-i18n="payslip.pay_date">${escapeHtml(view.payDate)}</p></header>`,
    section('earnings', view.earnings),
    section('employee-deductions', view.employeeDeductions),
    section('non-taxable-payments', view.nonTaxablePayments),
    section('employer-contributions', view.employerContributions),
    `<footer><p class="gross" data-i18n="payslip.gross">${escapeHtml(view.gross)}</p>`,
    `<p class="deductions" data-i18n="payslip.deductions">${escapeHtml(view.totalDeductions)}</p>`,
    `<p class="net" data-i18n="payslip.net">${escapeHtml(view.net)}</p>`,
    `<p class="ytd" data-i18n="payslip.ytd">${escapeHtml(view.ytd.taxableIncome)} / ${escapeHtml(view.ytd.whtPaid)} / ${escapeHtml(view.ytd.net)}</p></footer>`,
    `</article>`,
  ].join('')
}
