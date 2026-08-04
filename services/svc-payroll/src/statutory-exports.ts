import { formatDate, toBuddhistEra } from '@gadong/kernel'
import { satangToBaht } from './money'
import type { Satang } from './money'
import type { ExportKind } from './exports.repository'

/**
 * M7-6 — the filings an employer actually submits.
 *
 *   monthly  · สปส.1-10  (SSO contribution report, due the 15th following)
 *            · ภ.ง.ด.1  PND 1 withholding data (due the 7th, 15th e-filing)
 *   annual   · ภ.ง.ด.1ก PND 1 Kor summary (end February)
 *            · 50 ทวิ    50 bis certificate, per employee
 *            · คร.11     Kor Ror 11 employment-conditions data pack (January)
 *
 * Submission itself is manual in v1 (PRD Non-Goal 5): this module produces
 * the DATA — a typed row set plus a CSV rendering — which an officer
 * uploads to SSO e-Service or RD e-Filing.
 *
 * ⚠️ COLUMN ORDER AND FIELD NAMES ARE MODELLED FROM THE STATUTORY SPEC'S
 * DESCRIPTIONS, NOT FROM THE GAZETTED FORM LAYOUTS, which are not available
 * to this implementation. §12 V7 already flags the Kor Ror 11 form layout
 * as pending. Every layout here is listed in this module's report as
 * requiring confirmation against the current official form before a real
 * filing. What IS load-bearing and correct regardless of column order: the
 * FIGURES, and specifically which base each figure is drawn from — สปส.1-10
 * reports the SSO-capped wage and never the gross, PND 1 reports the
 * taxable gross and never the total paid, and no reimbursement appears in
 * either.
 *
 * DATES: Thai statutory forms are filed in Buddhist Era. `toBuddhistEra`
 * and `formatDate(iso, 'th')` come from the kernel — the same single
 * implementation the payslips use.
 */

export interface ExportEmployeeLine {
  employeeId: string
  empCode: string | null
  fullName: string
  nationalId: string
  /** The SSO-capped wage — what contributions were actually computed on. */
  ssoWage: Satang
  ssoEmployee: Satang
  ssoEmployer: Satang
  ewfEmployee: Satang
  ewfEmployer: Satang
  /** The PIT base. NOT gross, and never including a reimbursement. */
  taxableGross: Satang
  wht: Satang
  startDate: string | null
  terminationDate: string | null
}

export interface ExportContext {
  runId: string
  period: string
  /** ISO date the figures are as of — the period end. */
  asOf: string
  employerName: string
  employerSsoNumber: string
  employerTaxId: string
  lines: readonly ExportEmployeeLine[]
}

