import { randomUUID } from 'node:crypto'
import type { Queryable } from '@gadong/kernel'

/**
 * A tiny in-memory stand-in for Postgres, scoped to the `scheduler` schema
 * — same reason and shape as `services/svc-config/src/testing/fake-db.ts`
 * and kernel's `outbox/testing/fake-db.ts`: there is no Postgres in this
 * environment (brief CONSTRAINTS), so every repository here is proven
 * against a fake instead. `migrations/*.js` is the source of truth for the
 * real schema.
 *
 * One `FakeSchedulerDb` holds the COMMITTED store for every table this
 * service owns; `connect()` returns an independent session
 * (`FakeSchedulerConnection`) whose writes are staged locally and only
 * join the committed store on `COMMIT` — the same session-isolation
 * `writeOutbox`/`idempotent` tests rely on to prove they genuinely
 * participate in the caller's transaction.
 */

interface ShiftRow {
  id: string
  name_i18n: string
  start_t: string
  end_t: string
  crosses_midnight: boolean
  break_rules: string
  grace_min: number
  differential: string
  created_at: Date
  updated_at: Date
}

interface RosterEntryRow {
  id: string
  employee_id: string
  shift_id: string
  work_date: string
  status: string
  override_reason: string | null
  hazardous: boolean
  created_at: Date
  updated_at: Date
}

interface EmployeeRefRow {
  employee_id: string
  emp_code: string | null
  status: string | null
  org_unit_id: string | null
  updated_at: Date
}

interface LeaveRefRow {
  id: string
  employee_id: string
  leave_request_id: string
  date_from: string
  date_to: string
  status: string
  updated_at: Date
}

interface HolidayCalendarRow {
  id: string
  year: number
}

interface HolidayRow {
  id: string
  calendar_id: string
  holiday_date: string
  name_i18n: string
  is_substitute: boolean
  substitute_for_id: string | null
  created_at: Date
}

interface OtRequestRow {
  id: string
  employee_id: string
  ot_date: string
  hours: string
  rate_class: string
  status: string
  approved_by: string | null
  reason: string
  employee_consent: boolean
  decision_reason: string | null
  created_at: Date
  updated_at: Date
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
    super(`FakeSchedulerDb: violates constraint "${constraint}"`)
  }
}

export class FakeSchedulerDb {
  readonly shifts = new Map<string, ShiftRow>()
  readonly rosterEntries = new Map<string, RosterEntryRow>()
  readonly employeeRefs = new Map<string, EmployeeRefRow>()
  readonly leaveRefsByRequestId = new Map<string, LeaveRefRow>()
  readonly holidayCalendars = new Map<string, HolidayCalendarRow>()
  readonly holidays = new Map<string, HolidayRow>()
  readonly otRequests = new Map<string, OtRequestRow>()
  readonly outbox = new Map<string, OutboxRow>()
  readonly processedEvents = new Set<string>()

  connect(): FakeSchedulerConnection {
    return new FakeSchedulerConnection(this)
  }

  asPool(): Queryable {
    const conn = this.connect()
    return { query: (sql: string, params?: unknown[]) => conn.query(sql, params) }
  }

  debugOutboxRows(): OutboxRow[] {
    return [...this.outbox.values()]
  }
}

function jsonRow<T extends Record<string, unknown> | ShiftRow | HolidayRow>(
  row: T,
  jsonFields: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(row as Record<string, unknown>) }
  for (const f of jsonFields) {
    const v = out[f]
    if (typeof v === 'string') out[f] = JSON.parse(v) as unknown
  }
  return out
}

/** One session/connection. Mirrors `services/svc-config`'s `FakeConfigConnection`: writes made in a transaction are staged locally and only become visible (to other sessions, and to this session's own subsequent reads via `visible*`) on `COMMIT`. */
export class FakeSchedulerConnection implements Queryable {
  private inTx = false

