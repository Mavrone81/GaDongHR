import type { Queryable } from '@gadong/kernel'

export type DayStatus = 'ok' | 'exception' | 'corrected'

export interface DayRecordRow {
  id: string
  employeeId: string
  workDate: string
  rosterEntryId: string | null
  actualIn: string | null
  actualOut: string | null
  workedHours: string
  lateMin: string
  ot15x: string
  ot2x: string
  ot3x: string
  leaveCode: string | null
  status: DayStatus
  createdAt: string
  updatedAt: string
}

export interface ComputedFields {
  workedHours: string
  lateMin: string
  ot15x: string
  ot2x: string
  ot3x: string
  status: DayStatus
}

const SELECT_COLUMNS =
  'id, employee_id, work_date, roster_entry_id, actual_in, actual_out, worked_hours, late_min, ot_15x, ot_2x, ot_3x, leave_code, status, created_at, updated_at'

function toIsoOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'string') return v
  throw new Error(`DayRecordRepository: unexpected timestamp value ${JSON.stringify(v)}`)
}

function toDateString(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === 'string') return v.slice(0, 10)
  throw new Error(`DayRecordRepository: unexpected date value ${JSON.stringify(v)}`)
}

function mapRow(row: Record<string, unknown>): DayRecordRow {
  return {
    id: String(row['id']),
    employeeId: String(row['employee_id']),
    workDate: toDateString(row['work_date']),
    rosterEntryId: row['roster_entry_id'] === null || row['roster_entry_id'] === undefined ? null : String(row['roster_entry_id']),
    actualIn: toIsoOrNull(row['actual_in']),
    actualOut: toIsoOrNull(row['actual_out']),
    workedHours: String(row['worked_hours']),
    lateMin: String(row['late_min']),
    ot15x: String(row['ot_15x']),
    ot2x: String(row['ot_2x']),
    ot3x: String(row['ot_3x']),
    leaveCode: row['leave_code'] === null || row['leave_code'] === undefined ? null : String(row['leave_code']),
    status: row['status'] as DayStatus,
    createdAt: toIsoOrNull(row['created_at']) as string,
    updatedAt: toIsoOrNull(row['updated_at']) as string,
  }
}

/**
 * `timesheet.day_record` — one row per employee-day (M3-1: "one daily record
 * per employee", enforced by the migration's `UNIQUE(employee_id, work_date)`).
 * SQL only, no merge/classification logic — `ConsolidationService` owns
 * that, matching the `RosterRepository`/`RosterService` split this codebase
 * establishes throughout.
 */
export class DayRecordRepository {
  constructor(private readonly db: Queryable) {}

  async findById(id: string, tx: Queryable = this.db): Promise<DayRecordRow | null> {
    const { rows } = await tx.query(`SELECT ${SELECT_COLUMNS} FROM timesheet.day_record WHERE id = $1`, [id])
    return rows.length > 0 && rows[0] !== undefined ? mapRow(rows[0]) : null
  }

  /** `tx` defaults to this repository's own connection — pass the caller's transaction explicitly when reading back a row that same transaction may have just written (see `RosterRefRepository.findOne`'s identical note). */
  async findOne(employeeId: string, workDate: string, tx: Queryable = this.db): Promise<DayRecordRow | null> {
    const { rows } = await tx.query(
      `SELECT ${SELECT_COLUMNS} FROM timesheet.day_record WHERE employee_id = $1 AND work_date = $2`,
      [employeeId, workDate],
    )
    return rows.length > 0 && rows[0] !== undefined ? mapRow(rows[0]) : null
  }