export interface GeneratedExport {
  kind: ExportKind
  filename: string
  /** Machine-readable rows — what an API consumer or a future e-filing integration reads. */
  rows: Array<Record<string, string>>
  /** The same rows rendered as CSV — what an officer uploads today. */
  csv: string
  /** Control totals, which the officer reconciles against the payroll run before filing. */
  totals: Record<string, string>
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

function toCsv(rows: ReadonlyArray<Record<string, string>>, columns: readonly string[]): string {
  const header = columns.join(',')
  const body = rows.map((row) => columns.map((c) => csvCell(row[c] ?? '')).join(','))
  return [header, ...body].join('\n')
}

function sum(lines: readonly ExportEmployeeLine[], pick: (l: ExportEmployeeLine) => Satang): Satang {
  let total = 0n
  for (const line of lines) total += pick(line)
  return total
}

/** สปส.1-10 — the monthly SSO contribution report. Wage column is the CAPPED wage. */
export function buildSso110(ctx: ExportContext): GeneratedExport {
  const columns = ['seq', 'national_id', 'emp_code', 'full_name', 'wage_thb', 'employee_contribution_thb', 'employer_contribution_thb']
  const rows = ctx.lines.map((line, index) => ({
    seq: (index + 1).toString(),
    national_id: line.nationalId,
    emp_code: line.empCode ?? line.employeeId,
    full_name: line.fullName,
    // The capped wage, not gross: reporting gross here would overstate the
    // employer's liability and contradict what was actually remitted.
    wage_thb: satangToBaht(line.ssoWage),
    employee_contribution_thb: satangToBaht(line.ssoEmployee),
    employer_contribution_thb: satangToBaht(line.ssoEmployer),
  }))
  return {
    kind: 'sso_1_10',
    filename: `sps-1-10-${ctx.period}.csv`,
    rows,
    csv: toCsv(rows, columns),
    totals: {
      period_be: `${ctx.period.slice(5)}/${toBuddhistEra(ctx.asOf).toString()}`,
      employer_sso_number: ctx.employerSsoNumber,
      employee_count: ctx.lines.length.toString(),
      total_wage_thb: satangToBaht(sum(ctx.lines, (l) => l.ssoWage)),
      total_employee_thb: satangToBaht(sum(ctx.lines, (l) => l.ssoEmployee)),
      total_employer_thb: satangToBaht(sum(ctx.lines, (l) => l.ssoEmployer)),
    },
  }
}

/** ภ.ง.ด.1 — the monthly withholding return. Income column is the TAXABLE gross. */
export function buildPnd1(ctx: ExportContext): GeneratedExport {
  const columns = ['seq', 'national_id', 'full_name', 'income_type', 'income_thb', 'tax_withheld_thb']
  const rows = ctx.lines.map((line, index) => ({
    seq: (index + 1).toString(),
    national_id: line.nationalId,
    full_name: line.fullName,
    // Revenue Code s.40(1) — income from employment. Reimbursements are
    // not s.40 income and are structurally absent: `taxableGross` never
    // contained them.
    income_type: '40(1)',
    income_thb: satangToBaht(line.taxableGross),
    tax_withheld_thb: satangToBaht(line.wht),
  }))
  return {
    kind: 'pnd1',
    filename: `pnd1-${ctx.period}.csv`,
    rows,
    csv: toCsv(rows, columns),
    totals: {
      period_be: `${ctx.period.slice(5)}/${toBuddhistEra(ctx.asOf).toString()}`,
      employer_tax_id: ctx.employerTaxId,
      employee_count: ctx.lines.length.toString(),
      total_income_thb: satangToBaht(sum(ctx.lines, (l) => l.taxableGross)),
      total_tax_thb: satangToBaht(sum(ctx.lines, (l) => l.wht)),
    },
  }
}

/** ภ.ง.ด.1ก — the annual summary. `ctx.lines` are the year's per-employee totals. */
export function buildPnd1Kor(ctx: ExportContext): GeneratedExport {
  const columns = ['seq', 'national_id', 'full_name', 'annual_income_thb', 'annual_tax_thb', 'sso_contribution_thb']
  const rows = ctx.lines.map((line, index) => ({
    seq: (index + 1).toString(),
    national_id: line.nationalId,
    full_name: line.fullName,
    annual_income_thb: satangToBaht(line.taxableGross),
    annual_tax_thb: satangToBaht(line.wht),
    sso_contribution_thb: satangToBaht(line.ssoEmployee),
  }))
  return {
    kind: 'pnd1kor',
    filename: `pnd1kor-${ctx.period.slice(0, 4)}.csv`,
    rows,
    csv: toCsv(rows, columns),
    totals: {
      tax_year_be: toBuddhistEra(ctx.asOf).toString(),
      employer_tax_id: ctx.employerTaxId,
      employee_count: ctx.lines.length.toString(),
      total_income_thb: satangToBaht(sum(ctx.lines, (l) => l.taxableGross)),
      total_tax_thb: satangToBaht(sum(ctx.lines, (l) => l.wht)),
    },
  }
}

/** 50 ทวิ — one withholding certificate per employee. Issued in Thai, so the year is Buddhist Era. */
export function buildFiftyBis(ctx: ExportContext): GeneratedExport {
  const columns = [
    'national_id',
    'full_name',
    'employer_tax_id',
    'employer_name',
    'tax_year_be',
    'income_thb',
    'tax_withheld_thb',
    'sso_contribution_thb',
    'issued_on_be',
  ]
  const issuedOn = formatDate(ctx.asOf, 'th')
  const rows = ctx.lines.map((line) => ({
    national_id: line.nationalId,
    full_name: line.fullName,
    employer_tax_id: ctx.employerTaxId,
    employer_name: ctx.employerName,
    tax_year_be: toBuddhistEra(ctx.asOf).toString(),
    income_thb: satangToBaht(line.taxableGross),
    tax_withheld_thb: satangToBaht(line.wht),
    sso_contribution_thb: satangToBaht(line.ssoEmployee),
    issued_on_be: issuedOn,
  }))
  return {
    kind: '50bis',
    filename: `50bis-${ctx.period.slice(0, 4)}.csv`,
    rows,
    csv: toCsv(rows, columns),
    totals: { certificate_count: ctx.lines.length.toString(), tax_year_be: toBuddhistEra(ctx.asOf).toString() },
  }
}

/**
 * คร.11 — the annual employment-conditions report (Statutory Spec §10, a
 * standing obligation submitted each January). §12 V7 flags the current
 * form layout as unconfirmed, so this produces the DATA PACK the PRD asks
 * for: headcount and employment facts from master data, not a rendering of
 * a form nobody has verified.
 */
export function buildKorRor11(ctx: ExportContext): GeneratedExport {
  const columns = ['emp_code', 'full_name', 'start_date_be', 'termination_date_be', 'status']
  const rows = ctx.lines.map((line) => ({
    emp_code: line.empCode ?? line.employeeId,
    full_name: line.fullName,
    start_date_be: line.startDate === null ? '' : formatDate(line.startDate, 'th'),
    termination_date_be: line.terminationDate === null ? '' : formatDate(line.terminationDate, 'th'),
    status: line.terminationDate === null ? 'active' : 'terminated',
  }))
  const active = rows.filter((r) => r.status === 'active').length
  return {
    kind: 'kor_ror_11',
    filename: `kor-ror-11-${ctx.period.slice(0, 4)}.csv`,
    rows,
    csv: toCsv(rows, columns),
    totals: {
      report_year_be: toBuddhistEra(ctx.asOf).toString(),
      employer_name: ctx.employerName,
      headcount_total: rows.length.toString(),
      headcount_active: active.toString(),
    },
  }
}

export const EXPORT_BUILDERS = {
  sso_1_10: buildSso110,
  pnd1: buildPnd1,
  pnd1kor: buildPnd1Kor,
  '50bis': buildFiftyBis,
  kor_ror_11: buildKorRor11,
} as const

export type StatutoryExportKind = keyof typeof EXPORT_BUILDERS

export function isStatutoryExportKind(value: string): value is StatutoryExportKind {
  return Object.prototype.hasOwnProperty.call(EXPORT_BUILDERS, value)
}