  private pendingShiftInserts: ShiftRow[] = []
  private pendingShiftUpdates: ShiftRow[] = []
  private pendingRosterInserts: RosterEntryRow[] = []
  private pendingRosterUpdates: RosterEntryRow[] = []
  private pendingEmployeeRefUpserts: EmployeeRefRow[] = []
  private pendingLeaveRefUpserts: LeaveRefRow[] = []
  private pendingCalendarInserts: HolidayCalendarRow[] = []
  private pendingHolidayInserts: HolidayRow[] = []
  private pendingHolidayDeletesByCalendar: string[] = []
  private pendingOtInserts: OtRequestRow[] = []
  private pendingOtUpdates: OtRequestRow[] = []
  private pendingOutboxInserts: OutboxRow[] = []
  private pendingProcessedEvents: string[] = []

  constructor(private readonly db: FakeSchedulerDb) {}

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

    // --- shift ---
    if (/^INSERT INTO scheduler\.shift\b/i.test(s)) return { rows: [this.insertShift(params)] }
    if (/^UPDATE scheduler\.shift\b/i.test(s)) return { rows: this.updateShift(params) }
    if (/^SELECT[\s\S]*FROM scheduler\.shift\b/i.test(s)) return { rows: this.selectShift(s, params) }

    // --- roster_entry ---
    if (/^INSERT INTO scheduler\.roster_entry\b/i.test(s)) return { rows: [this.insertRosterEntry(params)] }
    if (/^UPDATE scheduler\.roster_entry SET override_reason/i.test(s)) return { rows: this.setOverrideReason(params) }
    if (/^UPDATE scheduler\.roster_entry[\s\S]*SET status = 'published'/i.test(s)) return { rows: this.publishRange(params) }
    if (/^SELECT[\s\S]*FROM scheduler\.roster_entry\b/i.test(s)) return { rows: this.selectRosterEntry(s, params) }

    // --- scheduler_employee_ref ---
    if (/^INSERT INTO scheduler\.scheduler_employee_ref\b/i.test(s)) return { rows: [this.upsertEmployeeRef(params)] }
    if (/^SELECT[\s\S]*FROM scheduler\.scheduler_employee_ref\b/i.test(s)) {
      return { rows: this.selectEmployeeRef(s, params) }
    }

    // --- leave_ref ---
    if (/^INSERT INTO scheduler\.leave_ref\b/i.test(s)) return { rows: [this.upsertLeaveRef(params)] }
    if (/^UPDATE scheduler\.leave_ref SET status = 'cancelled'/i.test(s)) return { rows: this.cancelLeaveRef(params) }
    if (/^SELECT[\s\S]*FROM scheduler\.leave_ref\b/i.test(s)) return { rows: this.selectLeaveRef(params) }

    // --- holiday_calendar / holiday ---
    if (/^SELECT id, year FROM scheduler\.holiday_calendar\b/i.test(s)) return { rows: this.selectCalendar(params) }
    if (/^INSERT INTO scheduler\.holiday_calendar\b/i.test(s)) return { rows: [this.insertCalendar(params)] }
    if (/^DELETE FROM scheduler\.holiday\b/i.test(s)) {
      this.deleteHolidaysByCalendar(params)
      return { rows: [] }
    }
    if (/^INSERT INTO scheduler\.holiday\b/i.test(s)) return { rows: [this.insertHoliday(params)] }
    if (/^SELECT[\s\S]*FROM scheduler\.holiday\b/i.test(s)) return { rows: this.selectHoliday(params) }

    // --- ot_request ---
    if (/^INSERT INTO scheduler\.ot_request\b/i.test(s)) return { rows: [this.insertOt(params)] }
    if (/^UPDATE scheduler\.ot_request\b/i.test(s)) return { rows: this.decideOt(params) }
    if (/^SELECT[\s\S]*FROM scheduler\.ot_request\b/i.test(s)) return { rows: this.selectOt(s, params) }

