import type { Queryable } from '@gadong/kernel'

/**
 * The three read models this service keeps from other services' events, all
 * plaintext S1/S2 facts and no money:
 *
 *  - `payroll_employee_ref` from `employee.created`/`updated` — province
 *    (the minimum-wage floor), start date (the severance tier), preferred
 *    language (the payslip, and whether its dates render in Buddhist Era).
 *  - `timesheet_lock` from `timesheet.locked`/`unlocked` — the version a
 *    run binds to, and the version that tells the run it has gone stale.
 *  - `termination` from `employee.terminated`, plus the s.119 cause and
 *    citation a human must supply before severance can be withheld.
 *
 * No foreign keys reach out of this schema (roadmap database conventions);
 * these are eventually-consistent copies, not joins.
 */

export interface EmployeeRefRow {
  employeeId: string
  empCode: string | null
  status: string | null
  provinceCode: string | null
  startDate: string | null
  preferredLang: string | null
  orgUnitId: string | null
  employmentType: string | null
}

function asDateOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  return String(value).slice(0, 10)
}

function mapEmployeeRef(row: Record<string, unknown>): EmployeeRefRow {
  const text = (key: string): string | null => (row[key] === null || row[key] === undefined ? null : String(row[key]))
  return {
    employeeId: String(row['employee_id']),
    empCode: text('emp_code'),
    status: text('status'),
    provinceCode: text('province_code'),
    startDate: asDateOrNull(row['start_date']),
    preferredLang: text('preferred_lang'),
    orgUnitId: text('org_unit_id'),
    employmentType: text('employment_type'),
  }
}

export interface TimesheetLockRow {
  period: string
  /** svc-timesheet's own period-row uuid — see the migration's column doc for why this, and not `period`, is what a totals lookup against the real service must use. */
  periodId: string
  lockVersion: number
  locked: boolean
  lockedBy: string | null
}

function mapTimesheetLock(row: Record<string, unknown>): TimesheetLockRow {
  return {
    period: String(row['period']),
    periodId: String(row['period_id']),
    lockVersion: Number(row['lock_version']),
    locked: Boolean(row['locked']),
    lockedBy: row['locked_by'] === null || row['locked_by'] === undefined ? null : String(row['locked_by']),
  }
}

export interface TerminationRow {
  employeeId: string
  terminationDate: string
  lastWorkingDay: string | null
  reasonCategory: string
  statutoryCause: string | null
  statutoryCitation: string | null
  noticeGiven: boolean
}

function mapTermination(row: Record<string, unknown>): TerminationRow {
  const terminationDate = asDateOrNull(row['termination_date'])
  if (terminationDate === null) throw new Error('RefsRepository: termination_date is notNull in the schema but came back null')
  return {
    employeeId: String(row['employee_id']),
    terminationDate,
    lastWorkingDay: asDateOrNull(row['last_working_day']),
    reasonCategory: String(row['reason_category']),
    statutoryCause: row['statutory_cause'] === null || row['statutory_cause'] === undefined ? null : String(row['statutory_cause']),
    statutoryCitation: row['statutory_citation'] === null || row['statutory_citation'] === undefined ? null : String(row['statutory_citation']),
    noticeGiven: Boolean(row['notice_given']),
  }
}

export class RefsRepository {
  constructor(private readonly db: Queryable) {}

  // --- payroll_employee_ref ---

