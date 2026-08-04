import type { Queryable } from '@gadong/kernel'
import { toBuffer } from './money-crypto'

/**
 * `payroll.pay_input` — the queue of amounts payable or deductible in a
 * period that did not come from the pay profile: one-off manual items,
 * unused-leave payouts from `leave.balance_payout`, expense reimbursements
 * from `claim.approved_for_payroll`, and the severance / notice-in-lieu
 * lines a final-pay run generates.
 *
 * `taxable` and `ssoWageBase` are stored PER ROW, notNull, with no default.
 * The engine reads them; it never re-derives a classification from `kind`.
 * That is the mechanism by which a reimbursement cannot enter the tax or
 * SSO wage base — the flags travel with the money from the producing event
 * all the way to the payslip.
 */

export type PayInputSource = 'manual' | 'leave_payout' | 'claim_reimbursement' | 'severance' | 'notice_in_lieu'

export interface PayInputRow {
  id: string
  employeeId: string
  period: string
  source: PayInputSource
  sourceRef: string | null
  kind: string
  amount: Buffer
  taxable: boolean
  ssoWageBase: boolean
  direction: 'earning' | 'deduction'
  meta: Record<string, unknown>
  consumedRunId: string | null
}

export type NewPayInputRow = Omit<PayInputRow, 'consumedRunId'>

function mapRow(row: Record<string, unknown>): PayInputRow {
  const amount = toBuffer(row['amount'])
  if (amount === null) throw new Error('PayInputsRepository: amount is notNull in the schema but came back null')
  const meta = row['meta']
  return {
    id: String(row['id']),
    employeeId: String(row['employee_id']),
    period: String(row['period']),
    source: row['source'] as PayInputSource,
    sourceRef: row['source_ref'] === null || row['source_ref'] === undefined ? null : String(row['source_ref']),
    kind: String(row['kind']),
    amount,
    taxable: Boolean(row['taxable']),
    ssoWageBase: Boolean(row['sso_wage_base']),
    direction: row['direction'] as 'earning' | 'deduction',
    meta: typeof meta === 'object' && meta !== null ? (meta as Record<string, unknown>) : {},
    consumedRunId: row['consumed_run_id'] === null || row['consumed_run_id'] === undefined ? null : String(row['consumed_run_id']),
  }
}

export class PayInputsRepository {
  constructor(private readonly db: Queryable) {}

  async insert(tx: Queryable, row: NewPayInputRow): Promise<PayInputRow> {
    const { rows } = await tx.query(
      `INSERT INTO payroll.pay_input (id, employee_id, period, source, source_ref, kind, amount, taxable, sso_wage_base, direction, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb) RETURNING *`,
      [
        row.id,
        row.employeeId,
        row.period,
        row.source,
        row.sourceRef,
        row.kind,
        row.amount,
        row.taxable,
        row.ssoWageBase,
        row.direction,
        JSON.stringify(row.meta),
      ],
    )
    const first = rows[0]
    if (first === undefined) throw new Error('PayInputsRepository.insert: INSERT ... RETURNING * returned no row')
    return mapRow(first as Record<string, unknown>)
  }

  async markConsumed(tx: Queryable, id: string, runId: string): Promise<void> {
    await tx.query('UPDATE payroll.pay_input SET consumed_run_id = $2 WHERE id = $1 RETURNING *', [id, runId])
  }

  /**
   * Returns a run's consumed inputs to the outstanding queue. Called when a
   * draft/calculated run is RECALCULATED: without it the second calculation
   * would see the inputs as already paid and silently drop a reimbursement
   * or a leave payout from the payslip it is about to replace.
   */
  async releaseConsumedBy(tx: Queryable, runId: string, period: string): Promise<number> {
    const rows = await this.listByPeriod(period, tx)
    const mine = rows.filter((r) => r.consumedRunId === runId)
    for (const row of mine) {
      await tx.query('UPDATE payroll.pay_input SET consumed_run_id = $2 WHERE id = $1 RETURNING *', [row.id, null])
    }
    return mine.length
  }

  /**
   * Outstanding inputs for one employee and period. Filtering
   * `consumed_run_id IS NULL` happens in TypeScript rather than SQL — the
   * same deliberate simplification `svc-leave`'s repositories make so the
   * in-memory test fake never has to implement an operator beyond `col =
   * $n`. The row count per employee per period is a handful.
   */
  async listOutstanding(employeeId: string, period: string, db: Queryable = this.db): Promise<PayInputRow[]> {
    const { rows } = await db.query('SELECT * FROM payroll.pay_input WHERE employee_id = $1 AND period = $2 ORDER BY id', [
      employeeId,
      period,
    ])
    return rows.map((r) => mapRow(r as Record<string, unknown>)).filter((r) => r.consumedRunId === null)
  }

  async listByPeriod(period: string, db: Queryable = this.db): Promise<PayInputRow[]> {
    const { rows } = await db.query('SELECT * FROM payroll.pay_input WHERE period = $1 ORDER BY id', [period])
    return rows.map((r) => mapRow(r as Record<string, unknown>))
  }
}
