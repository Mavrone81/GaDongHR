import { randomUUID } from 'node:crypto'
import type { Queryable } from '@gadong/kernel'

/**
 * A tiny in-memory stand-in for Postgres, scoped to the `timesheet` schema —
 * same reason and shape as `services/svc-scheduler/src/testing/fake-db.ts`:
 * no Postgres in this environment (brief CONSTRAINTS). `migrations/*.js` is
 * the source of truth for the real schema; every table this class models
 * mirrors those two migration files exactly.
 *
 * One `FakeTimesheetDb` holds the COMMITTED store for every table this
 * service owns; `connect()` returns an independent session
 * (`FakeTimesheetConnection`) whose writes are staged locally and only join
 * the committed store on `COMMIT`.
 */

interface DayRecordRow {
  id: string
  employee_id: string
  work_date: string
  roster_entry_id: string | null
  actual_in: string | null
  actual_out: string | null
  worked_hours: string
  late_min: string
  ot_15x: string
  ot_2x: string
  ot_3x: string
  leave_code: string | null
  status: string
  created_at: Date
  updated_at: Date
}

interface TimeExceptionRow {
  id: string
  day_record_id: string
  kind: string
  resolution: string | null
  resolved_by: string | null
  reason: string | null
  created_at: Date
  updated_at: Date
}

interface PeriodRow {
  id: string
  from_date: string
  to_date: string
  status: string
  lock_version: number
  locked_by: string | null
  locked_at: Date | null
  created_at: Date
  updated_at: Date
}

interface RosterRefRow {
  employee_id: string
  work_date: string
  scheduled_start: string | null
  scheduled_end: string | null
  grace_min: number
  hazardous: boolean
  is_holiday: boolean
  roster_entry_id: string | null
  updated_at: Date
}

interface LeaveRefRow {
  id: string
  employee_id: string
  leave_request_id: string
  date_from: string
  date_to: string
  leave_type_code: string
  pay_mode: string
  status: string
  updated_at: Date
}

interface OtApprovalRefRow {
  id: string
  employee_id: string
  ot_date: string
  rate_class: string
  hours: string
  approved_by: string | null
  updated_at: Date
}

interface EmployeeRefRow {
  employee_id: string
  emp_code: string
  org_unit_id: string
  employment_type: string
  status: string
  updated_at: Date
}

interface CorrectionAuditRow {
  id: string
  day_record_id: string
  actor: string
  at: Date
  reason: string
  before: string
  after: string
}

interface OutboxRow {
  id: string
  topic: string
  payload: unknown
  created_at: Date
  published_at: Date | null
}

export class ConstraintViolation extends Error {
  constructor(readonly constraint: string) {
    super(`FakeTimesheetDb: violates constraint "${constraint}"`)
  }
}

function overlaps(aFrom: string, aTo: string, bFrom: string, bTo: string): boolean {
  return aFrom <= bTo && bFrom <= aTo
}

export class FakeTimesheetDb {
  readonly dayRecords = new Map<string, DayRecordRow>()
  readonly timeExceptions = new Map<string, TimeExceptionRow>()
  readonly periods = new Map<string, PeriodRow>()
  readonly rosterRefs = new Map<string, RosterRefRow>() // key: employee_id|work_date
  readonly leaveRefs = new Map<string, LeaveRefRow>() // key: leave_request_id
  readonly otApprovalRefs = new Map<string, OtApprovalRefRow>() // key: employee_id|ot_date
  readonly employeeRefs = new Map<string, EmployeeRefRow>()
  readonly correctionAudits = new Map<string, CorrectionAuditRow>()
  readonly outbox = new Map<string, OutboxRow>()
  readonly processedEvents = new Set<string>()

  connect(): FakeTimesheetConnection {
    return new FakeTimesheetConnection(this)
  }

  asPool(): Queryable {
    const conn = this.connect()
    return { query: (sql: string, params?: unknown[]) => conn.query(sql, params) }
  }

  debugOutboxRows(): OutboxRow[] {
    return [...this.outbox.values()]
  }
}

function rosterKey(employeeId: string, workDate: string): string {
  return `${employeeId}|${workDate}`
}
function otKey(employeeId: string, otDate: string): string {
  return `${employeeId}|${otDate}`
}

export class FakeTimesheetConnection implements Queryable {
  private inTx = false

  private pendingDayRecordInserts: DayRecordRow[] = []
  private pendingDayRecordUpdates: DayRecordRow[] = []
  private pendingExceptionInserts: TimeExceptionRow[] = []
  private pendingExceptionUpdates: TimeExceptionRow[] = []
  private pendingPeriodInserts: PeriodRow[] = []
  private pendingPeriodUpdates: PeriodRow[] = []
  private pendingRosterRefUpserts: Array<{ key: string; row: RosterRefRow }> = []
  private pendingLeaveRefUpserts: LeaveRefRow[] = []
  private pendingOtApprovalUpserts: Array<{ key: string; row: OtApprovalRefRow }> = []
  private pendingEmployeeRefUpserts: EmployeeRefRow[] = []
  private pendingCorrectionAuditInserts: CorrectionAuditRow[] = []
  private pendingOutboxInserts: OutboxRow[] = []
  private pendingProcessedEvents: string[] = []

