import type { Queryable } from '@gadong/kernel'

export type EmploymentType = 'monthly' | 'daily' | 'hourly' | 'contract'
export type EmployeeStatus = 'onboarding' | 'active' | 'terminated'

export interface TimesheetEmployeeRefRow {
  employeeId: string
  empCode: string
  orgUnitId: string
  employmentType: EmploymentType
  status: EmployeeStatus
  updatedAt: string
}

export interface UpsertTimesheetEmployeeRef {
  employeeId: string
  empCode: string
  orgUnitId: string
  employmentType: EmploymentType
  status: EmployeeStatus
}

function toIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'string') return v
  throw new Error(`EmployeeRefRepository: unexpected timestamp value ${JSON.stringify(v)}`)
}

const SELECT_COLUMNS = 'employee_id, emp_code, org_unit_id, employment_type, status, updated_at'

function mapRow(row: Record<string, unknown>): TimesheetEmployeeRefRow {
  return {
    employeeId: String(row['employee_id']),
    empCode: String(row['emp_code']),
    orgUnitId: String(row['org_unit_id']),
    employmentType: row['employment_type'] as EmploymentType,
    status: row['status'] as EmployeeStatus,
    updatedAt: toIso(row['updated_at']),
  }
}

/**
 * `timesheet.timesheet_employee_ref` (Task 14 migration) — fed by
 * `employee.created`/`employee.updated`. `employment_type` is the
 * `OtClassifier`'s paid-holiday-entitlement input; `org_unit_id` is the row
 * scoping key `ViewsService`'s manager-team query filters on.
 */
export class EmployeeRefRepository {
  constructor(private readonly db: Queryable) {}

  async upsert(tx: Queryable, row: UpsertTimesheetEmployeeRef): Promise<TimesheetEmployeeRefRow> {
    const { rows } = await tx.query(
      `INSERT INTO timesheet.timesheet_employee_ref (employee_id, emp_code, org_unit_id, employment_type, status, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (employee_id) DO UPDATE
         SET emp_code = EXCLUDED.emp_code, org_unit_id = EXCLUDED.org_unit_id,
             employment_type = EXCLUDED.employment_type, status = EXCLUDED.status, updated_at = now()
       RETURNING ${SELECT_COLUMNS}`,
      [row.employeeId, row.empCode, row.orgUnitId, row.employmentType, row.status],
    )
    const inserted = rows[0]
    if (inserted === undefined) throw new Error('EmployeeRefRepository.upsert: INSERT ... RETURNING produced no row')
    return mapRow(inserted)
  }

  /** `tx` defaults to this repository's own connection — pass the caller's transaction explicitly when reading back a row that same transaction may have just upserted (see `RosterRefRepository.findOne`'s identical note). */
  async findById(employeeId: string, tx: Queryable = this.db): Promise<TimesheetEmployeeRefRow | null> {
    const { rows } = await tx.query(
      `SELECT ${SELECT_COLUMNS} FROM timesheet.timesheet_employee_ref WHERE employee_id = $1`,
      [employeeId],
    )
    return rows.length > 0 && rows[0] !== undefined ? mapRow(rows[0]) : null
  }

  /** Row scoping: every employee whose `org_unit_id` is in `orgUnitIds` (a manager's `scopeOrgUnitIds`, resolved by `svc-authz`). */
  async findByOrgUnits(orgUnitIds: string[]): Promise<TimesheetEmployeeRefRow[]> {
    const { rows } = await this.db.query(
      `SELECT ${SELECT_COLUMNS} FROM timesheet.timesheet_employee_ref WHERE org_unit_id = ANY($1)`,
      [orgUnitIds],
    )
    return rows.map(mapRow)
  }
}
