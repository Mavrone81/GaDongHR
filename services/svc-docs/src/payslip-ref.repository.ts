import type { Queryable } from '@gadong/kernel'

export interface PayslipRefRow {
  payslipId: string
  employeeId: string
  updatedAt: string
}

export interface UpsertPayslipRef {
  payslipId: string
  employeeId: string
}

function toIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'string') return v
  throw new Error(`PayslipRefRepository: unexpected timestamp value ${JSON.stringify(v)}`)
}

const SELECT_COLUMNS = 'payslip_id, employee_id, updated_at'

function mapRow(row: Record<string, unknown>): PayslipRefRow {
  return {
    payslipId: String(row['payslip_id']),
    employeeId: String(row['employee_id']),
    updatedAt: toIso(row['updated_at']),
  }
}

/**
 * `docs.payslip_ref` — fed by `payslip.issued` (roadmap event catalog:
 * `{payslipId, runId, employeeId, lang}`, `svc-payroll`'s
 * `events.ts#buildPayslipIssuedPayload`), the row-scoping fix's local read
 * model for the OTHER document shape `docs.document.entity_id` cannot
 * resolve on its own: for `kind: 'payslip'` / `entity_type: 'payslip'`,
 * `entity_id` is the payslip's own id (`svc-payroll`'s `ports.ts:143`), NOT
 * the employee's — so `GET /documents/:id`'s ownership check needs this
 * table to answer "whose payslip is this" before it can apply
 * `AuthzScope` at all. Without it, the flagship example the roadmap names
 * ("An employee who enumerates a document id reaches a colleague's
 * payslip") stays open even after the `entity_type = 'employee'` case
 * (contracts/letters) is fixed.
 */
export class PayslipRefRepository {
  constructor(private readonly db: Queryable) {}

  async upsert(tx: Queryable, row: UpsertPayslipRef): Promise<PayslipRefRow> {
    const { rows } = await tx.query(
      `INSERT INTO docs.payslip_ref (payslip_id, employee_id, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (payslip_id) DO UPDATE
         SET employee_id = EXCLUDED.employee_id, updated_at = now()
       RETURNING ${SELECT_COLUMNS}`,
      [row.payslipId, row.employeeId],
    )
    const inserted = rows[0]
    if (inserted === undefined) throw new Error('PayslipRefRepository.upsert: INSERT ... RETURNING produced no row')
    return mapRow(inserted)
  }

  async findById(payslipId: string): Promise<PayslipRefRow | null> {
    const { rows } = await this.db.query(`SELECT ${SELECT_COLUMNS} FROM docs.payslip_ref WHERE payslip_id = $1`, [payslipId])
    return rows.length > 0 && rows[0] !== undefined ? mapRow(rows[0]) : null
  }
}