  constructor(private readonly db: FakeTimesheetDb) {}

  release(_err?: Error): void {
    void _err
  }

  async query(sql: string, params: unknown[] = []): Promise<{ rows: Array<Record<string, unknown>> }> {
    const s = sql.trim()

    if (/^BEGIN\b/i.test(s)) {
      this.inTx = true
      this.resetPending()
      return { rows: [] }
    }
    if (/^COMMIT\b/i.test(s)) {
      this.commit()
      this.inTx = false
      return { rows: [] }
    }
    if (/^ROLLBACK\b/i.test(s)) {
      this.resetPending()
      this.inTx = false
      return { rows: [] }
    }

    // --- day_record ---
    // `applyCorrection`'s and `setActualIn`'s SQL both start with the same
    // prefix ("SET actual_in = $2") — the more specific pattern (both
    // columns) MUST be checked first, or every `applyCorrection` call gets
    // silently misrouted to `setActualIn`, which only fires when actual_in
    // is currently NULL (first-in-wins semantics that make no sense for an
    // explicit manual correction) and never touches actual_out/status at
    // all. Caught by `exceptions.service.test.ts`'s partial-correction case.
    if (/^INSERT INTO timesheet\.day_record\b/i.test(s)) return { rows: [this.ensureDayRecord(params)] }
    if (/^UPDATE timesheet\.day_record SET actual_in = \$2, actual_out = \$3/i.test(s)) return { rows: this.applyCorrection(params) }
    if (/^UPDATE timesheet\.day_record SET actual_in = \$2/i.test(s)) return { rows: this.setActualIn(params) }
    if (/^UPDATE timesheet\.day_record SET actual_out = \$2/i.test(s)) return { rows: this.setActualOut(params) }
    if (/^UPDATE timesheet\.day_record SET leave_code = \$2/i.test(s)) return { rows: this.setLeaveCode(params) }
    if (/^UPDATE timesheet\.day_record\s+SET worked_hours/i.test(s)) return { rows: this.updateComputed(params) }
    if (/^SELECT[\s\S]*FROM timesheet\.day_record\b/i.test(s)) return { rows: this.selectDayRecord(s, params) }

    // --- time_exception ---
    if (/^INSERT INTO timesheet\.time_exception\b/i.test(s)) return { rows: [this.insertException(params)] }
    if (/^UPDATE timesheet\.time_exception SET resolution = \$2, resolved_by = \$3[\s\S]*WHERE id = \$1 AND resolution IS NULL/i.test(s)) {
      return { rows: this.updateExceptionIfOpen(params) }
    }
    if (/^UPDATE timesheet\.time_exception SET resolution = \$2, resolved_by = \$3[\s\S]*WHERE id = \$1\s+RETURNING/i.test(s)) {
      return { rows: this.updateExceptionUnconditional(params) }
    }
    if (/^UPDATE timesheet\.time_exception SET resolution = \$2, updated_at/i.test(s)) return { rows: this.autoResolveException(params) }
    if (/^SELECT te\.[\s\S]*FROM timesheet\.time_exception te\s+JOIN timesheet\.day_record dr[\s\S]*resolution IS NULL AND dr\.work_date BETWEEN/i.test(s)) {
      return { rows: this.selectOpenExceptionsInRange(params) }
    }
    if (/^SELECT te\.[\s\S]*FROM timesheet\.time_exception te\s+JOIN timesheet\.day_record dr/i.test(s)) {
      return { rows: this.selectExceptionsByStatusAndEmployees(s, params) }
    }
    if (/^SELECT[\s\S]*FROM timesheet\.time_exception\b/i.test(s)) return { rows: this.selectException(s, params) }

    // --- period ---
    if (/^INSERT INTO timesheet\.period\b/i.test(s)) return { rows: [this.insertPeriod(params)] }
    if (/^UPDATE timesheet\.period\s+SET status = 'locked'/i.test(s)) return { rows: this.lockPeriod(params) }
    if (/^UPDATE timesheet\.period\s+SET status = 'open'/i.test(s)) return { rows: this.unlockPeriod(params) }
    if (/^SELECT[\s\S]*FROM timesheet\.period\b/i.test(s)) return { rows: this.selectPeriod(s, params) }

    // --- roster_ref ---
    if (/^INSERT INTO timesheet\.roster_ref\b/i.test(s)) return { rows: [this.upsertRosterRef(params)] }
    if (/^SELECT[\s\S]*FROM timesheet\.roster_ref\b/i.test(s)) return { rows: this.selectRosterRef(params) }

    // --- leave_ref ---
    if (/^INSERT INTO timesheet\.leave_ref\b/i.test(s)) return { rows: [this.upsertLeaveRef(params)] }
    if (/^UPDATE timesheet\.leave_ref SET status = 'cancelled'/i.test(s)) return { rows: this.cancelLeaveRef(params) }
    if (/^SELECT[\s\S]*FROM timesheet\.leave_ref\b/i.test(s)) return { rows: this.selectLeaveRef(s, params) }

    // --- ot_approval_ref ---
    if (/^INSERT INTO timesheet\.ot_approval_ref\b/i.test(s)) return { rows: [this.upsertOtApprovalRef(params)] }
    if (/^SELECT[\s\S]*FROM timesheet\.ot_approval_ref\b/i.test(s)) return { rows: this.selectOtApprovalRef(params) }

    // --- timesheet_employee_ref ---
    if (/^INSERT INTO timesheet\.timesheet_employee_ref\b/i.test(s)) return { rows: [this.upsertEmployeeRef(params)] }
    if (/^SELECT[\s\S]*FROM timesheet\.timesheet_employee_ref\b/i.test(s)) return { rows: this.selectEmployeeRef(s, params) }

    // --- correction_audit ---
    if (/^INSERT INTO timesheet\.correction_audit\b/i.test(s)) return { rows: [this.insertCorrectionAudit(params)] }
    if (/^SELECT[\s\S]*FROM timesheet\.correction_audit\b/i.test(s)) return { rows: this.selectCorrectionAudit(params) }

    // --- outbox / processed_events ---
    if (/^INSERT INTO\s+\S*outbox\b/i.test(s)) return { rows: [this.insertOutbox(params)] }
    if (/^INSERT INTO\s+\S*processed_events\b/i.test(s)) return { rows: this.insertProcessedEvent(params) }
    // kernel `outboxDepth` (event-bus health/metrics) — fixed SQL text this fake doesn't own, same precedent as the two lines above.
    if (/^SELECT\s+count\(\*\)/i.test(s) && /FROM\s+\S*outbox\b/i.test(s)) {
      const pending = [...this.db.outbox.values()].filter((r) => r.published_at === null)
      const oldestAgeSeconds =
        pending.length === 0 ? null : Math.max(0, (Date.now() - Math.min(...pending.map((r) => r.created_at.getTime()))) / 1000)
      return { rows: [{ pending: pending.length, oldest_age_seconds: oldestAgeSeconds }] }
    }

    throw new Error(`FakeTimesheetDb: unrecognised query: ${s}`)
  }

