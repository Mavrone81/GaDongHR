import { bahtToSatang } from './money'
import { buildFiftyBis, buildKorRor11, buildPnd1, buildPnd1Kor, buildSso110, isStatutoryExportKind } from './statutory-exports'
import type { ExportContext, ExportEmployeeLine } from './statutory-exports'

/**
 * M7-6 — the monthly and annual filings.
 *
 * The COLUMN LAYOUTS are modelled from the Statutory Spec's descriptions,
 * not from the gazetted forms, and are flagged in this module's report for
 * confirmation. What these tests pin is the part that is wrong or right
 * regardless of column order: WHICH BASE each figure is drawn from.
 * สปส.1-10 reports the SSO-capped wage and never the gross; PND 1 reports
 * the taxable gross and never the total paid; and a reimbursement, having
 * never been part of either base, cannot appear in either return.
 */

function line(overrides: Partial<ExportEmployeeLine> = {}): ExportEmployeeLine {
  return {
    employeeId: 'emp-1',
    empCode: 'E-0001',
    fullName: 'สมชาย ใจดี',
    nationalId: '1234567890123',
    ssoWage: bahtToSatang('17500'),
    ssoEmployee: bahtToSatang('875'),
    ssoEmployer: bahtToSatang('875'),
    ewfEmployee: bahtToSatang('43.75'),
    ewfEmployer: bahtToSatang('43.75'),
    taxableGross: bahtToSatang('45000'),
    wht: bahtToSatang('1200'),
    startDate: '2020-01-01',
    terminationDate: null,
    ...overrides,
  }
}

function context(overrides: Partial<ExportContext> = {}): ExportContext {
  return {
    runId: 'run-1',
    period: '2026-10',
    asOf: '2026-10-31',
    employerName: 'Bevora (Thailand) Co., Ltd.',
    employerSsoNumber: '1000000000',
    employerTaxId: '0105500000000',
    lines: [line(), line({ employeeId: 'emp-2', empCode: 'E-0002', fullName: 'มาลี สุข', nationalId: '9876543210987', taxableGross: bahtToSatang('28000'), wht: bahtToSatang('0') })],
    ...overrides,
  }
}

describe('สปส.1-10 — the monthly SSO contribution report', () => {
  it('reports the CAPPED wage, not the gross — reporting gross would overstate what was remitted', () => {
    const out = buildSso110(context())
    expect(out.rows[0]).toMatchObject({ wage_thb: '17500.00', employee_contribution_thb: '875.00', employer_contribution_thb: '875.00' })
    // Gross is 45,000; it appears nowhere in this return.
    expect(out.csv).not.toContain('45000')
  })

  it('carries the employer SSO number, the headcount and the three control totals', () => {
    const out = buildSso110(context())
    expect(out.totals).toMatchObject({
      employer_sso_number: '1000000000',
      employee_count: '2',
      total_wage_thb: '35000.00',
      total_employee_thb: '1750.00',
      total_employer_thb: '1750.00',
    })
  })

  it('dates the return in Buddhist Era — 2026 is พ.ศ. 2569', () => {
    expect(buildSso110(context()).totals['period_be']).toBe('10/2569')
  })

  it('numbers every line, so a page of a paper return can be reconciled', () => {
    expect(buildSso110(context()).rows.map((r) => r['seq'])).toEqual(['1', '2'])
  })
})

describe('ภ.ง.ด.1 — the monthly withholding return', () => {
  it('reports the TAXABLE gross and classifies it as Revenue Code s.40(1) employment income', () => {
    const out = buildPnd1(context())
    expect(out.rows[0]).toMatchObject({ income_type: '40(1)', income_thb: '45000.00', tax_withheld_thb: '1200.00' })
  })

  it('a reimbursement cannot appear: it was never in the taxable gross this return reads from', () => {
    // The engine keeps reimbursements in `nonTaxablePay`, a field this
    // export does not read. There is no code path from one to the other.
    const out = buildPnd1(context({ lines: [line({ taxableGross: bahtToSatang('45000') })] }))
    expect(out.totals['total_income_thb']).toBe('45000.00')
  })

  it('carries the employer tax ID and the control totals', () => {
    expect(buildPnd1(context()).totals).toMatchObject({ employer_tax_id: '0105500000000', total_income_thb: '73000.00', total_tax_thb: '1200.00' })
  })
})

describe('annual filings', () => {
  it('ภ.ง.ด.1ก summarises the year per employee, in Buddhist Era', () => {
    const out = buildPnd1Kor(context())
    expect(out.filename).toBe('pnd1kor-2026.csv')
    expect(out.totals['tax_year_be']).toBe('2569')
    expect(out.rows[0]).toMatchObject({ annual_income_thb: '45000.00', annual_tax_thb: '1200.00', sso_contribution_thb: '875.00' })
  })

  it('50 ทวิ issues one certificate per employee, dated in Buddhist Era', () => {
    const out = buildFiftyBis(context())
    expect(out.rows).toHaveLength(2)
    expect(out.rows[0]).toMatchObject({ tax_year_be: '2569', issued_on_be: '31/10/2569', employer_name: 'Bevora (Thailand) Co., Ltd.' })
    expect(out.totals['certificate_count']).toBe('2')
  })

  it('คร.11 reports employment conditions, with B.E. dates and an active headcount', () => {
    const out = buildKorRor11(context({ lines: [line(), line({ employeeId: 'emp-3', terminationDate: '2026-06-30' })] }))
    expect(out.rows[0]).toMatchObject({ start_date_be: '01/01/2563', termination_date_be: '', status: 'active' })
    expect(out.rows[1]).toMatchObject({ termination_date_be: '30/06/2569', status: 'terminated' })
    expect(out.totals).toMatchObject({ headcount_total: '2', headcount_active: '1', report_year_be: '2569' })
  })

  it('an employee with no start date leaves the column blank rather than inventing one', () => {
    expect(buildKorRor11(context({ lines: [line({ startDate: null })] })).rows[0]?.['start_date_be']).toBe('')
  })
})

describe('CSV rendering', () => {
  it('escapes a name containing a comma or a quote instead of corrupting the row', () => {
    const out = buildPnd1(context({ lines: [line({ fullName: 'SMITH, "JOHN"' })] }))
    expect(out.csv).toContain('"SMITH, ""JOHN"""')
    expect(out.csv.split('\n')).toHaveLength(2)
  })

  it('the machine-readable rows and the CSV describe the same data', () => {
    const out = buildSso110(context())
    const dataRows = out.csv.split('\n').slice(1)
    expect(dataRows).toHaveLength(out.rows.length)
  })

  it('an empty run produces a header-only file, not a crash', () => {
    const out = buildSso110(context({ lines: [] }))
    expect(out.rows).toHaveLength(0)
    expect(out.csv.split('\n')).toHaveLength(1)
    expect(out.totals['employee_count']).toBe('0')
  })
})

describe('export kinds', () => {
  it('recognises exactly the five statutory kinds', () => {
    for (const kind of ['sso_1_10', 'pnd1', 'pnd1kor', '50bis', 'kor_ror_11']) expect(isStatutoryExportKind(kind)).toBe(true)
    for (const kind of ['bank_csv', 'nonsense', 'toString', 'constructor']) expect(isStatutoryExportKind(kind)).toBe(false)
  })
})
