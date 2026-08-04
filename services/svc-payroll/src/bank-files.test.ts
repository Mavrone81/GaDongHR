import { bahtToSatang, satangToBaht } from './money'
import { BANK_FORMATS, buildBankFile } from './bank-files'
import type { BankFileRequest } from './bank-files'

/**
 * M7-5 — the four confirmed Thai bank formats plus the generic CSV.
 *
 * These tests assert the properties that are true regardless of whether a
 * bank's field positions turn out to be exactly as modelled: the amounts
 * are right, the control totals reconcile, nothing is a float, and a
 * negative net is refused rather than emitted. The LAYOUTS themselves are
 * flagged in this module's report as requiring confirmation against each
 * bank's host-to-host specification before a real disbursement.
 */

function request(overrides: Partial<BankFileRequest> = {}): BankFileRequest {
  return {
    runId: 'run-1',
    period: '2026-10',
    payDate: '2026-10-31',
    originatorAccount: '9876543210',
    originatorName: 'BEVORA THAILAND',
    lines: [
      { employeeId: 'emp-1', empCode: 'E-0001', accountName: 'SOMCHAI J', bankCode: 'KBANK', accountNumber: '1234567890', netPay: bahtToSatang('44081.25') },
      { employeeId: 'emp-2', empCode: 'E-0002', accountName: 'MALEE S', bankCode: 'KBANK', accountNumber: '2234567890', netPay: bahtToSatang('28500.00') },
    ],
    ...overrides,
  }
}

describe('all five formats are supported and each maps to its own export kind', () => {
  it.each([...BANK_FORMATS])('%s builds a non-empty file with the right control totals', (format) => {
    const out = buildBankFile(format, request())
    expect(out.content.length).toBeGreaterThan(0)
    expect(out.recordCount).toBe(2)
    expect(satangToBaht(out.totalSatang)).toBe('72581.25')
  })

  it('the four bank kinds are distinct, and distinct from the generic CSV', () => {
    const kinds = BANK_FORMATS.map((f) => buildBankFile(f, request()).kind)
    expect(new Set(kinds).size).toBe(BANK_FORMATS.length)
    expect(kinds).toEqual(expect.arrayContaining(['bank_csv', 'bank_kbank', 'bank_scb', 'bank_bbl', 'bank_krungsri']))
  })

  it('an unknown format is refused with PAY-051, naming what IS supported', () => {
    expect(() => buildBankFile('citibank', request())).toThrow(
      expect.objectContaining({ code: 'PAY-051', details: [expect.objectContaining({ format: 'citibank' })] }),
    )
  })
})

describe('generic CSV', () => {
  it('carries a header row and one row per employee, with amounts in decimal baht', () => {
    const out = buildBankFile('generic', request())
    const rows = out.content.split('\n')
    expect(rows[0]).toBe('employee_code,account_name,bank_code,account_number,amount_thb,pay_date,reference')
    expect(rows[1]).toBe('E-0001,SOMCHAI J,KBANK,1234567890,44081.25,2026-10-31,2026-10/run-1')
    expect(rows).toHaveLength(3)
  })

  it('quotes a field containing a comma rather than corrupting the row', () => {
    const out = buildBankFile('generic', request({ lines: [{ employeeId: 'e', empCode: 'E-1', accountName: 'SMITH, JOHN', bankCode: 'SCB', accountNumber: '1', netPay: 100n }] }))
    expect(out.content).toContain('"SMITH, JOHN"')
  })

  it('falls back to the employee id when there is no employee code', () => {
    const out = buildBankFile('generic', request({ lines: [{ employeeId: 'emp-9', empCode: null, accountName: 'X', bankCode: 'BBL', accountNumber: '1', netPay: 100n }] }))
    expect(out.content).toContain('emp-9')
  })
})

describe('fixed-width bank formats', () => {
  it.each(['kbank', 'scb', 'bbl', 'krungsri'])('%s emits header, one detail per employee, and a trailer', (format) => {
    const lines = buildBankFile(format, request()).content.split('\n')
    expect(lines).toHaveLength(4)
  })

  it('every record of one format is the same length — the property a fixed-width parser depends on', () => {
    const lines = buildBankFile('kbank', request()).content.split('\n')
    const details = lines.slice(1, -1)
    expect(new Set(details.map((l) => l.length)).size).toBe(1)
  })

  it('amounts are integer SATANG DIGITS — no decimal point, no float, zero-padded', () => {
    const detail = buildBankFile('kbank', request()).content.split('\n')[1] ?? ''
    // 44,081.25 THB = 4,408,125 satang, padded to the format's amount width.
    expect(detail).toContain('4408125'.padStart(15, '0'))
    expect(detail).not.toContain('.')
  })

  it('the trailer carries the record count and the control total the bank reconciles against', () => {
    const out = buildBankFile('bbl', request())
    const trailer = out.content.split('\n').at(-1) ?? ''
    expect(trailer.startsWith('TLR')).toBe(true)
    expect(trailer).toContain('000002')
    expect(trailer).toContain('7258125'.padStart(13, '0'))
  })

  it('the header total equals the sum of the details — a truncated upload is detectable', () => {
    const out = buildBankFile('scb', request())
    const header = out.content.split('\n')[0] ?? ''
    expect(header).toContain('7258125'.padStart(15, '0'))
    expect(header).toContain('20261031')
  })

  it('an over-long account name is truncated to the field width rather than shifting every field after it', () => {
    const out = buildBankFile('bbl', request({ lines: [{ employeeId: 'e', empCode: 'E-1', accountName: 'A'.repeat(200), bankCode: 'BBL', accountNumber: '1', netPay: 100n }] }))
    const detail = out.content.split('\n')[1] ?? ''
    // BBL detail = 3 (code) + 10 (account) + 40 (name) + 13 (amount) + 20 (ref) + 8 (date).
    expect(detail.length).toBe(94)
    expect(detail).not.toContain('A'.repeat(41))
  })

  it('an empty run still produces a well-formed file with zero totals — nothing to pay is not an error', () => {
    const out = buildBankFile('krungsri', request({ lines: [] }))
    expect(out.recordCount).toBe(0)
    expect(out.totalSatang).toBe(0n)
    expect(out.content.split('\n')).toHaveLength(2)
  })

  it('REFUSES a negative net-pay line — a transfer file must never debit an employee', () => {
    expect(() => buildBankFile('kbank', request({ lines: [{ employeeId: 'e', empCode: 'E', accountName: 'X', bankCode: 'K', accountNumber: '1', netPay: -1n }] }))).toThrow(
      /never debit|cannot be negative/,
    )
  })

  it('the filename names the period and the format, so two runs cannot overwrite each other', () => {
    expect(buildBankFile('scb', request()).filename).toBe('payroll-2026-10-scb.txt')
    expect(buildBankFile('generic', request()).filename).toBe('payroll-2026-10-generic.csv')
  })
})
