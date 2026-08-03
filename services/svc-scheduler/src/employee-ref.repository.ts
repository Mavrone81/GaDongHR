import type { Queryable } from '@gadong/kernel'

export interface EmployeeRefRow {
  employeeId: string
  empCode: string | null
  status: string | null
  orgUnitId: string | null
  updatedAt: string
}

export interface UpsertEmployeeRef {
  employeeId: string
  empCode: string | null
  status: string | null
  orgUnitId: string | null
}

function toIsoString(v: unknown): string {
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'string') return v
  throw new Error(`EmployeeRefRepository: unexpected timestamp value ${JSON.stringify(v)}`)
}

function mapRow(row: Record<string, unknown>): EmployeeRefRow {
  return {
    employeeId: String(row['employee_id']),
    empCode: row['emp_code'] === null || row['emp_code'] === undefined ? null : String(row['emp_code']),
    status: row['status'] === null || row['status'] === undefined ? null : String(row['status']),
    orgUnitId: row['org_unit_id'] === null || row['org_unit_id'] === undefined ? null : String(row['org_unit_id']),
    updatedAt: toIsoString(row['updated_at']),
  }
}

/**
 * `scheduler_employee_ref` — the local, eventually-consistent read model fed
 * by `employee.created`/`employee.updated`/`employee.terminated` (roadmap
 * "Database conventions": "employee_id is replicated into per-schema
 * *_employee_ref read models via employee.* events"). `upsert` is the one
 * write path every one of those three event kinds drives (see
 * `events.service.ts`): a terminated employee is represented by
 * `status = 'terminated'`, not a deleted row, so a roster entry referencing
 * them keeps resolving to a real (if inactive) name.
 */
export class EmployeeRefRepository {
  constructor(private readonly db: Queryable) {}

  async upsert(tx: Queryable, row: UpsertEmployeeRef): Promise<EmployeeRefRow> {
    const { rows } = await tx.query(
      `INSERT INTO scheduler.scheduler_employee_ref (employee_id, emp_code, status, org_unit_id, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (employee_id) DO UPDATE
         SET emp_code = COALESCE(EXCLUDED.emp_code, scheduler.scheduler_employee_ref.emp_code),
             status = COALESCE(EXCLUDED.status, scheduler.scheduler_employee_ref.status),
             org_unit_id = COALESCE(EXCLUDED.org_unit_id, scheduler.scheduler_employee_ref.org_unit_id),
             updated_at = now()
       RETURNING employee_id, emp_code, status, org_unit_id, updated_at`,
      [row.employeeId, row.empCode, row.status, row.orgUnitId],
    )
    const inserted = rows[0]
    if (inserted === undefined) throw new Error('EmployeeRefRepository.upsert: INSERT ... RETURNING produced no row')
    return mapRow(inserted)
  }

  async findById(employeeId: string): Promise<EmployeeRefRow | null> {
    const { rows } = await this.db.query(
      `SELECT employee_id, emp_code, status, org_unit_id, updated_at FROM scheduler.scheduler_employee_ref WHERE employee_id = $1`,
      [employeeId],
    )
    return rows.length > 0 && rows[0] !== undefined ? mapRow(rows[0]) : null
  }

  async findByOrgUnit(orgUnitId: string): Promise<EmployeeRefRow[]> {
    const { rows } = await this.db.query(
      `SELECT employee_id, emp_code, status, org_unit_id, updated_at FROM scheduler.scheduler_employee_ref WHERE org_unit_id = $1`,
      [orgUnitId],
    )
    return rows.map(mapRow)
  }
}
