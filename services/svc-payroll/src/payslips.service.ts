import { CryptoClient, formatDate, formatTHB } from '@gadong/kernel'
import type { Queryable } from '@gadong/kernel'
import { payslipNotFound } from './errors'
import type { Satang } from './money'
import { PayslipsRepository } from './payslips.repository'
import type { PayslipRow } from './payslips.repository'
import { RunsRepository } from './runs.repository'
import { decryptMoney, decryptText } from './money-crypto'
import { toLocale } from './payslip-render'
import type { PayslipLocale } from './payslip-render'

/**
 * M7-4's read side: the in-app e-payslip.
 *
 * Two properties this file exists to keep true:
 *
 *  1. EVERY FIGURE IS DECRYPTED WITH A STATED PURPOSE. `svc-crypto` records
 *     it against the S3 read; the kernel client refuses a blank one before
 *     the transport is touched. An employee viewing their own payslip and
 *     an officer viewing someone else's are different purposes, and the
 *     audit trail says which happened.
 *  2. FORMATTING IS THE LAST STEP AND HAPPENS ONCE. Amounts stay `bigint`
 *     satang until `formatTHB`; dates render through `formatDate`, so a
 *     Thai payslip shows Buddhist Era and an English or Chinese one shows
 *     the stored Gregorian year — from the kernel's single implementation,
 *     never a second one here.
 */

export interface PayslipLine {
  kind: string
  amount: string
}

export interface PayslipSummary {
  payslipId: string
  runId: string
  employeeId: string
  period: string
  lang: PayslipLocale
  payDate: string | null
  gross: string
  taxableGross: string
  nonTaxablePay: string
  ssoEmployee: string
  ssoEmployer: string
  ewfEmployee: string
  ewfEmployer: string
  pfEmployee: string
  pfEmployer: string
  wht: string
  net: string
  /** The MinIO object key of the rendered PDF. S3, so reading it is audited like any other figure. */
  pdfRef: string
  lines: PayslipLine[]
}

const SELF_PURPOSE = 'payslip.read.self'
const ANY_PURPOSE = 'payslip.read.any'

export class PayslipsService {
  constructor(
    private readonly payslips: PayslipsRepository,
    private readonly runs: RunsRepository,
    private readonly crypto: CryptoClient,
  ) {}

  async listForRun(runId: string, db: Queryable): Promise<PayslipSummary[]> {
    const rows = await this.payslips.listByRun(runId, db)
    const out: PayslipSummary[] = []
    for (const row of rows) out.push(await this.summarise(row, null, ANY_PURPOSE, db))
    return out
  }

  /** `langOverride` lets an employee read their own payslip in another language without re-rendering the PDF; `null` keeps the language it was issued in. */
  async listForEmployee(employeeId: string, langOverride: string | null, db: Queryable): Promise<PayslipSummary[]> {
    const rows = await this.payslips.listByEmployee(employeeId, db)
    const out: PayslipSummary[] = []
    for (const row of rows) out.push(await this.summarise(row, langOverride, SELF_PURPOSE, db))
    return out
  }

  async getOne(payslipId: string, purpose: string, db: Queryable): Promise<PayslipSummary> {
    const row = await this.payslips.findById(payslipId, db)
    if (row === null) throw payslipNotFound(payslipId)
    return this.summarise(row, null, purpose, db)
  }

  private async summarise(row: PayslipRow, langOverride: string | null, purpose: string, db: Queryable): Promise<PayslipSummary> {
    const locale = toLocale(langOverride ?? row.lang)
    const run = await this.runs.findById(row.runId, db)

    const money = async (field: string, buf: Buffer | null): Promise<Satang> =>
      buf === null ? 0n : decryptMoney(this.crypto, row.id, field, buf, purpose)

    const items = await this.payslips.listItems(row.id, db)
    const lines: PayslipLine[] = []
    for (const item of items) {
      lines.push({ kind: item.kind, amount: formatTHB(await decryptMoney(this.crypto, item.id, 'amount', item.amount, purpose), locale) })
    }

    return {
      payslipId: row.id,
      runId: row.runId,
      employeeId: row.employeeId,
      period: run?.period ?? '',
      lang: locale,
      payDate: run?.payDate === undefined || run.payDate === null ? null : formatDate(run.payDate.slice(0, 10), locale),
      gross: formatTHB(await money('gross', row.gross), locale),
      taxableGross: formatTHB(await money('taxable_gross', row.taxableGross), locale),
      nonTaxablePay: formatTHB(await money('non_taxable_pay', row.nonTaxablePay), locale),
      ssoEmployee: formatTHB(await money('sso_emp', row.ssoEmp), locale),
      ssoEmployer: formatTHB(await money('sso_er', row.ssoEr), locale),
      ewfEmployee: formatTHB(await money('ewf_emp', row.ewfEmp), locale),
      ewfEmployer: formatTHB(await money('ewf_er', row.ewfEr), locale),
      pfEmployee: formatTHB(await money('pf_emp', row.pfEmp), locale),
      pfEmployer: formatTHB(await money('pf_er', row.pfEr), locale),
      wht: formatTHB(await money('tax_wht', row.taxWht), locale),
      net: formatTHB(await money('net', row.net), locale),
      pdfRef: await decryptText(this.crypto, row.id, 'pdf_ref', row.pdfRef, purpose),
      lines,
    }
  }
}
