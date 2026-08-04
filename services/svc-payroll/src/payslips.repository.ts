import type { Queryable } from '@gadong/kernel'
import { toBuffer } from './money-crypto'

/**
 * `payroll.payslip` and its `payroll.pay_item` children. EVERY money column
 * on both tables is `bytea` and arrives here already encrypted — this
 * repository has no way to read a figure, by construction.
 *
 * `payslip` carries a UNIQUE (run_id, employee_id) from the Phase 5
 * migration. Without it a half-failed recalculation could leave two
 * payslips for one employee and the bank file would pay them both.
 */

export interface PayslipRow {
  id: string
  runId: string
  employeeId: string
  gross: Buffer
  ssoEmp: Buffer
  ewfEmp: Buffer
  pfEmp: Buffer
  taxWht: Buffer
  net: Buffer
  ytd: Buffer
  pdfRef: Buffer
  ssoEr: Buffer | null
  ewfEr: Buffer | null
  pfEr: Buffer | null
  taxableGross: Buffer | null
  nonTaxablePay: Buffer | null
  lang: string | null
}

export interface NewPayslipRow {
  id: string
  runId: string
  employeeId: string
  gross: Buffer
  ssoEmp: Buffer
  ewfEmp: Buffer
  pfEmp: Buffer
  taxWht: Buffer
  net: Buffer
  ytd: Buffer
  pdfRef: Buffer
  ssoEr: Buffer
  ewfEr: Buffer
  pfEr: Buffer
  taxableGross: Buffer
  nonTaxablePay: Buffer
  lang: string
}

export interface PayItemRow {
  id: string
  payslipId: string
  kind: string
  amount: Buffer
}

function required(row: Record<string, unknown>, column: string): Buffer {
  const buf = toBuffer(row[column])
  if (buf === null) throw new Error(`PayslipsRepository: ${column} is notNull in the schema but came back null`)
  return buf
}

function mapPayslip(row: Record<string, unknown>): PayslipRow {
  return {
    id: String(row['id']),
    runId: String(row['run_id']),
    employeeId: String(row['employee_id']),
    gross: required(row, 'gross'),
    ssoEmp: required(row, 'sso_emp'),
    ewfEmp: required(row, 'ewf_emp'),
    pfEmp: required(row, 'pf_emp'),
    taxWht: required(row, 'tax_wht'),
    net: required(row, 'net'),
    ytd: required(row, 'ytd'),
    pdfRef: required(row, 'pdf_ref'),
    ssoEr: toBuffer(row['sso_er']),
    ewfEr: toBuffer(row['ewf_er']),
    pfEr: toBuffer(row['pf_er']),
    taxableGross: toBuffer(row['taxable_gross']),
    nonTaxablePay: toBuffer(row['non_taxable_pay']),
    lang: row['lang'] === null || row['lang'] === undefined ? null : String(row['lang']),
  }
}

function mapPayItem(row: Record<string, unknown>): PayItemRow {
  const amount = toBuffer(row['amount'])
  if (amount === null) throw new Error('PayslipsRepository: pay_item.amount came back null')
  return { id: String(row['id']), payslipId: String(row['payslip_id']), kind: String(row['kind']), amount }
}

export class PayslipsRepository {
  constructor(private readonly db: Queryable) {}

  async insert(tx: Queryable, row: NewPayslipRow): Promise<PayslipRow> {
    const { rows } = await tx.query(
      `INSERT INTO payroll.payslip (id, run_id, employee_id, gross, sso_emp, ewf_emp, pf_emp, tax_wht, net, ytd, pdf_ref, sso_er, ewf_er, pf_er, taxable_gross, non_taxable_pay, lang)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING *`,
      [
        row.id,
        row.runId,
        row.employeeId,
        row.gross,
        row.ssoEmp,
        row.ewfEmp,
        row.pfEmp,
        row.taxWht,
        row.net,
        row.ytd,
        row.pdfRef,
        row.ssoEr,
        row.ewfEr,
        row.pfEr,
        row.taxableGross,
        row.nonTaxablePay,
        row.lang,
      ],
    )
    const first = rows[0]
    if (first === undefined) throw new Error('PayslipsRepository.insert: INSERT ... RETURNING * returned no row')
    return mapPayslip(first as Record<string, unknown>)
  }

  async insertItem(tx: Queryable, row: PayItemRow): Promise<PayItemRow> {
    const { rows } = await tx.query(
      `INSERT INTO payroll.pay_item (id, payslip_id, kind, amount) VALUES ($1, $2, $3, $4) RETURNING *`,
      [row.id, row.payslipId, row.kind, row.amount],
    )
    const first = rows[0]
    if (first === undefined) throw new Error('PayslipsRepository.insertItem: INSERT ... RETURNING * returned no row')
    return mapPayItem(first as Record<string, unknown>)
  }

  async listByRun(runId: string, db: Queryable = this.db): Promise<PayslipRow[]> {
    const { rows } = await db.query('SELECT * FROM payroll.payslip WHERE run_id = $1 ORDER BY employee_id', [runId])
    return rows.map((r) => mapPayslip(r as Record<string, unknown>))
  }

  async listByEmployee(employeeId: string, db: Queryable = this.db): Promise<PayslipRow[]> {
    const { rows } = await db.query('SELECT * FROM payroll.payslip WHERE employee_id = $1 ORDER BY run_id', [employeeId])
    return rows.map((r) => mapPayslip(r as Record<string, unknown>))
  }

  async findById(id: string, db: Queryable = this.db): Promise<PayslipRow | null> {
    const { rows } = await db.query('SELECT * FROM payroll.payslip WHERE id = $1', [id])
    const first = rows[0]
    return first === undefined ? null : mapPayslip(first as Record<string, unknown>)
  }

  /**
   * Removes a run's payslips and their items so a RECALCULATION replaces
   * them rather than accumulating a second set — which the UNIQUE
   * (run_id, employee_id) would refuse anyway, and which would otherwise
   * pay some employees twice through the bank file.
   *
   * Safe by construction on a committed run: the immutability triggers fire
   * on DELETE too, so this refuses there rather than quietly erasing
   * evidence. `RunsService.calculate` never reaches it on a committed run
   * in any case (PAY-022 fires first) — the two layers agree.
   */
  async deleteByRun(tx: Queryable, runId: string): Promise<number> {
    const existing = await this.listByRun(runId, tx)
    for (const slip of existing) {
      await tx.query('DELETE FROM payroll.pay_item WHERE payslip_id = $1', [slip.id])
    }
    const { rows } = await tx.query('DELETE FROM payroll.payslip WHERE run_id = $1', [runId])
    return rows.length
  }

  async listItems(payslipId: string, db: Queryable = this.db): Promise<PayItemRow[]> {
    const { rows } = await db.query('SELECT * FROM payroll.pay_item WHERE payslip_id = $1 ORDER BY id', [payslipId])
    return rows.map((r) => mapPayItem(r as Record<string, unknown>))
  }
}