  /**
   * The day_record this OUT punch closes: the most recent OPEN (actual_in
   * set, actual_out null) record for this employee whose actual_in is no
   * later than `beforeIso` and no earlier than `lookbackMinutes` before it —
   * this is what lets a night shift's 06:10 out-punch (a different calendar
   * date) still find and close the 21:55 in-punch's record, which correctly
   * carries the SHIFT-START date (TC-M3-003).
   */
  async findOpenForEmployee(employeeId: string, beforeIso: string, lookbackMinutes: number, tx: Queryable = this.db): Promise<DayRecordRow | null> {
    const { rows } = await tx.query(
      `SELECT ${SELECT_COLUMNS} FROM timesheet.day_record
       WHERE employee_id = $1 AND actual_in IS NOT NULL AND actual_out IS NULL
         AND actual_in <= $2 AND actual_in >= $2::timestamptz - ($3 || ' minutes')::interval
       ORDER BY actual_in DESC LIMIT 1`,
      [employeeId, beforeIso, lookbackMinutes],
    )
    return rows.length > 0 && rows[0] !== undefined ? mapRow(rows[0]) : null
  }

  /** Creates the row if it does not exist yet; if it does, only fills `rosterEntryId` when the existing row has none (never overwrites a row a punch/leave/OT event already touched). */
  async ensureExists(tx: Queryable, employeeId: string, workDate: string, rosterEntryId: string | null): Promise<DayRecordRow> {
    const { rows } = await tx.query(
      `INSERT INTO timesheet.day_record (employee_id, work_date, roster_entry_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (employee_id, work_date) DO UPDATE
         SET roster_entry_id = COALESCE(timesheet.day_record.roster_entry_id, EXCLUDED.roster_entry_id),
             updated_at = now()
       RETURNING ${SELECT_COLUMNS}`,
      [employeeId, workDate, rosterEntryId],
    )
    const inserted = rows[0]
    if (inserted === undefined) throw new Error('DayRecordRepository.ensureExists: INSERT ... RETURNING produced no row')
    return mapRow(inserted)
  }

  /** First-in-wins: only sets `actual_in` when it is currently null. Returns the row either way (unchanged if a punch already claimed this slot). */
  async setActualInIfAbsent(tx: Queryable, id: string, actualIn: string): Promise<DayRecordRow> {
    const { rows } = await tx.query(
      `UPDATE timesheet.day_record SET actual_in = $2, updated_at = now()
       WHERE id = $1 AND actual_in IS NULL
       RETURNING ${SELECT_COLUMNS}`,
      [id, actualIn],
    )
    if (rows.length > 0 && rows[0] !== undefined) return mapRow(rows[0])
    const existing = await this.findById(id)
    if (!existing) throw new Error(`DayRecordRepository.setActualInIfAbsent: no such row ${id}`)
    return existing
  }

  async setActualOut(tx: Queryable, id: string, actualOut: string): Promise<DayRecordRow> {
    const { rows } = await tx.query(
      `UPDATE timesheet.day_record SET actual_out = $2, updated_at = now() WHERE id = $1 RETURNING ${SELECT_COLUMNS}`,
      [id, actualOut],
    )
    const updated = rows[0]
    if (updated === undefined) throw new Error(`DayRecordRepository.setActualOut: no such row ${id}`)
    return mapRow(updated)
  }

  async setLeaveCode(tx: Queryable, id: string, leaveCode: string | null): Promise<DayRecordRow> {
    const { rows } = await tx.query(
      `UPDATE timesheet.day_record SET leave_code = $2, updated_at = now() WHERE id = $1 RETURNING ${SELECT_COLUMNS}`,
      [id, leaveCode],
    )
    const updated = rows[0]
    if (updated === undefined) throw new Error(`DayRecordRepository.setLeaveCode: no such row ${id}`)
    return mapRow(updated)
  }

  async updateComputed(tx: Queryable, id: string, fields: ComputedFields): Promise<DayRecordRow> {
    const { rows } = await tx.query(
      `UPDATE timesheet.day_record
       SET worked_hours = $2, late_min = $3, ot_15x = $4, ot_2x = $5, ot_3x = $6, status = $7, updated_at = now()
       WHERE id = $1
       RETURNING ${SELECT_COLUMNS}`,
      [id, fields.workedHours, fields.lateMin, fields.ot15x, fields.ot2x, fields.ot3x, fields.status],
    )
    const updated = rows[0]
    if (updated === undefined) throw new Error(`DayRecordRepository.updateComputed: no such row ${id}`)
    return mapRow(updated)
  }