  // ---------- transaction plumbing ----------

  private resetPending(): void {
    this.pendingDayRecordInserts = []
    this.pendingDayRecordUpdates = []
    this.pendingExceptionInserts = []
    this.pendingExceptionUpdates = []
    this.pendingPeriodInserts = []
    this.pendingPeriodUpdates = []
    this.pendingRosterRefUpserts = []
    this.pendingLeaveRefUpserts = []
    this.pendingOtApprovalUpserts = []
    this.pendingEmployeeRefUpserts = []
    this.pendingCorrectionAuditInserts = []
    this.pendingOutboxInserts = []
    this.pendingProcessedEvents = []
  }

  private commit(): void {
    for (const r of this.pendingDayRecordInserts) this.db.dayRecords.set(r.id, r)
    for (const r of this.pendingDayRecordUpdates) this.db.dayRecords.set(r.id, r)
    for (const r of this.pendingExceptionInserts) this.db.timeExceptions.set(r.id, r)
    for (const r of this.pendingExceptionUpdates) this.db.timeExceptions.set(r.id, r)
    for (const r of this.pendingPeriodInserts) this.db.periods.set(r.id, r)
    for (const r of this.pendingPeriodUpdates) this.db.periods.set(r.id, r)
    for (const { key, row } of this.pendingRosterRefUpserts) this.db.rosterRefs.set(key, row)
    for (const r of this.pendingLeaveRefUpserts) this.db.leaveRefs.set(r.leave_request_id, r)
    for (const { key, row } of this.pendingOtApprovalUpserts) this.db.otApprovalRefs.set(key, row)
    for (const r of this.pendingEmployeeRefUpserts) this.db.employeeRefs.set(r.employee_id, r)
    for (const r of this.pendingCorrectionAuditInserts) this.db.correctionAudits.set(r.id, r)
    for (const r of this.pendingOutboxInserts) this.db.outbox.set(r.id, r)
    for (const id of this.pendingProcessedEvents) this.db.processedEvents.add(id)
  }

  // ---------- day_record ----------

  private visibleDayRecords(): DayRecordRow[] {
    const byId = new Map<string, DayRecordRow>()
    for (const r of this.db.dayRecords.values()) byId.set(r.id, r)
    for (const r of this.pendingDayRecordInserts) byId.set(r.id, r)
    for (const r of this.pendingDayRecordUpdates) byId.set(r.id, r)
    return [...byId.values()]
  }

