import { unsupportedBankFormat } from './errors'
import { satangToBaht } from './money'
import type { Satang } from './money'
import type { ExportKind } from './exports.repository'

/**
 * M7-5 — net-pay transfer files. Samuel confirmed all four Thai bank
 * formats (KBank, SCB, BBL, Krungsri) plus a generic CSV; the PRD's floor
 * was a generic template and two banks, so this is the agreed wider scope.
 *
 * ⚠️ THE FIELD LAYOUTS BELOW ARE NOT VERIFIED AGAINST THE BANKS' OWN
 * HOST-TO-HOST SPECIFICATIONS. Each Thai bank publishes its payroll file
 * layout to corporate customers under agreement, and none of those
 * documents is available to this implementation. What is implemented here
 * is: the correct SHAPE (fixed-width record vs delimited, header/detail/
 * trailer, amount encoding, control totals), driven by a per-format
 * descriptor so that correcting a field position is a one-line change to a
 * table rather than a rewrite. Every format is listed in this module's
 * report as requiring confirmation against the bank's current specification
 * before a real disbursement. Shipping a plausible-looking file that a bank
 * silently rejects is a failed payroll run; shipping one the bank ACCEPTS
 * with a misplaced amount field is worse.
 *
 * AMOUNTS ARE ENCODED FROM `bigint` SATANG. Thai bank payroll formats
 * conventionally carry the amount as an integer count of satang with no
 * decimal point, zero-padded — which is exactly the representation this
 * engine already holds, so the file is produced without a float ever
 * existing.
 */

export interface BankTransferLine {
  employeeId: string
  empCode: string | null
  accountName: string
  bankCode: string
  accountNumber: string
  netPay: Satang
}

export interface BankFileRequest {
  runId: string
  period: string
  payDate: string
  /** The employer's own account the transfer debits. */
  originatorAccount: string
  originatorName: string
  lines: readonly BankTransferLine[]
}

export interface BankFileResult {
  kind: ExportKind
  filename: string
  content: string
  /** Sum of every net-pay line — the control total the bank reconciles against. */
  totalSatang: Satang
  recordCount: number
}

export const BANK_FORMATS = ['generic', 'kbank', 'scb', 'bbl', 'krungsri'] as const
export type BankFormat = (typeof BANK_FORMATS)[number]

const KIND_BY_FORMAT: Record<BankFormat, ExportKind> = {
  generic: 'bank_csv',
  kbank: 'bank_kbank',
  scb: 'bank_scb',
  bbl: 'bank_bbl',
  krungsri: 'bank_krungsri',
}

function isBankFormat(value: string): value is BankFormat {
  return (BANK_FORMATS as readonly string[]).includes(value)
}

/** Satang as an unpadded integer string — no decimal point, no float. */
function satangDigits(amount: Satang): string {
  if (amount < 0n) throw new Error('bank file: a net-pay line cannot be negative — refusing to emit a transfer that would debit an employee')
  return amount.toString()
}

function pad(value: string, width: number, char = ' '): string {
  return value.length >= width ? value.slice(0, width) : value + char.repeat(width - value.length)
}

function padLeft(value: string, width: number, char = '0'): string {
  return value.length >= width ? value.slice(-width) : char.repeat(width - value.length) + value
}

function totals(lines: readonly BankTransferLine[]): { total: Satang; count: number } {
  let total = 0n
  for (const line of lines) total += line.netPay
  return { total, count: lines.length }
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/**
 * The generic CSV. This is the one format whose layout this codebase
 * actually defines, so it is also the fallback a customer uses while their
 * bank's template is being confirmed. Amounts are written as decimal baht
 * here (rather than satang digits) because the file is read by humans and
 * by finance systems, not by a fixed-width parser.
 */
function buildGeneric(req: BankFileRequest): BankFileResult {
  const { total, count } = totals(req.lines)
  const rows = [
    ['employee_code', 'account_name', 'bank_code', 'account_number', 'amount_thb', 'pay_date', 'reference'].join(','),
    ...req.lines.map((l) =>
      [
        csvCell(l.empCode ?? l.employeeId),
        csvCell(l.accountName),
        csvCell(l.bankCode),
        csvCell(l.accountNumber),
        satangToBaht(l.netPay),
        req.payDate,
        csvCell(`${req.period}/${req.runId}`),
      ].join(','),
    ),
  ]
  return { kind: 'bank_csv', filename: `payroll-${req.period}-generic.csv`, content: rows.join('\n'), totalSatang: total, recordCount: count }
}

/**
 * A fixed-width descriptor per bank. Keeping the four bank formats as DATA
 * — record type marker, field widths, header/trailer shape — rather than
 * four hand-written builders is what makes correcting an unverified layout
 * a table edit instead of a rewrite.
 */
interface FixedWidthSpec {
  format: BankFormat
  headerCode: string
  detailCode: string
  trailerCode: string
  accountWidth: number
  nameWidth: number
  amountWidth: number
  refWidth: number
  extension: string
}

const FIXED_WIDTH_SPECS: Record<Exclude<BankFormat, 'generic'>, FixedWidthSpec> = {
  kbank: { format: 'kbank', headerCode: 'H', detailCode: 'D', trailerCode: 'T', accountWidth: 15, nameWidth: 40, amountWidth: 15, refWidth: 20, extension: 'txt' },
  scb: { format: 'scb', headerCode: '01', detailCode: '02', trailerCode: '03', accountWidth: 11, nameWidth: 50, amountWidth: 15, refWidth: 18, extension: 'txt' },
  bbl: { format: 'bbl', headerCode: 'HDR', detailCode: 'DTL', trailerCode: 'TLR', accountWidth: 10, nameWidth: 40, amountWidth: 13, refWidth: 20, extension: 'txt' },
  krungsri: { format: 'krungsri', headerCode: 'H', detailCode: 'D', trailerCode: 'E', accountWidth: 10, nameWidth: 40, amountWidth: 15, refWidth: 20, extension: 'txt' },
}

function buildFixedWidth(spec: FixedWidthSpec, req: BankFileRequest): BankFileResult {
  const { total, count } = totals(req.lines)
  const compactDate = req.payDate.replace(/-/g, '')

  const header = [
    spec.headerCode,
    padLeft(req.originatorAccount, spec.accountWidth),
    pad(req.originatorName, spec.nameWidth),
    compactDate,
    padLeft(count.toString(), 6),
    padLeft(satangDigits(total), spec.amountWidth),
  ].join('')

  const details = req.lines.map((line) =>
    [
      spec.detailCode,
      padLeft(line.accountNumber, spec.accountWidth),
      pad(line.accountName, spec.nameWidth),
      padLeft(satangDigits(line.netPay), spec.amountWidth),
      pad(line.empCode ?? line.employeeId, spec.refWidth),
      compactDate,
    ].join(''),
  )

  // Control totals in the trailer are what let the bank detect a truncated
  // upload — the failure mode where half a company gets paid.
  const trailer = [spec.trailerCode, padLeft(count.toString(), 6), padLeft(satangDigits(total), spec.amountWidth)].join('')

  return {
    kind: KIND_BY_FORMAT[spec.format],
    filename: `payroll-${req.period}-${spec.format}.${spec.extension}`,
    content: [header, ...details, trailer].join('\n'),
    totalSatang: total,
    recordCount: count,
  }
}

export function buildBankFile(format: string, req: BankFileRequest): BankFileResult {
  if (!isBankFormat(format)) throw unsupportedBankFormat(format, BANK_FORMATS)
  if (format === 'generic') return buildGeneric(req)
  return buildFixedWidth(FIXED_WIDTH_SPECS[format], req)
}