  async upsertEmployee(tx: Queryable, ref: EmployeeRefRow): Promise<EmployeeRefRow> {
    const existing = await this.findEmployee(ref.employeeId, tx)
    if (existing === null) {
      const { rows } = await tx.query(
        `INSERT INTO payroll.payroll_employee_ref (employee_id, emp_code, status, province_code, start_date, preferred_lang, org_unit_id, employment_type)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [ref.employeeId, ref.empCode, ref.status, ref.provinceCode, ref.startDate, ref.preferredLang, ref.orgUnitId, ref.employmentType],
      )
      const first = rows[0]
      if (first === undefined) throw new Error('RefsRepository.upsertEmployee: INSERT ... RETURNING * returned no row')
      return mapEmployeeRef(first as Record<string, unknown>)
    }
    // A later `employee.updated` may legitimately omit a field it did not
    // change; keeping the previously-known value beats overwriting a known
    // province with null and silently losing the minimum-wage floor.
    const merged: EmployeeRefRow = {
      employeeId: ref.employeeId,
      empCode: ref.empCode ?? existing.empCode,
      status: ref.status ?? existing.status,
      provinceCode: ref.provinceCode ?? existing.provinceCode,
      startDate: ref.startDate ?? existing.startDate,
      preferredLang: ref.preferredLang ?? existing.preferredLang,
      orgUnitId: ref.orgUnitId ?? existing.orgUnitId,
      employmentType: ref.employmentType ?? existing.employmentType,
    }
    const { rows } = await tx.query(
      `UPDATE payroll.payroll_employee_ref SET emp_code = $2, status = $3, province_code = $4, start_date = $5, preferred_lang = $6, org_unit_id = $7, employment_type = $8 WHERE employee_id = $1 RETURNING *`,
      [merged.employeeId, merged.empCode, merged.status, merged.provinceCode, merged.startDate, merged.preferredLang, merged.orgUnitId, merged.employmentType],
    )
    const first = rows[0]
    if (first === undefined) throw new Error('RefsRepository.upsertEmployee: UPDATE ... RETURNING * returned no row')
    return mapEmployeeRef(first as Record<string, unknown>)
  }

  async findEmployee(employeeId: string, db: Queryable = this.db): Promise<EmployeeRefRow | null> {
    const { rows } = await db.query('SELECT * FROM payroll.payroll_employee_ref WHERE employee_id = $1', [employeeId])
    const first = rows[0]
    return first === undefined ? null : mapEmployeeRef(first as Record<string, unknown>)
  }

  async listEmployees(db: Queryable = this.db): Promise<EmployeeRefRow[]> {
    const { rows } = await db.query('SELECT * FROM payroll.payroll_employee_ref ORDER BY employee_id')
    return rows.map((r) => mapEmployeeRef(r as Record<string, unknown>))
  }

  // --- timesheet_lock ---

  async upsertTimesheetLock(tx: Queryable, row: TimesheetLockRow): Promise<TimesheetLockRow> {
    const existing = await this.findTimesheetLock(row.period, tx)
    if (existing === null) {
      const { rows } = await tx.query(
        `INSERT INTO payroll.timesheet_lock (period, period_id, lock_version, locked, locked_by) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [row.period, row.periodId, row.lockVersion, row.locked, row.lockedBy],
      )
      const first = rows[0]
      if (first === undefined) throw new Error('RefsRepository.upsertTimesheetLock: INSERT ... RETURNING * returned no row')
      return mapTimesheetLock(first as Record<string, unknown>)
    }
    const { rows } = await tx.query(
      `UPDATE payroll.timesheet_lock SET period_id = $2, lock_version = $3, locked = $4, locked_by = $5 WHERE period = $1 RETURNING *`,
      [row.period, row.periodId, row.lockVersion, row.locked, row.lockedBy],
    )
    const first = rows[0]
    if (first === undefined) throw new Error('RefsRepository.upsertTimesheetLock: UPDATE ... RETURNING * returned no row')
    return mapTimesheetLock(first as Record<string, unknown>)
  }

  async findTimesheetLock(period: string, db: Queryable = this.db): Promise<TimesheetLockRow | null> {
    const { rows } = await db.query('SELECT * FROM payroll.timesheet_lock WHERE period = $1', [period])
    const first = rows[0]
    return first === undefined ? null : mapTimesheetLock(first as Record<string, unknown>)
  }

  // --- termination ---

  async upsertTermination(tx: Queryable, row: TerminationRow): Promise<TerminationRow> {
    const existing = await this.findTermination(row.employeeId, tx)
    if (existing === null) {
      const { rows } = await tx.query(
        `INSERT INTO payroll.termination (employee_id, termination_date, last_working_day, reason_category, statutory_cause, statutory_citation, notice_given)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [row.employeeId, row.terminationDate, row.lastWorkingDay, row.reasonCategory, row.statutoryCause, row.statutoryCitation, row.noticeGiven],
      )
      const first = rows[0]
      if (first === undefined) throw new Error('RefsRepository.upsertTermination: INSERT ... RETURNING * returned no row')
      return mapTermination(first as Record<string, unknown>)
    }
    const { rows } = await tx.query(
      `UPDATE payroll.termination SET termination_date = $2, last_working_day = $3, reason_category = $4, statutory_cause = $5, statutory_citation = $6, notice_given = $7 WHERE employee_id = $1 RETURNING *`,
      [row.employeeId, row.terminationDate, row.lastWorkingDay, row.reasonCategory, row.statutoryCause, row.statutoryCitation, row.noticeGiven],
    )
    const first = rows[0]
    if (first === undefined) throw new Error('RefsRepository.upsertTermination: UPDATE ... RETURNING * returned no row')
    return mapTermination(first as Record<string, unknown>)
  }

  async findTermination(employeeId: string, db: Queryable = this.db): Promise<TerminationRow | null> {
    const { rows } = await db.query('SELECT * FROM payroll.termination WHERE employee_id = $1', [employeeId])
    const first = rows[0]
    return first === undefined ? null : mapTermination(first as Record<string, unknown>)
  }
}