  private ensureDayRecord(params: unknown[]): Record<string, unknown> {
    const [employeeId, workDate, rosterEntryId] = params as [string, string, string | null]
    const existing = this.visibleDayRecords().find((r) => r.employee_id === employeeId && r.work_date === workDate)
    if (existing) {
      const updated: DayRecordRow = {
        ...existing,
        roster_entry_id: existing.roster_entry_id ?? rosterEntryId,
        updated_at: new Date(),
      }
      if (this.inTx) this.pendingDayRecordUpdates.push(updated)
      else this.db.dayRecords.set(updated.id, updated)
      return { ...updated }
    }
    const now = new Date()
    const row: DayRecordRow = {
      id: randomUUID(),
      employee_id: employeeId,
      work_date: workDate,
      roster_entry_id: rosterEntryId,
      actual_in: null,
      actual_out: null,
      worked_hours: '0',
      late_min: '0',
      ot_15x: '0',
      ot_2x: '0',
      ot_3x: '0',
      leave_code: null,
      status: 'ok',
      created_at: now,
      updated_at: now,
    }
    if (this.inTx) this.pendingDayRecordInserts.push(row)
    else this.db.dayRecords.set(row.id, row)
    return { ...row }
  }

  private findVisibleDayRecordById(id: string): DayRecordRow | undefined {
    return [...this.visibleDayRecords()].reverse().find((r) => r.id === id)
  }

  private setActualIn(params: unknown[]): Array<Record<string, unknown>> {
    const [id, actualIn] = params as [string, string]
    const current = this.findVisibleDayRecordById(id)
    if (!current || current.actual_in !== null) return []
    const updated: DayRecordRow = { ...current, actual_in: actualIn, updated_at: new Date() }
    if (this.inTx) this.pendingDayRecordUpdates.push(updated)
    else this.db.dayRecords.set(updated.id, updated)
    return [{ ...updated }]
  }

  private setActualOut(params: unknown[]): Array<Record<string, unknown>> {
    const [id, actualOut] = params as [string, string]
    const current = this.findVisibleDayRecordById(id)
    if (!current) return []
    const updated: DayRecordRow = { ...current, actual_out: actualOut, updated_at: new Date() }
    if (this.inTx) this.pendingDayRecordUpdates.push(updated)
    else this.db.dayRecords.set(updated.id, updated)
    return [{ ...updated }]
  }

  private setLeaveCode(params: unknown[]): Array<Record<string, unknown>> {
    const [id, leaveCode] = params as [string, string | null]
    const current = this.findVisibleDayRecordById(id)
    if (!current) return []
    const updated: DayRecordRow = { ...current, leave_code: leaveCode, updated_at: new Date() }
    if (this.inTx) this.pendingDayRecordUpdates.push(updated)
    else this.db.dayRecords.set(updated.id, updated)
    return [{ ...updated }]
  }

  private updateComputed(params: unknown[]): Array<Record<string, unknown>> {
    const [id, workedHours, lateMin, ot15x, ot2x, ot3x, status] = params as [string, string, string, string, string, string, string]
    const current = this.findVisibleDayRecordById(id)
    if (!current) return []
    const updated: DayRecordRow = {
      ...current,
      worked_hours: workedHours,
      late_min: lateMin,
      ot_15x: ot15x,
      ot_2x: ot2x,
      ot_3x: ot3x,
      status,
      updated_at: new Date(),
    }
    if (this.inTx) this.pendingDayRecordUpdates.push(updated)
    else this.db.dayRecords.set(updated.id, updated)
    return [{ ...updated }]
  }

  private applyCorrection(params: unknown[]): Array<Record<string, unknown>> {
    const [id, actualIn, actualOut] = params as [string, string | null, string | null]
    const current = this.findVisibleDayRecordById(id)
    if (!current) return []
    const updated: DayRecordRow = { ...current, actual_in: actualIn, actual_out: actualOut, status: 'corrected', updated_at: new Date() }
    if (this.inTx) this.pendingDayRecordUpdates.push(updated)
    else this.db.dayRecords.set(updated.id, updated)
    return [{ ...updated }]
  }

