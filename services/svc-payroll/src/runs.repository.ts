import type { Queryable } from '@gadong/kernel'

/**
 * `payroll.payroll_run` — the lifecycle row (M7-3). Two columns on it are
 * legal controls rather than bookkeeping, and neither is enforced here:
 * `prepared_by`/`approved_by` carry the SoD CHECK, and `status =
 * 'committed'` carries the immutability triggers. This repository issues
 * plain SQL; `RunsService` performs the equivalent checks in code BEFORE
 * the statement is sent, so a violation is a clean AUZ-409/PAY-022 rather
 * than a raw constraint error — and the database still refuses it if the
 * service check is ever removed. That belt-and-brace is the point;
 * `runs.service.test.ts` demonstrates the service half failing when
 * deleted.
 */

export type RunStatus = 'draft' | 'calculated' | 'reviewed' | 'approved' | 'committed'
export type RunType = 'regular' | 'offcycle' | 'adjustment' | 'final_pay'

export interface PayrollRunRow {
  id: string
  period: string
  runType: RunType
  timesheetLockVersion: number
  status: RunStatus
  preparedBy: string
  approvedBy: string | null
  reviewedBy: string | null
  rulepackVersions: Record<string, unknown>
  periodStart: string | null
  periodEnd: string | null
  payDate: string | null
  approvedAt: string | null
  committedAt: string | null
  adjustsRunId: string | null
}

export interface NewPayrollRunRow {
  id: string
  period: string
  runType: RunType
  timesheetLockVersion: number
  status: RunStatus
  preparedBy: string
  periodStart: string
  periodEnd: string
  payDate: string
  adjustsRunId: string | null
}

function asIsoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

function mapRow(row: Record<string, unknown>): PayrollRunRow {
  const versions = row['rulepack_versions']
  return {
    id: String(row['id']),
    period: String(row['period']),
    runType: row['run_type'] as RunType,
    timesheetLockVersion: Number(row['timesheet_lock_version']),
    status: row['status'] as RunStatus,
    preparedBy: String(row['prepared_by']),
    approvedBy: row['approved_by'] === null || row['approved_by'] === undefined ? null : String(row['approved_by']),
    reviewedBy: row['reviewed_by'] === null || row['reviewed_by'] === undefined ? null : String(row['reviewed_by']),
    rulepackVersions: typeof versions === 'object' && versions !== null ? (versions as Record<string, unknown>) : {},
    periodStart: asIsoOrNull(row['period_start']),
    periodEnd: asIsoOrNull(row['period_end']),
    payDate: asIsoOrNull(row['pay_date']),
    approvedAt: asIsoOrNull(row['approved_at']),
    committedAt: asIsoOrNull(row['committed_at']),
    adjustsRunId: row['adjusts_run_id'] === null || row['adjusts_run_id'] === undefined ? null : String(row['adjusts_run_id']),
  }
}

export class RunsRepository {
  constructor(private readonly db: Queryable) {}

  async insert(tx: Queryable, row: NewPayrollRunRow): Promise<PayrollRunRow> {
    const { rows } = await tx.query(
      `INSERT INTO payroll.payroll_run (id, period, run_type, timesheet_lock_version, status, prepared_by, period_start, period_end, pay_date, adjusts_run_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [
        row.id,
        row.period,
        row.runType,
        row.timesheetLockVersion,
        row.status,
        row.preparedBy,
        row.periodStart,
        row.periodEnd,
        row.payDate,
        row.adjustsRunId,
      ],
    )
    const first = rows[0]
    if (first === undefined) throw new Error('RunsRepository.insert: INSERT ... RETURNING * returned no row')
    return mapRow(first as Record<string, unknown>)
  }

  async setCalculated(tx: Queryable, id: string, rulepackVersions: Record<string, unknown>, lockVersion: number): Promise<PayrollRunRow | null> {
    const { rows } = await tx.query(
      `UPDATE payroll.payroll_run SET status = $2, rulepack_versions = $3::jsonb, timesheet_lock_version = $4 WHERE id = $1 RETURNING *`,
      [id, 'calculated', JSON.stringify(rulepackVersions), lockVersion],
    )
    const first = rows[0]
    return first === undefined ? null : mapRow(first as Record<string, unknown>)
  }

  async setReviewed(tx: Queryable, id: string, reviewedBy: string): Promise<PayrollRunRow | null> {
    const { rows } = await tx.query(
      `UPDATE payroll.payroll_run SET status = $2, reviewed_by = $3 WHERE id = $1 RETURNING *`,
      [id, 'reviewed', reviewedBy],
    )
    const first = rows[0]
    return first === undefined ? null : mapRow(first as Record<string, unknown>)
  }

  /** `approvedBy` is written in the SAME statement as the status, so there is no window in which a run is `approved` with a null approver. */
  async setApproved(tx: Queryable, id: string, approvedBy: string, approvedAt: string): Promise<PayrollRunRow | null> {
    const { rows } = await tx.query(
      `UPDATE payroll.payroll_run SET status = $2, approved_by = $3, approved_at = $4 WHERE id = $1 RETURNING *`,
      [id, 'approved', approvedBy, approvedAt],
    )
    const first = rows[0]
    return first === undefined ? null : mapRow(first as Record<string, unknown>)
  }

  async setCommitted(tx: Queryable, id: string, committedAt: string): Promise<PayrollRunRow | null> {
    const { rows } = await tx.query(
      `UPDATE payroll.payroll_run SET status = $2, committed_at = $3 WHERE id = $1 RETURNING *`,
      [id, 'committed', committedAt],
    )
    const first = rows[0]
    return first === undefined ? null : mapRow(first as Record<string, unknown>)
  }

  async findById(id: string, db: Queryable = this.db): Promise<PayrollRunRow | null> {
    const { rows } = await db.query('SELECT * FROM payroll.payroll_run WHERE id = $1', [id])
    const first = rows[0]
    return first === undefined ? null : mapRow(first as Record<string, unknown>)
  }

  async listByPeriod(period: string, db: Queryable = this.db): Promise<PayrollRunRow[]> {
    const { rows } = await db.query('SELECT * FROM payroll.payroll_run WHERE period = $1 ORDER BY created_at', [period])
    return rows.map((r) => mapRow(r as Record<string, unknown>))
  }

  async listAll(db: Queryable = this.db): Promise<PayrollRunRow[]> {
    const { rows } = await db.query('SELECT * FROM payroll.payroll_run ORDER BY period')
    return rows.map((r) => mapRow(r as Record<string, unknown>))
  }
}