    // --- outbox / processed_events (matching kernel's own fake-db shapes) ---
    if (/^INSERT INTO\s+\S*outbox\b/i.test(s)) return { rows: [this.insertOutbox(params)] }
    if (/^INSERT INTO\s+\S*processed_events\b/i.test(s)) return { rows: this.insertProcessedEvent(s, params) }

    // kernel `outboxDepth` (event-bus health/metrics) — fixed SQL text this fake doesn't own, same precedent as the two branches above.
    if (/^SELECT\s+count\(\*\)/i.test(s) && /FROM\s+\S*outbox\b/i.test(s)) {
      const pending = this.db.debugOutboxRows().filter((r) => r.published_at === null)
      const oldestAgeSeconds =
        pending.length === 0 ? null : Math.max(0, (Date.now() - Math.min(...pending.map((r) => r.created_at.getTime()))) / 1000)
      return { rows: [{ pending: pending.length, oldest_age_seconds: oldestAgeSeconds }] }
    }

    throw new Error(`FakeSchedulerDb: unrecognised query: ${s}`)
  }

  // ---------- transaction plumbing ----------

  private resetPending(): void {
    this.pendingShiftInserts = []
    this.pendingShiftUpdates = []
    this.pendingRosterInserts = []
    this.pendingRosterUpdates = []
    this.pendingEmployeeRefUpserts = []
    this.pendingLeaveRefUpserts = []
    this.pendingCalendarInserts = []
    this.pendingHolidayInserts = []
    this.pendingHolidayDeletesByCalendar = []
    this.pendingOtInserts = []
    this.pendingOtUpdates = []
    this.pendingOutboxInserts = []
    this.pendingProcessedEvents = []
  }

  private commit(): void {
    for (const r of this.pendingShiftInserts) this.db.shifts.set(r.id, r)
    for (const r of this.pendingShiftUpdates) this.db.shifts.set(r.id, r)
    for (const r of this.pendingRosterInserts) this.db.rosterEntries.set(r.id, r)
    for (const r of this.pendingRosterUpdates) this.db.rosterEntries.set(r.id, r)
    for (const r of this.pendingEmployeeRefUpserts) this.db.employeeRefs.set(r.employee_id, r)
    for (const r of this.pendingLeaveRefUpserts) this.db.leaveRefsByRequestId.set(r.leave_request_id, r)
    for (const r of this.pendingCalendarInserts) this.db.holidayCalendars.set(r.id, r)
    for (const calendarId of this.pendingHolidayDeletesByCalendar) {
      for (const [id, h] of this.db.holidays) if (h.calendar_id === calendarId) this.db.holidays.delete(id)
    }
    for (const r of this.pendingHolidayInserts) this.db.holidays.set(r.id, r)
    for (const r of this.pendingOtInserts) this.db.otRequests.set(r.id, r)
    for (const r of this.pendingOtUpdates) this.db.otRequests.set(r.id, r)
    for (const r of this.pendingOutboxInserts) this.db.outbox.set(r.id, r)
    for (const id of this.pendingProcessedEvents) this.db.processedEvents.add(id)
  }

  // ---------- shift ----------

  private visibleShifts(): ShiftRow[] {
    const byId = new Map<string, ShiftRow>()
    for (const r of this.db.shifts.values()) byId.set(r.id, r)
    for (const r of this.pendingShiftInserts) byId.set(r.id, r)
    for (const r of this.pendingShiftUpdates) byId.set(r.id, r)
    return [...byId.values()]
  }

  private insertShift(params: unknown[]): Record<string, unknown> {
    const [nameI18n, startT, endT, crossesMidnight, breakRules, graceMin, differential] = params as [
      string,
      string,
      string,
      boolean,
      string,
      number,
      string,
    ]
    if (graceMin < 0) throw new ConstraintViolation('shift_grace_min_check')
    const now = new Date()
    const row: ShiftRow = {
      id: randomUUID(),
      name_i18n: nameI18n,
      start_t: startT,
      end_t: endT,
      crosses_midnight: crossesMidnight,
      break_rules: breakRules,
      grace_min: graceMin,
      differential,
      created_at: now,
      updated_at: now,
    }
    if (this.inTx) this.pendingShiftInserts.push(row)
    else this.db.shifts.set(row.id, row)
    return jsonRow(row, ['name_i18n', 'break_rules', 'differential'])
  }

  private updateShift(params: unknown[]): Array<Record<string, unknown>> {
    const [id, nameI18n, startT, endT, crossesMidnight, breakRules, graceMin, differential] = params as [
      string,
      string,
      string,
      string,
      boolean,
      string,
      number,
      string,
    ]
    const current = [...this.visibleShifts()].reverse().find((r) => r.id === id)
    if (!current) return []
    if (graceMin < 0) throw new ConstraintViolation('shift_grace_min_check')
    const updated: ShiftRow = {
      ...current,
      name_i18n: nameI18n,
      start_t: startT,
      end_t: endT,
      crosses_midnight: crossesMidnight,
      break_rules: breakRules,
      grace_min: graceMin,
      differential,
      updated_at: new Date(),
    }
    if (this.inTx) this.pendingShiftUpdates.push(updated)
    else this.db.shifts.set(updated.id, updated)
    return [jsonRow(updated, ['name_i18n', 'break_rules', 'differential'])]
  }

  private selectShift(sql: string, params: unknown[]): Array<Record<string, unknown>> {
    const visible = this.visibleShifts()
    if (/WHERE id = \$1/i.test(sql)) {
      const [id] = params as [string]
      return visible.filter((r) => r.id === id).map((r) => jsonRow(r, ['name_i18n', 'break_rules', 'differential']))
    }
    return visible
      .slice()
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
      .map((r) => jsonRow(r, ['name_i18n', 'break_rules', 'differential']))
  }

  // ---------- roster_entry ----------

  private visibleRosterEntries(): RosterEntryRow[] {
    const byId = new Map<string, RosterEntryRow>()
    for (const r of this.db.rosterEntries.values()) byId.set(r.id, r)
    for (const r of this.pendingRosterInserts) byId.set(r.id, r)
    for (const r of this.pendingRosterUpdates) byId.set(r.id, r)
    return [...byId.values()]
  }

  private insertRosterEntry(params: unknown[]): Record<string, unknown> {
    const [employeeId, shiftId, workDate, overrideReason, hazardous] = params as [
      string,
      string,
      string,
      string | null,
      boolean,
    ]
    const now = new Date()
    const row: RosterEntryRow = {
      id: randomUUID(),
      employee_id: employeeId,
      shift_id: shiftId,
      work_date: workDate,
      status: 'planned',
      override_reason: overrideReason,
      hazardous,
      created_at: now,
      updated_at: now,
    }
    if (this.inTx) this.pendingRosterInserts.push(row)
    else this.db.rosterEntries.set(row.id, row)
    return { ...row }
  }

  private setOverrideReason(params: unknown[]): Array<Record<string, unknown>> {
    const [id, reason] = params as [string, string]
    const current = [...this.visibleRosterEntries()].reverse().find((r) => r.id === id)
    if (!current) return []
    const updated: RosterEntryRow = { ...current, override_reason: reason, updated_at: new Date() }
    if (this.inTx) this.pendingRosterUpdates.push(updated)
    else this.db.rosterEntries.set(updated.id, updated)
    return [{ ...updated }]
  }

  private publishRange(params: unknown[]): Array<Record<string, unknown>> {
    const [from, to, employeeIds] = params as [string, string, string[] | null]
    const candidates = this.visibleRosterEntries().filter(
      (r) =>
        r.work_date >= from &&
        r.work_date <= to &&
        r.status === 'planned' &&
        (employeeIds === null || employeeIds.includes(r.employee_id)),
    )
    const updated: Record<string, unknown>[] = []
    for (const c of candidates) {
      const row: RosterEntryRow = { ...c, status: 'published', updated_at: new Date() }
      if (this.inTx) this.pendingRosterUpdates.push(row)
      else this.db.rosterEntries.set(row.id, row)
      updated.push({ ...row })
    }
    return updated
  }

  private selectRosterEntry(sql: string, params: unknown[]): Array<Record<string, unknown>> {
    const visible = this.visibleRosterEntries()
    if (/WHERE id = \$1/i.test(sql)) {
      const [id] = params as [string]
      return visible.filter((r) => r.id === id).map((r) => ({ ...r }))
    }
    if (/employee_id = \$1 AND work_date = \$2/i.test(sql)) {
      const [employeeId, workDate] = params as [string, string]
      return visible.filter((r) => r.employee_id === employeeId && r.work_date === workDate).map((r) => ({ ...r }))
    }
    if (/employee_id = \$1 AND work_date BETWEEN/i.test(sql)) {
      const [employeeId, from, to] = params as [string, string, string]
      return visible
        .filter((r) => r.employee_id === employeeId && r.work_date >= from && r.work_date <= to)
        .map((r) => ({ ...r }))
    }
    if (/work_date BETWEEN \$1 AND \$2/i.test(sql)) {
      const [from, to, employeeIds] = params as [string, string, string[] | null]
      return visible
        .filter(
          (r) => r.work_date >= from && r.work_date <= to && (employeeIds === null || employeeIds.includes(r.employee_id)),
        )
        .map((r) => ({ ...r }))
    }
    throw new Error(`FakeSchedulerDb: unrecognised roster_entry SELECT: ${sql}`)
  }

  // ---------- scheduler_employee_ref ----------

  private visibleEmployeeRefs(): EmployeeRefRow[] {
    const byId = new Map<string, EmployeeRefRow>()
    for (const r of this.db.employeeRefs.values()) byId.set(r.employee_id, r)
    for (const r of this.pendingEmployeeRefUpserts) byId.set(r.employee_id, r)
    return [...byId.values()]
  }

  private upsertEmployeeRef(params: unknown[]): Record<string, unknown> {
    const [employeeId, empCode, status, orgUnitId] = params as [string, string | null, string | null, string | null]
    const current = this.visibleEmployeeRefs().find((r) => r.employee_id === employeeId)
    const row: EmployeeRefRow = {
      employee_id: employeeId,
      emp_code: empCode ?? current?.emp_code ?? null,
      status: status ?? current?.status ?? null,
      org_unit_id: orgUnitId ?? current?.org_unit_id ?? null,
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
    if (/WHERE org_unit_id = \$1/i.test(sql)) {
      const [orgUnitId] = params as [string]
      return visible.filter((r) => r.org_unit_id === orgUnitId).map((r) => ({ ...r }))
    }
    throw new Error(`FakeSchedulerDb: unrecognised scheduler_employee_ref SELECT: ${sql}`)
  }

  // ---------- leave_ref ----------

  private visibleLeaveRefs(): LeaveRefRow[] {
    const byKey = new Map<string, LeaveRefRow>()
    for (const r of this.db.leaveRefsByRequestId.values()) byKey.set(r.leave_request_id, r)
    for (const r of this.pendingLeaveRefUpserts) byKey.set(r.leave_request_id, r)
    return [...byKey.values()]
  }

  private upsertLeaveRef(params: unknown[]): Record<string, unknown> {
    const [employeeId, leaveRequestId, dateFrom, dateTo] = params as [string, string, string, string]
    const current = this.visibleLeaveRefs().find((r) => r.leave_request_id === leaveRequestId)
    const row: LeaveRefRow = {
      id: current?.id ?? randomUUID(),
      employee_id: employeeId,
      leave_request_id: leaveRequestId,
      date_from: dateFrom,
      date_to: dateTo,
      status: 'approved',
      updated_at: new Date(),
    }
    if (this.inTx) this.pendingLeaveRefUpserts.push(row)
    else this.db.leaveRefsByRequestId.set(row.leave_request_id, row)
    return { ...row }
  }

  private cancelLeaveRef(params: unknown[]): Array<Record<string, unknown>> {
    const [leaveRequestId] = params as [string]
    const current = this.visibleLeaveRefs().find((r) => r.leave_request_id === leaveRequestId)
    if (!current) return []
    const updated: LeaveRefRow = { ...current, status: 'cancelled', updated_at: new Date() }
    if (this.inTx) this.pendingLeaveRefUpserts.push(updated)
    else this.db.leaveRefsByRequestId.set(updated.leave_request_id, updated)
    return [{ ...updated }]
  }

  private selectLeaveRef(params: unknown[]): Array<Record<string, unknown>> {
    const [employeeId, date] = params as [string, string]
    return this.visibleLeaveRefs()
      .filter((r) => r.employee_id === employeeId && r.status === 'approved' && r.date_from <= date && r.date_to >= date)
      .map((r) => ({ ...r }))
  }

  // ---------- holiday_calendar / holiday ----------

  private visibleCalendars(): HolidayCalendarRow[] {
    const byId = new Map<string, HolidayCalendarRow>()
    for (const r of this.db.holidayCalendars.values()) byId.set(r.id, r)
    for (const r of this.pendingCalendarInserts) byId.set(r.id, r)
    return [...byId.values()]
  }

  private selectCalendar(params: unknown[]): Array<Record<string, unknown>> {
    const [year] = params as [number]
    return this.visibleCalendars()
      .filter((r) => r.year === year)
      .map((r) => ({ ...r }))
  }

  private insertCalendar(params: unknown[]): Record<string, unknown> {
    const [year] = params as [number]
    if (this.visibleCalendars().some((r) => r.year === year)) {
      throw new ConstraintViolation('holiday_calendar_year_key')
    }
    const row: HolidayCalendarRow = { id: randomUUID(), year }
    if (this.inTx) this.pendingCalendarInserts.push(row)
    else this.db.holidayCalendars.set(row.id, row)
    return { ...row }
  }

  private visibleHolidays(): HolidayRow[] {
    const byId = new Map<string, HolidayRow>()
    for (const r of this.db.holidays.values()) byId.set(r.id, r)
    if (!this.pendingHolidayDeletesByCalendar.length) {
      // fast path
    } else {
      for (const calendarId of this.pendingHolidayDeletesByCalendar) {
        for (const [id, h] of byId) if (h.calendar_id === calendarId) byId.delete(id)
      }
    }
    for (const r of this.pendingHolidayInserts) byId.set(r.id, r)
    return [...byId.values()]
  }

  private deleteHolidaysByCalendar(params: unknown[]): void {
    const [calendarId] = params as [string]
    if (this.inTx) {
      this.pendingHolidayDeletesByCalendar.push(calendarId)
      this.pendingHolidayInserts = this.pendingHolidayInserts.filter((h) => h.calendar_id !== calendarId)
    } else {
      for (const [id, h] of this.db.holidays) if (h.calendar_id === calendarId) this.db.holidays.delete(id)
    }
  }

  private insertHoliday(params: unknown[]): Record<string, unknown> {
    const [calendarId, holidayDate, nameI18n, isSubstitute, substituteForId] = params as [
      string,
      string,
      string,
      boolean,
      string | null,
    ]
    const visible = this.visibleHolidays()
    if (visible.some((h) => h.calendar_id === calendarId && h.holiday_date === holidayDate)) {
      throw new ConstraintViolation('holiday_calendar_id_holiday_date_key')
    }
    const row: HolidayRow = {
      id: randomUUID(),
      calendar_id: calendarId,
      holiday_date: holidayDate,
      name_i18n: nameI18n,
      is_substitute: isSubstitute,
      substitute_for_id: substituteForId,
      created_at: new Date(),
    }
    if (this.inTx) this.pendingHolidayInserts.push(row)
    else this.db.holidays.set(row.id, row)
    return jsonRow(row, ['name_i18n'])
  }

  private selectHoliday(params: unknown[]): Array<Record<string, unknown>> {
    const [calendarId] = params as [string]
    return this.visibleHolidays()
      .filter((h) => h.calendar_id === calendarId)
      .sort((a, b) => (a.holiday_date < b.holiday_date ? -1 : a.holiday_date > b.holiday_date ? 1 : 0))
      .map((h) => jsonRow(h, ['name_i18n']))
  }

  // ---------- ot_request ----------

  private visibleOt(): OtRequestRow[] {
    const byId = new Map<string, OtRequestRow>()
    for (const r of this.db.otRequests.values()) byId.set(r.id, r)
    for (const r of this.pendingOtInserts) byId.set(r.id, r)
    for (const r of this.pendingOtUpdates) byId.set(r.id, r)
    return [...byId.values()]
  }

  private insertOt(params: unknown[]): Record<string, unknown> {
    const [employeeId, otDate, hours, rateClass, reason, employeeConsent] = params as [
      string,
      string,
      string,
      string,
      string,
      boolean,
    ]
    if (!['workday', 'holiday_work', 'holiday_ot'].includes(rateClass)) {
      throw new ConstraintViolation('ot_request_rate_class_check')
    }
    if (Number.parseFloat(hours) <= 0) throw new ConstraintViolation('ot_request_hours_check')
    const now = new Date()
    const row: OtRequestRow = {
      id: randomUUID(),
      employee_id: employeeId,
      ot_date: otDate,
      hours,
      rate_class: rateClass,
      status: 'pending',
      approved_by: null,
      reason,
      employee_consent: employeeConsent,
      decision_reason: null,
      created_at: now,
      updated_at: now,
    }
    if (this.inTx) this.pendingOtInserts.push(row)
    else this.db.otRequests.set(row.id, row)
    return { ...row }
  }

  private decideOt(params: unknown[]): Array<Record<string, unknown>> {
    const [id, status, approvedBy, decisionReason] = params as [string, string, string, string | null]
    const current = [...this.visibleOt()].reverse().find((r) => r.id === id)
    if (!current || current.status !== 'pending') return []
    const updated: OtRequestRow = {
      ...current,
      status,
      approved_by: approvedBy,
      decision_reason: decisionReason,
      updated_at: new Date(),
    }
    if (this.inTx) this.pendingOtUpdates.push(updated)
    else this.db.otRequests.set(updated.id, updated)
    return [{ ...updated }]
  }

  private selectOt(sql: string, params: unknown[]): Array<Record<string, unknown>> {
    const visible = this.visibleOt()
    if (/WHERE id = \$1/i.test(sql)) {
      const [id] = params as [string]
      return visible.filter((r) => r.id === id).map((r) => ({ ...r }))
    }
    if (/employee_id = \$1 AND status = 'approved' AND ot_date BETWEEN/i.test(sql)) {
      const [employeeId, from, to] = params as [string, string, string]
      return visible
        .filter((r) => r.employee_id === employeeId && r.status === 'approved' && r.ot_date >= from && r.ot_date <= to)
        .map((r) => ({ ...r }))
    }
    throw new Error(`FakeSchedulerDb: unrecognised ot_request SELECT: ${sql}`)
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

  private insertProcessedEvent(sql: string, params: unknown[]): Array<Record<string, unknown>> {
    const schemaMatch = /INSERT INTO\s+(\S+)\.processed_events/i.exec(sql)
    void schemaMatch // schema is always `scheduler` here; kept for parity with kernel's fake-db shape
    const [eventId] = params as [string]
    const alreadyCommitted = this.db.processedEvents.has(eventId)
    const alreadyPendingHere = this.pendingProcessedEvents.includes(eventId)
    if (alreadyCommitted || alreadyPendingHere) return []
    if (this.inTx) this.pendingProcessedEvents.push(eventId)
    else this.db.processedEvents.add(eventId)
    return [{ event_id: eventId }]
  }
}