  private selectDayRecord(sql: string, params: unknown[]): Array<Record<string, unknown>> {
    const visible = this.visibleDayRecords()
    if (/GROUP BY employee_id/i.test(sql)) {
      const [from, to] = params as [string, string]
      const byEmployee = new Map<string, DayRecordRow[]>()
      for (const r of visible) {
        if (r.work_date < from || r.work_date > to) continue
        const list = byEmployee.get(r.employee_id) ?? []
        list.push(r)
        byEmployee.set(r.employee_id, list)
      }
      const sumDecimal = (values: string[]): string => {
        // Same discipline as the real SQL: sum as exact decimals, never
        // through a float — good enough fidelity for this fake since every
        // value it sums is itself a 2-decimal `hours.ts` string.
        const cents = values.reduce((acc, v) => acc + Math.round(Number.parseFloat(v) * 100), 0)
        return (cents / 100).toString()
      }
      return [...byEmployee.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([employeeId, rows]) => ({
          employee_id: employeeId,
          days_worked: String(rows.filter((r) => Number.parseFloat(r.worked_hours) > 0).length),
          hours_worked: sumDecimal(rows.map((r) => r.worked_hours)),
          ot_workday_hours: sumDecimal(rows.map((r) => r.ot_15x)),
          ot_holiday_work_hours: sumDecimal(rows.map((r) => r.ot_2x)),
          ot_holiday_ot_hours: sumDecimal(rows.map((r) => r.ot_3x)),
        }))
    }
    if (/WHERE id = \$1/i.test(sql)) {
      const [id] = params as [string]
      return visible.filter((r) => r.id === id).map((r) => ({ ...r }))
    }
    if (/employee_id = \$1 AND work_date = \$2/i.test(sql)) {
      const [employeeId, workDate] = params as [string, string]
      return visible.filter((r) => r.employee_id === employeeId && r.work_date === workDate).map((r) => ({ ...r }))
    }
    if (/actual_in IS NOT NULL AND actual_out IS NULL/i.test(sql)) {
      const [employeeId, beforeIso, lookbackMinutes] = params as [string, string, number]
      const beforeMs = Date.parse(beforeIso)
      const lookbackMs = lookbackMinutes * 60_000
      const candidates = visible
        .filter((r) => r.employee_id === employeeId && r.actual_in !== null && r.actual_out === null)
        .filter((r) => {
          const inMs = Date.parse(r.actual_in as string)
          return inMs <= beforeMs && inMs >= beforeMs - lookbackMs
        })
        .sort((a, b) => Date.parse(b.actual_in as string) - Date.parse(a.actual_in as string))
      return candidates.length > 0 ? [{ ...(candidates[0] as DayRecordRow) }] : []
    }
    if (/work_date BETWEEN \$1 AND \$2 AND \(\$3::text\[\] IS NULL/i.test(sql)) {
      const [from, to, employeeIds] = params as [string, string, string[] | null]
      return visible
        .filter((r) => r.work_date >= from && r.work_date <= to && (employeeIds === null || employeeIds.includes(r.employee_id)))
        .sort((a, b) => (a.employee_id === b.employee_id ? (a.work_date < b.work_date ? -1 : 1) : a.employee_id < b.employee_id ? -1 : 1))
        .map((r) => ({ ...r }))
    }
    throw new Error(`FakeTimesheetDb: unrecognised day_record SELECT: ${sql}`)
  }

  // ---------- time_exception ----------

  private visibleExceptions(): TimeExceptionRow[] {
    const byId = new Map<string, TimeExceptionRow>()
    for (const r of this.db.timeExceptions.values()) byId.set(r.id, r)
    for (const r of this.pendingExceptionInserts) byId.set(r.id, r)
    for (const r of this.pendingExceptionUpdates) byId.set(r.id, r)
    return [...byId.values()]
  }

  private insertException(params: unknown[]): Record<string, unknown> {
    const [dayRecordId, kind, reason] = params as [string, string, string | null]
    if (!['missed_punch', 'late', 'absence', 'unapproved_ot'].includes(kind)) {
      throw new ConstraintViolation('time_exception_kind_check')
    }
    const now = new Date()
    const row: TimeExceptionRow = {
      id: randomUUID(),
      day_record_id: dayRecordId,
      kind,
      resolution: null,
      resolved_by: null,
      reason,
      created_at: now,
      updated_at: now,
    }
    if (this.inTx) this.pendingExceptionInserts.push(row)
    else this.db.timeExceptions.set(row.id, row)
    return { ...row }
  }

  private findVisibleExceptionById(id: string): TimeExceptionRow | undefined {
    return [...this.visibleExceptions()].reverse().find((r) => r.id === id)
  }

  private updateExceptionIfOpen(params: unknown[]): Array<Record<string, unknown>> {
    const [id, resolution, resolvedBy] = params as [string, string, string]
    const current = this.findVisibleExceptionById(id)
    if (!current || current.resolution !== null) return []
    const updated: TimeExceptionRow = { ...current, resolution, resolved_by: resolvedBy, updated_at: new Date() }
    if (this.inTx) this.pendingExceptionUpdates.push(updated)
    else this.db.timeExceptions.set(updated.id, updated)
    return [{ ...updated }]
  }

  private updateExceptionUnconditional(params: unknown[]): Array<Record<string, unknown>> {
    const [id, resolution, resolvedBy] = params as [string, string, string]
    const current = this.findVisibleExceptionById(id)
    if (!current) return []
    const updated: TimeExceptionRow = { ...current, resolution, resolved_by: resolvedBy, updated_at: new Date() }
    if (this.inTx) this.pendingExceptionUpdates.push(updated)
    else this.db.timeExceptions.set(updated.id, updated)
    return [{ ...updated }]
  }

  private autoResolveException(params: unknown[]): Array<Record<string, unknown>> {
    const [id, resolution] = params as [string, string]
    const current = this.findVisibleExceptionById(id)
    if (!current || current.resolution !== null) return []
    const updated: TimeExceptionRow = { ...current, resolution, updated_at: new Date() }
    if (this.inTx) this.pendingExceptionUpdates.push(updated)
    else this.db.timeExceptions.set(updated.id, updated)
    return [{ ...updated }]
  }

  private selectException(sql: string, params: unknown[]): Array<Record<string, unknown>> {
    const visible = this.visibleExceptions()
    if (/WHERE id = \$1/i.test(sql)) {
      const [id] = params as [string]
      return visible.filter((r) => r.id === id).map((r) => ({ ...r }))
    }
    if (/day_record_id = \$1 AND kind = \$2 AND resolution IS NULL/i.test(sql)) {
      const [dayRecordId, kind] = params as [string, string]
      return visible.filter((r) => r.day_record_id === dayRecordId && r.kind === kind && r.resolution === null).map((r) => ({ ...r }))
    }
    if (/day_record_id = \$1 ORDER BY/i.test(sql)) {
      const [dayRecordId] = params as [string]
      return visible
        .filter((r) => r.day_record_id === dayRecordId)
        .sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
        .map((r) => ({ ...r }))
    }
    throw new Error(`FakeTimesheetDb: unrecognised time_exception SELECT: ${sql}`)
  }

  private dayRecordDateOf(dayRecordId: string): { workDate: string; employeeId: string } | undefined {
    const dr = this.visibleDayRecords().find((r) => r.id === dayRecordId)
    return dr ? { workDate: dr.work_date, employeeId: dr.employee_id } : undefined
  }

  private selectOpenExceptionsInRange(params: unknown[]): Array<Record<string, unknown>> {
    const [from, to] = params as [string, string]
    return this.visibleExceptions()
      .filter((r) => r.resolution === null)
      .filter((r) => {
        const dr = this.dayRecordDateOf(r.day_record_id)
        return dr !== undefined && dr.workDate >= from && dr.workDate <= to
      })
      .map((r) => ({ ...r }))
  }

  private selectExceptionsByStatusAndEmployees(sql: string, params: unknown[]): Array<Record<string, unknown>> {
    const [employeeIds] = params as [string[] | null]
    const wantsOpen = /te\.resolution IS NULL/.test(sql)
    return this.visibleExceptions()
      .filter((r) => (wantsOpen ? r.resolution === null : r.resolution !== null))
      .filter((r) => {
        const dr = this.dayRecordDateOf(r.day_record_id)
        return dr !== undefined && (employeeIds === null || employeeIds.includes(dr.employeeId))
      })
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
      .map((r) => ({ ...r }))
  }

  // ---------- period ----------

  private visiblePeriods(): PeriodRow[] {
    const byId = new Map<string, PeriodRow>()
    for (const r of this.db.periods.values()) byId.set(r.id, r)
    for (const r of this.pendingPeriodInserts) byId.set(r.id, r)
    for (const r of this.pendingPeriodUpdates) byId.set(r.id, r)
    return [...byId.values()]
  }

  private insertPeriod(params: unknown[]): Record<string, unknown> {
    const [from, to] = params as [string, string]
    if (this.visiblePeriods().some((p) => overlaps(p.from_date, p.to_date, from, to))) {
      throw new ConstraintViolation('period_no_overlap')
    }
    const now = new Date()
    const row: PeriodRow = {
      id: randomUUID(),
      from_date: from,
      to_date: to,
      status: 'open',
      lock_version: 0,
      locked_by: null,
      locked_at: null,
      created_at: now,
      updated_at: now,
    }
    if (this.inTx) this.pendingPeriodInserts.push(row)
    else this.db.periods.set(row.id, row)
    return { ...row }
  }

  private findVisiblePeriodById(id: string): PeriodRow | undefined {
    return [...this.visiblePeriods()].reverse().find((r) => r.id === id)
  }

  private lockPeriod(params: unknown[]): Array<Record<string, unknown>> {
    const [id, lockedBy] = params as [string, string]
    const current = this.findVisiblePeriodById(id)
    if (!current || current.status !== 'open') return []
    const updated: PeriodRow = {
      ...current,
      status: 'locked',
      lock_version: current.lock_version + 1,
      locked_by: lockedBy,
      locked_at: new Date(),
      updated_at: new Date(),
    }
    if (this.inTx) this.pendingPeriodUpdates.push(updated)
    else this.db.periods.set(updated.id, updated)
    return [{ ...updated }]
  }

  private unlockPeriod(params: unknown[]): Array<Record<string, unknown>> {
    const [id] = params as [string]
    const current = this.findVisiblePeriodById(id)
    if (!current || current.status !== 'locked') return []
    const updated: PeriodRow = { ...current, status: 'open', locked_by: null, locked_at: null, updated_at: new Date() }
    if (this.inTx) this.pendingPeriodUpdates.push(updated)
    else this.db.periods.set(updated.id, updated)
    return [{ ...updated }]
  }

  private selectPeriod(sql: string, params: unknown[]): Array<Record<string, unknown>> {
    const visible = this.visiblePeriods()
    if (/WHERE id = \$1/i.test(sql)) {
      const [id] = params as [string]
      return visible.filter((r) => r.id === id).map((r) => ({ ...r }))
    }
    if (/range @> \$1::date/i.test(sql)) {
      const [date] = params as [string]
      return visible.filter((r) => r.from_date <= date && date <= r.to_date).map((r) => ({ ...r }))
    }
    return visible
      .slice()
      .sort((a, b) => (a.from_date < b.from_date ? -1 : 1))
      .map((r) => ({ ...r }))
  }

  // ---------- roster_ref ----------

  private visibleRosterRefs(): Map<string, RosterRefRow> {
    const merged = new Map<string, RosterRefRow>(this.db.rosterRefs)
    for (const { key, row } of this.pendingRosterRefUpserts) merged.set(key, row)
    return merged
  }

  private upsertRosterRef(params: unknown[]): Record<string, unknown> {
    const [employeeId, workDate, scheduledStart, scheduledEnd, graceMin, hazardous, isHoliday, rosterEntryId] = params as [
      string,
      string,
      string | null,
      string | null,
      number,
      boolean,
      boolean,
      string | null,
    ]
    if (graceMin < 0) throw new ConstraintViolation('roster_ref_grace_min_check')
    const key = rosterKey(employeeId, workDate)
    const row: RosterRefRow = {
      employee_id: employeeId,
      work_date: workDate,
      scheduled_start: scheduledStart,
      scheduled_end: scheduledEnd,
      grace_min: graceMin,
      hazardous,
      is_holiday: isHoliday,
      roster_entry_id: rosterEntryId,
      updated_at: new Date(),
    }
    if (this.inTx) this.pendingRosterRefUpserts.push({ key, row })
    else this.db.rosterRefs.set(key, row)
    return { ...row }
  }

  private selectRosterRef(params: unknown[]): Array<Record<string, unknown>> {
    const [employeeId, workDate] = params as [string, string]
    const row = this.visibleRosterRefs().get(rosterKey(employeeId, workDate))
    return row ? [{ ...row }] : []
  }

  // ---------- leave_ref ----------

  private visibleLeaveRefs(): LeaveRefRow[] {
    const byKey = new Map<string, LeaveRefRow>()
    for (const r of this.db.leaveRefs.values()) byKey.set(r.leave_request_id, r)
    for (const r of this.pendingLeaveRefUpserts) byKey.set(r.leave_request_id, r)
    return [...byKey.values()]
  }

  private upsertLeaveRef(params: unknown[]): Record<string, unknown> {
    const [employeeId, leaveRequestId, dateFrom, dateTo, leaveTypeCode, payMode] = params as [
      string,
      string,
      string,
      string,
      string,
      string,
    ]
    const current = this.visibleLeaveRefs().find((r) => r.leave_request_id === leaveRequestId)
    const row: LeaveRefRow = {
      id: current?.id ?? randomUUID(),
      employee_id: employeeId,
      leave_request_id: leaveRequestId,
      date_from: dateFrom,
      date_to: dateTo,
      leave_type_code: leaveTypeCode,
      pay_mode: payMode,
      status: 'approved',
      updated_at: new Date(),
    }
    if (this.inTx) this.pendingLeaveRefUpserts.push(row)
    else this.db.leaveRefs.set(row.leave_request_id, row)
    return { ...row }
  }

  private cancelLeaveRef(params: unknown[]): Array<Record<string, unknown>> {
    const [leaveRequestId] = params as [string]
    const current = this.visibleLeaveRefs().find((r) => r.leave_request_id === leaveRequestId)
    if (!current) return []
    const updated: LeaveRefRow = { ...current, status: 'cancelled', updated_at: new Date() }
    if (this.inTx) this.pendingLeaveRefUpserts.push(updated)
    else this.db.leaveRefs.set(updated.leave_request_id, updated)
    return [{ ...updated }]
  }

  private selectLeaveRef(sql: string, params: unknown[]): Array<Record<string, unknown>> {
    const visible = this.visibleLeaveRefs()
    if (/WHERE leave_request_id = \$1/i.test(sql)) {
      const [leaveRequestId] = params as [string]
      return visible.filter((r) => r.leave_request_id === leaveRequestId).map((r) => ({ ...r }))
    }
    if (/employee_id = \$1 AND status = 'approved' AND date_from <= \$2 AND date_to >= \$2/i.test(sql)) {
      const [employeeId, date] = params as [string, string]
      return visible
        .filter((r) => r.employee_id === employeeId && r.status === 'approved' && r.date_from <= date && r.date_to >= date)
        .map((r) => ({ ...r }))
    }
    throw new Error(`FakeTimesheetDb: unrecognised leave_ref SELECT: ${sql}`)
  }

  // ---------- ot_approval_ref ----------

  private visibleOtApprovalRefs(): Map<string, OtApprovalRefRow> {
    const merged = new Map<string, OtApprovalRefRow>(this.db.otApprovalRefs)
    for (const { key, row } of this.pendingOtApprovalUpserts) merged.set(key, row)
    return merged
  }

  private upsertOtApprovalRef(params: unknown[]): Record<string, unknown> {
    const [employeeId, otDate, rateClass, hours, approvedBy] = params as [string, string, string, string, string | null]
    if (Number.parseFloat(hours) < 0) throw new ConstraintViolation('ot_approval_ref_hours_check')
    const key = otKey(employeeId, otDate)
    const existing = this.visibleOtApprovalRefs().get(key)
    const totalHours = (Number.parseFloat(existing?.hours ?? '0') + Number.parseFloat(hours)).toString()
    const row: OtApprovalRefRow = {
      id: existing?.id ?? randomUUID(),
      employee_id: employeeId,
      ot_date: otDate,
      rate_class: rateClass,
      hours: totalHours,
      approved_by: approvedBy,
      updated_at: new Date(),
    }
    if (this.inTx) this.pendingOtApprovalUpserts.push({ key, row })
    else this.db.otApprovalRefs.set(key, row)
    return { ...row }
  }

  private selectOtApprovalRef(params: unknown[]): Array<Record<string, unknown>> {
    const [employeeId, otDate] = params as [string, string]
    const row = this.visibleOtApprovalRefs().get(otKey(employeeId, otDate))
    return row ? [{ ...row }] : []
  }

  // ---------- timesheet_employee_ref ----------

  private visibleEmployeeRefs(): EmployeeRefRow[] {
    const byId = new Map<string, EmployeeRefRow>()
    for (const r of this.db.employeeRefs.values()) byId.set(r.employee_id, r)
    for (const r of this.pendingEmployeeRefUpserts) byId.set(r.employee_id, r)
    return [...byId.values()]
  }

  private upsertEmployeeRef(params: unknown[]): Record<string, unknown> {
    const [employeeId, empCode, orgUnitId, employmentType, status] = params as [string, string, string, string, string]
    if (!['monthly', 'daily', 'hourly', 'contract'].includes(employmentType)) {
      throw new ConstraintViolation('timesheet_employee_ref_employment_type_check')
    }
    if (!['onboarding', 'active', 'terminated'].includes(status)) {
      throw new ConstraintViolation('timesheet_employee_ref_status_check')
    }
    const row: EmployeeRefRow = {
      employee_id: employeeId,
      emp_code: empCode,
      org_unit_id: orgUnitId,
      employment_type: employmentType,
      status,
      updated_at: new Date(),
    }
    if (this.inTx) this.pendingEmployeeRefUpserts.push(row)
    else this.db.employeeRefs.set(row.employee_id, row)
    return { ...row }
  }

  private selectEmployeeRef(sql: string, params: unknown[]): Array<Record<string, unknown>> {
    const visible = this.visibleEmployeeRefs()
    if (/WHERE employee_id = \$1/i.test(sql)) {
      const [employeeId] = params as [string]
      return visible.filter((r) => r.employee_id === employeeId).map((r) => ({ ...r }))
    }
    if (/WHERE org_unit_id = ANY\(\$1\)/i.test(sql)) {
      const [orgUnitIds] = params as [string[]]
      return visible.filter((r) => orgUnitIds.includes(r.org_unit_id)).map((r) => ({ ...r }))
    }
    throw new Error(`FakeTimesheetDb: unrecognised timesheet_employee_ref SELECT: ${sql}`)
  }

  // ---------- correction_audit ----------

  private visibleCorrectionAudits(): CorrectionAuditRow[] {
    const byId = new Map<string, CorrectionAuditRow>()
    for (const r of this.db.correctionAudits.values()) byId.set(r.id, r)
    for (const r of this.pendingCorrectionAuditInserts) byId.set(r.id, r)
    return [...byId.values()]
  }

  private insertCorrectionAudit(params: unknown[]): Record<string, unknown> {
    const [dayRecordId, actor, reason, before, after] = params as [string, string, string, string, string]
    const row: CorrectionAuditRow = {
      id: randomUUID(),
      day_record_id: dayRecordId,
      actor,
      at: new Date(),
      reason,
      before,
      after,
    }
    if (this.inTx) this.pendingCorrectionAuditInserts.push(row)
    else this.db.correctionAudits.set(row.id, row)
    return { ...row }
  }

  private selectCorrectionAudit(params: unknown[]): Array<Record<string, unknown>> {
    const [dayRecordId] = params as [string]
    return this.visibleCorrectionAudits()
      .filter((r) => r.day_record_id === dayRecordId)
      .sort((a, b) => a.at.getTime() - b.at.getTime())
      .map((r) => ({ ...r }))
  }

  // ---------- outbox / processed_events ----------

  private insertOutbox(params: unknown[]): Record<string, unknown> {
    const [topic, payloadJson] = params as [string, string]
    const row: OutboxRow = {
      id: randomUUID(),
      topic,
      payload: JSON.parse(payloadJson) as unknown,
      created_at: new Date(),
      published_at: null,
    }
    if (this.inTx) this.pendingOutboxInserts.push(row)
    else this.db.outbox.set(row.id, row)
    return { id: row.id }
  }

  private insertProcessedEvent(params: unknown[]): Array<Record<string, unknown>> {
    const [eventId] = params as [string]
    const alreadyCommitted = this.db.processedEvents.has(eventId)
    const alreadyPendingHere = this.pendingProcessedEvents.includes(eventId)
    if (alreadyCommitted || alreadyPendingHere) return []
    if (this.inTx) this.pendingProcessedEvents.push(eventId)
    else this.db.processedEvents.add(eventId)
    return [{ event_id: eventId }]
  }
}