  /** Overwrites actual_in/actual_out directly — the manual-correction path (M3-3), never used by ordinary punch consolidation. */
  async applyCorrection(tx: Queryable, id: string, actualIn: string | null, actualOut: string | null): Promise<DayRecordRow> {
    const { rows } = await tx.query(
      `UPDATE timesheet.day_record SET actual_in = $2, actual_out = $3, status = 'corrected', updated_at = now()
       WHERE id = $1
       RETURNING ${SELECT_COLUMNS}`,
      [id, actualIn, actualOut],
    )
    const updated = rows[0]
    if (updated === undefined) throw new Error(`DayRecordRepository.applyCorrection: no such row ${id}`)
    return mapRow(updated)
  }

  /** `employeeIds: null` scopes to every employee (org-wide HR view); a non-null array scopes row-level access to exactly those employees (the row-scoping fix — see `org-scope.ts`). */
  async findByEmployeesAndRange(employeeIds: string[] | null, from: string, to: string): Promise<DayRecordRow[]> {
    const { rows } = await this.db.query(
      `SELECT ${SELECT_COLUMNS} FROM timesheet.day_record
       WHERE work_date BETWEEN $1 AND $2 AND ($3::uuid[] IS NULL OR employee_id = ANY($3::uuid[]))
       ORDER BY employee_id, work_date`,
      [from, to, employeeIds],
    )
    return rows.map(mapRow)
  }

  /**
   * Per-employee totals for `[from, to]` (a LOCKED period's own date range —
   * `PeriodService.totals` is the only caller, see that method's doc for
   * the lock-version contract this feeds). One row per employee who has at
   * least one `day_record` in range; an employee with none simply does not
   * appear (`svc-payroll`'s `HttpTimesheetClient.getLockedTotals` builds a
   * `Map` from these rows, so an absent employee correctly resolves to
   * `ZERO_TIMESHEET` on the caller's side, not a row of zeroes here).
   *
   * `daysWorked` counts a day as "worked" when `worked_hours > 0` — matching
   * `gross-to-net.ts`'s `basePayEarned` use of the figure (a daily-rate
   * employee is paid per day actually worked, not per `day_record` row that
   * merely exists, e.g. an unworked leave day). Every other column is a
   * plain SUM, aggregated server-side so the exact-rational discipline
   * (`hours.ts`'s header) is preserved — Postgres `numeric` SUM/COUNT never
   * touches a float, and `pg` returns both back as strings (no type parser
   * installed for `numeric`/`int8` — see `packages/kernel/src/db/pool.ts`),
   * exactly like every other hours figure this repository returns.
   */
  async totalsByEmployeeInRange(from: string, to: string): Promise<EmployeeTotalsRow[]> {
    const { rows } = await this.db.query(
      `SELECT employee_id,
              COUNT(*) FILTER (WHERE worked_hours::numeric > 0) AS days_worked,
              COALESCE(SUM(worked_hours), 0) AS hours_worked,
              COALESCE(SUM(ot_15x), 0) AS ot_workday_hours,
              COALESCE(SUM(ot_2x), 0) AS ot_holiday_work_hours,
              COALESCE(SUM(ot_3x), 0) AS ot_holiday_ot_hours
       FROM timesheet.day_record
       WHERE work_date BETWEEN $1 AND $2
       GROUP BY employee_id
       ORDER BY employee_id`,
      [from, to],
    )
    return rows.map((row) => ({
      employeeId: String(row['employee_id']),
      daysWorked: String(row['days_worked']),
      hoursWorked: String(row['hours_worked']),
      otWorkdayHours: String(row['ot_workday_hours']),
      otHolidayWorkHours: String(row['ot_holiday_work_hours']),
      otHolidayOtHours: String(row['ot_holiday_ot_hours']),
    }))
  }
}

/** One employee's aggregated totals over a date range — the exact shape `svc-payroll`'s `TimesheetTotals` (`ports.ts`) expects on the wire, computed here rather than re-derived client-side. */
export interface EmployeeTotalsRow {
  employeeId: string
  daysWorked: string
  hoursWorked: string
  otWorkdayHours: string
  otHolidayWorkHours: string
  otHolidayOtHours: string
}
