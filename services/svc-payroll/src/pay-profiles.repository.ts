import type { Queryable } from '@gadong/kernel'
import { toBuffer } from './money-crypto'
import type { PayBasis } from './engine/types'

/**
 * `payroll.pay_profile` — M7-1's pay structure. Amounts leave and enter
 * this repository as CIPHERTEXT (`Buffer`); it never sees a plaintext
 * salary, and never calls `svc-crypto` itself. `PayProfilesService` owns
 * that boundary, for the same reason `svc-leave`'s repositories never touch
 * `CryptoClient`: a repository that could decrypt is a repository that
 * could log a salary.
 */

/** A recurring earning or deduction from the profile. Amounts live in `pay_item`-shaped ciphertext on the row, so the jsonb carries the amount as a plain decimal STRING that the service encrypts per period — never a float. */
export interface RecurringItem {
  code: string
  direction: 'earning' | 'deduction'
  /** Plain decimal baht string. */
  amountThb: string
  taxable: boolean
  ssoWageBase: boolean
}

export interface PayProfileRow {
  id: string
  employeeId: string
  basePay: Buffer
  payBasis: PayBasis
  recurringItems: RecurringItem[]
  pfRate: Buffer | null
  pfRateEmployer: Buffer | null
  taxAllowanceDecl: Buffer | null
  bankCode: string | null
  bankAccount: Buffer | null
  bankAccountName: Buffer | null
}

export interface NewPayProfileRow {
  id: string
  employeeId: string
  basePay: Buffer
  payBasis: PayBasis
  recurringItems: RecurringItem[]
  pfRate: Buffer | null
  pfRateEmployer: Buffer | null
  taxAllowanceDecl: Buffer | null
  bankCode: string | null
  bankAccount: Buffer | null
  bankAccountName: Buffer | null
}

function mapRow(row: Record<string, unknown>): PayProfileRow {
  const basePay = toBuffer(row['base_pay'])
  if (basePay === null) throw new Error('PayProfilesRepository: base_pay is notNull in the schema but came back null')
  const items = row['recurring_items']
  return {
    id: String(row['id']),
    employeeId: String(row['employee_id']),
    basePay,
    payBasis: row['pay_basis'] as PayBasis,
    recurringItems: Array.isArray(items) ? (items as RecurringItem[]) : [],
    pfRate: toBuffer(row['pf_rate']),
    pfRateEmployer: toBuffer(row['pf_rate_employer']),
    taxAllowanceDecl: toBuffer(row['tax_allowance_decl']),
    bankCode: row['bank_code'] === null || row['bank_code'] === undefined ? null : String(row['bank_code']),
    bankAccount: toBuffer(row['bank_account']),
    bankAccountName: toBuffer(row['bank_account_name']),
  }
}

export class PayProfilesRepository {
  constructor(private readonly db: Queryable) {}

  async insert(tx: Queryable, row: NewPayProfileRow): Promise<PayProfileRow> {
    const { rows } = await tx.query(
      `INSERT INTO payroll.pay_profile (id, employee_id, base_pay, pay_basis, recurring_items, pf_rate, pf_rate_employer, tax_allowance_decl, bank_code, bank_account, bank_account_name)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [
        row.id,
        row.employeeId,
        row.basePay,
        row.payBasis,
        JSON.stringify(row.recurringItems),
        row.pfRate,
        row.pfRateEmployer,
        row.taxAllowanceDecl,
        row.bankCode,
        row.bankAccount,
        row.bankAccountName,
      ],
    )
    const first = rows[0]
    if (first === undefined) throw new Error('PayProfilesRepository.insert: INSERT ... RETURNING * returned no row')
    return mapRow(first as Record<string, unknown>)
  }

  async update(tx: Queryable, row: NewPayProfileRow): Promise<PayProfileRow | null> {
    const { rows } = await tx.query(
      `UPDATE payroll.pay_profile SET base_pay = $2, pay_basis = $3, recurring_items = $4::jsonb, pf_rate = $5, pf_rate_employer = $6, tax_allowance_decl = $7, bank_code = $8, bank_account = $9, bank_account_name = $10 WHERE id = $1 RETURNING *`,
      [
        row.id,
        row.basePay,
        row.payBasis,
        JSON.stringify(row.recurringItems),
        row.pfRate,
        row.pfRateEmployer,
        row.taxAllowanceDecl,
        row.bankCode,
        row.bankAccount,
        row.bankAccountName,
      ],
    )
    const first = rows[0]
    return first === undefined ? null : mapRow(first as Record<string, unknown>)
  }

  async findByEmployee(employeeId: string, db: Queryable = this.db): Promise<PayProfileRow | null> {
    const { rows } = await db.query('SELECT * FROM payroll.pay_profile WHERE employee_id = $1', [employeeId])
    const first = rows[0]
    return first === undefined ? null : mapRow(first as Record<string, unknown>)
  }

  async listAll(db: Queryable = this.db): Promise<PayProfileRow[]> {
    const { rows } = await db.query('SELECT * FROM payroll.pay_profile ORDER BY employee_id')
    return rows.map((r) => mapRow(r as Record<string, unknown>))
  }
}
