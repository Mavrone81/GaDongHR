import { randomUUID } from 'node:crypto'
import type { Queryable } from '@gadong/kernel'

/**
 * A tiny in-memory stand-in for Postgres, scoped to the `onboarding` schema —
 * same reason and shape as `services/svc-config/src/testing/fake-db.ts` and
 * `@gadong/kernel`'s `outbox/testing/fake-db.ts`: there is no Postgres in
 * this environment (task CONSTRAINTS), so every repository is proven against
 * this fake instead. `migrations/*.js` is the source of truth for the real
 * schema; a later integration task re-proves this suite against real
 * Postgres, the same deferral every sibling service's fake documents.
 *
 * Constraints enforced here because they are load-bearing for this task's
 * compliance claims and must be provable without a live database:
 *  - `employee_national_id_bidx_key UNIQUE` — the actual mechanism behind
 *    ONB-002 (a duplicate national ID is blocked at the DB layer, not only
 *    by a service-layer check that a future bug could skip).
 *  - `employee_emp_code_key UNIQUE`
 *  - `consent_form_purpose_lang_version_key UNIQUE`
 *  - `probation_employee_id_key UNIQUE` (0..1 relationship)
 *  - every CHECK constraint the migration declares (status/employment_type/
 *    preferred_lang/consent state/probation outcome/consent_form lang)
 */

export interface StoredEmployeeRow {
  id: string
  emp_code: string
  first_name_th: Buffer
  last_name_th: Buffer
  first_name_en: Buffer
  last_name_en: Buffer
  name_zh: Buffer | null
  national_id: Buffer
  national_id_bidx: Buffer
  passport_no: Buffer | null
  tax_id: Buffer
  sso_number: Buffer
  bank_account: Buffer
  bank_code: string
  dob: Buffer
  address: Buffer
  phone: Buffer
  email: Buffer
  email_bidx: Buffer
  employment_type: string
  org_unit_id: string
  position_id: string
  province_code: string
  start_date: string
  termination_date: string | null
  status: string
  preferred_lang: string
  // Added by this task's own migration (`2_employee-clock-in-method.js`) —
  // see that file's header for why this column exists and is deliberately
  // NOT an adverse flag (PDPA-BIOMETRIC-COMPLIANCE.md §4.2).
  clock_in_method: string
  created_at: Date
  updated_at: Date
}

export interface StoredConsentFormRow {
  id: string
  purpose: string
  lang: string
  version: number
  body_text: string
  created_at: Date
}

export interface StoredConsentRecordRow {
  id: string
  employee_id: string
  consent_form_id: string
  purpose: string
  state: string
  lang_shown: string
  decided_at: Date
  form_text_snapshot: Buffer
  /**
   * Insertion sequence — NOT a real column, stripped before it would ever
   * reach `mapRecord`. Real Postgres `ORDER BY decided_at DESC` alone is
   * also ambiguous for two rows with an identical timestamp; this fake
   * breaks that tie the same way Postgres effectively does in practice for
   * appended rows (physical/insertion order), so two consent decisions
   * recorded within the same millisecond (realistic under fast test
   * execution, and not impossible in production) still resolve "most
   * recent" correctly.
   */
  _seq: number
}

export interface StoredOnboardingTaskRow {
  id: string
  employee_id: string
  task_key: string
  due_date: string
  status: string
}

export interface StoredProbationRow {
  id: string
  employee_id: string
  end_date: string
  outcome: string | null
  decided_at: Date | null
  extended_to: string | null
  created_at: Date
  updated_at: Date
}

interface StoredOutboxRow {
  id: string
  topic: string
  payload: unknown
  created_at: Date
  published_at: Date | null
}

export class ConstraintViolation extends Error {
  constructor(readonly constraint: string) {
    super(`FakeOnboardingDb: violates constraint "${constraint}"`)
  }
}

const EMPLOYMENT_TYPES = new Set(['monthly', 'daily', 'hourly', 'contract'])
const EMPLOYEE_STATUSES = new Set(['draft', 'onboarding', 'active', 'cancelled', 'terminated'])
const LANGS = new Set(['th', 'en', 'zh'])
const CLOCK_IN_METHODS = new Set(['biometric', 'alternative'])
const CONSENT_STATES = new Set(['granted', 'refused', 'withdrawn'])
const PROBATION_OUTCOMES = new Set(['confirm', 'extend', 'terminate'])

export class FakeOnboardingDb {
  private readonly employees = new Map<string, StoredEmployeeRow>()
  private readonly consentForms = new Map<string, StoredConsentFormRow>()
  private readonly consentRecords = new Map<string, StoredConsentRecordRow>()
  private readonly onboardingTasks = new Map<string, StoredOnboardingTaskRow>()
  private readonly probations = new Map<string, StoredProbationRow>()
  private readonly outbox = new Map<string, StoredOutboxRow>()
  private readonly processedEvents = new Set<string>()
  private seqCounter = 0

  connect(): FakeOnboardingConnection {
    return new FakeOnboardingConnection(this)
  }

  /** A `Queryable` that runs every statement outside a transaction (autocommit) — enough for repositories' read-only methods. */
  asPool(): Queryable {
    const conn = this.connect()
    return { query: (sql: string, params?: unknown[]) => conn.query(sql, params) }
  }

  // --- test-only seeding helpers (mirrors FakeConfigDb's directness) ---

  seedConsentForm(row: Omit<StoredConsentFormRow, 'id' | 'created_at'> & Partial<Pick<StoredConsentFormRow, 'id' | 'created_at'>>): StoredConsentFormRow {
    const full: StoredConsentFormRow = { id: randomUUID(), created_at: new Date(), ...row }
    this.consentForms.set(full.id, full)
    return full
  }

  debugEmployees(): StoredEmployeeRow[] {
    return [...this.employees.values()]
  }

  debugOnboardingTasks(): StoredOnboardingTaskRow[] {
    return [...this.onboardingTasks.values()]
  }

  debugConsentRecords(): StoredConsentRecordRow[] {
    return [...this.consentRecords.values()]
  }

  debugProbations(): StoredProbationRow[] {
    return [...this.probations.values()]
  }

  debugOutboxRows(): StoredOutboxRow[] {
    return [...this.outbox.values()]
  }

  // --- internals used only by FakeOnboardingConnection ---

  _allEmployees(): StoredEmployeeRow[] {
    return [...this.employees.values()]
  }
  _putEmployee(row: StoredEmployeeRow): void {
    this.employees.set(row.id, row)
  }
  _allConsentForms(): StoredConsentFormRow[] {
    return [...this.consentForms.values()]
  }
  _allConsentRecords(): StoredConsentRecordRow[] {
    return [...this.consentRecords.values()]
  }
  _putConsentRecord(row: StoredConsentRecordRow): void {
    this.consentRecords.set(row.id, row)
  }
  _nextSeq(): number {
    this.seqCounter += 1
    return this.seqCounter
  }
  _allOnboardingTasks(): StoredOnboardingTaskRow[] {
    return [...this.onboardingTasks.values()]
  }
  _putOnboardingTask(row: StoredOnboardingTaskRow): void {
    this.onboardingTasks.set(row.id, row)
  }
  _allProbations(): StoredProbationRow[] {
    return [...this.probations.values()]
  }
  _putProbation(row: StoredProbationRow): void {
    this.probations.set(row.id, row)
  }
  _insertOutboxRow(row: StoredOutboxRow): void {
    this.outbox.set(row.id, row)
  }
  _processedEventExists(schema: string, eventId: string): boolean {
    return this.processedEvents.has(`${schema}:${eventId}`)
  }
  _insertProcessedEvent(schema: string, eventId: string): void {
    this.processedEvents.add(`${schema}:${eventId}`)
  }
}

function toBuffer(v: unknown, field: string): Buffer {
  if (Buffer.isBuffer(v)) return v
  throw new Error(`FakeOnboardingDb: expected ${field} to be a Buffer (bytea), got ${typeof v}`)
}
function toBufferOrNull(v: unknown, field: string): Buffer | null {
  return v === null || v === undefined ? null : toBuffer(v, field)
}

/** One session/connection. Mirrors kernel's `FakeConnection`/`FakeConfigConnection`: writes made in a transaction are staged locally and only join the committed store on COMMIT. */
export class FakeOnboardingConnection implements Queryable {
  private inTx = false
  private pendingEmployeeWrites: StoredEmployeeRow[] = []
  private pendingConsentRecordWrites: StoredConsentRecordRow[] = []
  private pendingOnboardingTaskWrites: StoredOnboardingTaskRow[] = []
  private pendingProbationWrites: StoredProbationRow[] = []
  private pendingOutboxInserts: StoredOutboxRow[] = []
  private pendingProcessedEvents: Array<{ schema: string; eventId: string }> = []

  constructor(private readonly db: FakeOnboardingDb) {}

  /** No-op — present so kernel's `withTransaction`/`withConnection` (which call `client.release()`) can drive this fake directly, the same as a real `pg.PoolClient`. */
  release(_err?: Error): void {
    void _err
  }

  async query(sql: string, params: unknown[] = []): Promise<{ rows: Array<Record<string, unknown>> }> {
    const s = sql.trim()

    if (/^BEGIN\b/i.test(s)) {
      this.inTx = true
      this.pendingEmployeeWrites = []
      this.pendingConsentRecordWrites = []
      this.pendingOnboardingTaskWrites = []
      this.pendingProbationWrites = []
      this.pendingOutboxInserts = []
      this.pendingProcessedEvents = []
      return { rows: [] }
    }
    if (/^COMMIT\b/i.test(s)) {
      for (const row of this.pendingEmployeeWrites) this.db._putEmployee(row)
      for (const row of this.pendingConsentRecordWrites) this.db._putConsentRecord(row)
      for (const row of this.pendingOnboardingTaskWrites) this.db._putOnboardingTask(row)
      for (const row of this.pendingProbationWrites) this.db._putProbation(row)
      for (const row of this.pendingOutboxInserts) this.db._insertOutboxRow(row)
      for (const { schema, eventId } of this.pendingProcessedEvents) this.db._insertProcessedEvent(schema, eventId)
      this.inTx = false
      return { rows: [] }
    }
    if (/^ROLLBACK\b/i.test(s)) {
      this.pendingEmployeeWrites = []
      this.pendingConsentRecordWrites = []
      this.pendingOnboardingTaskWrites = []
      this.pendingProbationWrites = []
      this.pendingOutboxInserts = []
      this.pendingProcessedEvents = []
      this.inTx = false
      return { rows: [] }
    }

    if (/\bonboarding\.employee\b/i.test(s)) return this.handleEmployee(s, params)
    if (/\bonboarding\.consent_form\b/i.test(s)) return this.handleConsentForm(s, params)
    if (/\bonboarding\.consent_record\b/i.test(s)) return this.handleConsentRecord(s, params)
    if (/\bonboarding\.onboarding_task\b/i.test(s)) return this.handleOnboardingTask(s, params)
    if (/\bonboarding\.probation\b/i.test(s)) return this.handleProbation(s, params)
    if (/INSERT INTO\s+\S*outbox\b/i.test(s)) return this.handleOutboxInsert(params)
    if (/INSERT INTO\s+\S*processed_events\b/i.test(s)) return this.handleProcessedEventsInsert(s, params)

    throw new Error(`FakeOnboardingDb: unrecognised query: ${s}`)
  }

  // --- employee ---

  private visibleEmployees(): StoredEmployeeRow[] {
    const byId = new Map<string, StoredEmployeeRow>()
    for (const r of this.db._allEmployees()) byId.set(r.id, r)
    for (const r of this.pendingEmployeeWrites) byId.set(r.id, r)
    return [...byId.values()]
  }

  private handleEmployee(s: string, params: unknown[]): { rows: Array<Record<string, unknown>> } {
    if (/^INSERT INTO/i.test(s)) return { rows: [this.insertEmployee(params)] }
    if (/^UPDATE/i.test(s)) return { rows: this.updateEmployee(s, params) }
    if (/^SELECT/i.test(s)) return { rows: this.selectEmployee(s, params) }
    throw new Error(`FakeOnboardingDb: unrecognised onboarding.employee query: ${s}`)
  }

  private insertEmployee(params: unknown[]): Record<string, unknown> {
    const [
      id, empCode, firstNameTh, lastNameTh, firstNameEn, lastNameEn, nameZh,
      nationalId, nationalIdBidx, passportNo, taxId, ssoNumber, bankAccount, bankCode,
      dob, address, phone, email, emailBidx,
      employmentType, orgUnitId, positionId, provinceCode, startDate, status, preferredLang, clockInMethod,
    ] = params as [
      string, string, Buffer, Buffer, Buffer, Buffer, Buffer | null,
      Buffer, Buffer, Buffer | null, Buffer, Buffer, Buffer, string,
      Buffer, Buffer, Buffer, Buffer, Buffer,
      string, string, string, string, string, string, string, string,
    ]

    if (!EMPLOYMENT_TYPES.has(employmentType)) throw new ConstraintViolation('employee_employment_type_check')
    if (!EMPLOYEE_STATUSES.has(status)) throw new ConstraintViolation('employee_status_check')
    if (!LANGS.has(preferredLang)) throw new ConstraintViolation('employee_preferred_lang_check')
    if (!CLOCK_IN_METHODS.has(clockInMethod)) throw new ConstraintViolation('employee_clock_in_method_check')

    const visible = this.visibleEmployees()
    if (visible.some((r) => r.id === id)) throw new ConstraintViolation('employee_pkey')
    if (visible.some((r) => r.emp_code === empCode)) throw new ConstraintViolation('employee_emp_code_key')
    if (visible.some((r) => r.national_id_bidx.equals(nationalIdBidx))) {
      throw new ConstraintViolation('employee_national_id_bidx_key')
    }

    const row: StoredEmployeeRow = {
      id,
      emp_code: empCode,
      first_name_th: toBuffer(firstNameTh, 'first_name_th'),
      last_name_th: toBuffer(lastNameTh, 'last_name_th'),
      first_name_en: toBuffer(firstNameEn, 'first_name_en'),
      last_name_en: toBuffer(lastNameEn, 'last_name_en'),
      name_zh: toBufferOrNull(nameZh, 'name_zh'),
      national_id: toBuffer(nationalId, 'national_id'),
      national_id_bidx: toBuffer(nationalIdBidx, 'national_id_bidx'),
      passport_no: toBufferOrNull(passportNo, 'passport_no'),
      tax_id: toBuffer(taxId, 'tax_id'),
      sso_number: toBuffer(ssoNumber, 'sso_number'),
      bank_account: toBuffer(bankAccount, 'bank_account'),
      bank_code: bankCode,
      dob: toBuffer(dob, 'dob'),
      address: toBuffer(address, 'address'),
      phone: toBuffer(phone, 'phone'),
      email: toBuffer(email, 'email'),
      email_bidx: toBuffer(emailBidx, 'email_bidx'),
      employment_type: employmentType,
      org_unit_id: orgUnitId,
      position_id: positionId,
      province_code: provinceCode,
      start_date: startDate,
      termination_date: null,
      status,
      preferred_lang: preferredLang,
      clock_in_method: clockInMethod,
      created_at: new Date(),
      updated_at: new Date(),
    }
    if (this.inTx) this.pendingEmployeeWrites.push(row)
    else this.db._putEmployee(row)
    return row as unknown as Record<string, unknown>
  }

  private selectEmployee(s: string, params: unknown[]): Array<Record<string, unknown>> {
    const visible = this.visibleEmployees()
    if (/WHERE id = \$1/i.test(s)) {
      const [id] = params as [string]
      return visible.filter((r) => r.id === id) as unknown as Array<Record<string, unknown>>
    }
    if (/WHERE national_id_bidx = \$1/i.test(s)) {
      const [bidx] = params as [Buffer]
      return visible.filter((r) => r.national_id_bidx.equals(bidx)) as unknown as Array<Record<string, unknown>>
    }
    if (/ORDER BY created_at/i.test(s)) {
      // list(): filters applied loosely by whichever optional params are present
      let rows = visible
      const orgUnitId = paramFor(s, params, 'org_unit_id = \\$')
      const status = paramFor(s, params, 'status = \\$')
      if (orgUnitId !== undefined) rows = rows.filter((r) => r.org_unit_id === orgUnitId)
      if (status !== undefined) rows = rows.filter((r) => r.status === status)
      return [...rows].sort((a, b) => b.created_at.getTime() - a.created_at.getTime()) as unknown as Array<Record<string, unknown>>
    }
    throw new Error(`FakeOnboardingDb: unrecognised SELECT on onboarding.employee: ${s}`)
  }

  private updateEmployee(s: string, params: unknown[]): Array<Record<string, unknown>> {
    const idParam = params[params.length - 1]
    if (typeof idParam !== 'string') throw new Error('FakeOnboardingDb: UPDATE onboarding.employee expects id as last param')
    const visible = this.visibleEmployees()
    const current = visible.find((r) => r.id === idParam)
    if (!current) return []

    const setClauseMatch = /SET\s+([\s\S]+?)\s+WHERE/i.exec(s)
    if (!setClauseMatch?.[1]) throw new Error('FakeOnboardingDb: could not parse UPDATE SET clause')
    const assignments = setClauseMatch[1].split(',').map((a) => a.trim())

    const next: StoredEmployeeRow = { ...current, updated_at: new Date() }
    for (const assignment of assignments) {
      const m = /^(\w+)\s*=\s*\$(\d+)/.exec(assignment)
      if (!m?.[1] || !m[2]) continue
      const col = m[1]
      const paramIndex = Number(m[2]) - 1
      const value = params[paramIndex]
      applyEmployeeColumn(next, col, value)
    }

    if (!EMPLOYMENT_TYPES.has(next.employment_type)) throw new ConstraintViolation('employee_employment_type_check')
    if (!EMPLOYEE_STATUSES.has(next.status)) throw new ConstraintViolation('employee_status_check')
    if (!LANGS.has(next.preferred_lang)) throw new ConstraintViolation('employee_preferred_lang_check')
    if (!CLOCK_IN_METHODS.has(next.clock_in_method)) throw new ConstraintViolation('employee_clock_in_method_check')
    if (visible.some((r) => r.id !== next.id && r.national_id_bidx.equals(next.national_id_bidx))) {
      throw new ConstraintViolation('employee_national_id_bidx_key')
    }

    if (this.inTx) this.pendingEmployeeWrites.push(next)
    else this.db._putEmployee(next)
    return [next as unknown as Record<string, unknown>]
  }

  // --- consent_form ---

  private handleConsentForm(s: string, params: unknown[]): { rows: Array<Record<string, unknown>> } {
    if (/^SELECT/i.test(s) && /WHERE id = \$1/i.test(s)) {
      const [id] = params as [string]
      const rows = this.db._allConsentForms().filter((r) => r.id === id)
      return { rows: rows as unknown as Array<Record<string, unknown>> }
    }
    if (/^SELECT/i.test(s)) {
      const [purpose, lang, version] = params as [string, string, number]
      const rows = this.db
        ._allConsentForms()
        .filter((r) => r.purpose === purpose && r.lang === lang && r.version === version)
      return { rows: rows as unknown as Array<Record<string, unknown>> }
    }
    throw new Error(`FakeOnboardingDb: unrecognised onboarding.consent_form query: ${s}`)
  }

  // --- consent_record ---

  private visibleConsentRecords(): StoredConsentRecordRow[] {
    const byId = new Map<string, StoredConsentRecordRow>()
    for (const r of this.db._allConsentRecords()) byId.set(r.id, r)
    for (const r of this.pendingConsentRecordWrites) byId.set(r.id, r)
    return [...byId.values()]
  }

  private handleConsentRecord(s: string, params: unknown[]): { rows: Array<Record<string, unknown>> } {
    if (/^INSERT INTO/i.test(s)) {
      const [employeeId, consentFormId, purpose, state, langShown, decidedAt, formTextSnapshot] = params as [
        string, string, string, string, string, string, Buffer,
      ]
      if (!CONSENT_STATES.has(state)) throw new ConstraintViolation('consent_record_state_check')
      const row: StoredConsentRecordRow = {
        id: randomUUID(),
        employee_id: employeeId,
        consent_form_id: consentFormId,
        purpose,
        state,
        lang_shown: langShown,
        decided_at: new Date(decidedAt),
        form_text_snapshot: toBuffer(formTextSnapshot, 'form_text_snapshot'),
        _seq: this.db._nextSeq(),
      }
      if (this.inTx) this.pendingConsentRecordWrites.push(row)
      else this.db._putConsentRecord(row)
      return { rows: [row as unknown as Record<string, unknown>] }
    }
    if (/^SELECT/i.test(s)) {
      const [employeeId, purpose] = params as [string, string]
      const rows = this.visibleConsentRecords()
        .filter((r) => r.employee_id === employeeId && r.purpose === purpose)
        .sort((a, b) => b.decided_at.getTime() - a.decided_at.getTime() || b._seq - a._seq)
      return { rows: rows as unknown as Array<Record<string, unknown>> }
    }
    throw new Error(`FakeOnboardingDb: unrecognised onboarding.consent_record query: ${s}`)
  }

  // --- onboarding_task ---

  private visibleTasks(): StoredOnboardingTaskRow[] {
    const byId = new Map<string, StoredOnboardingTaskRow>()
    for (const r of this.db._allOnboardingTasks()) byId.set(r.id, r)
    for (const r of this.pendingOnboardingTaskWrites) byId.set(r.id, r)
    return [...byId.values()]
  }

  private handleOnboardingTask(s: string, params: unknown[]): { rows: Array<Record<string, unknown>> } {
    if (/^INSERT INTO/i.test(s)) {
      const [employeeId, taskKey, dueDate, status] = params as [string, string, string, string]
      const row: StoredOnboardingTaskRow = { id: randomUUID(), employee_id: employeeId, task_key: taskKey, due_date: dueDate, status }
      if (this.inTx) this.pendingOnboardingTaskWrites.push(row)
      else this.db._putOnboardingTask(row)
      return { rows: [row as unknown as Record<string, unknown>] }
    }
    if (/^UPDATE/i.test(s)) {
      const [status, id] = params as [string, string]
      const visible = this.visibleTasks()
      const current = visible.find((r) => r.id === id)
      if (!current) return { rows: [] }
      const next = { ...current, status }
      if (this.inTx) this.pendingOnboardingTaskWrites.push(next)
      else this.db._putOnboardingTask(next)
      return { rows: [next as unknown as Record<string, unknown>] }
    }
    if (/^SELECT/i.test(s)) {
      const visible = this.visibleTasks()
      if (/WHERE id = \$1/i.test(s)) {
        const [id] = params as [string]
        return { rows: visible.filter((r) => r.id === id) as unknown as Array<Record<string, unknown>> }
      }
      if (/WHERE employee_id = \$1/i.test(s)) {
        const [employeeId] = params as [string]
        return { rows: visible.filter((r) => r.employee_id === employeeId) as unknown as Array<Record<string, unknown>> }
      }
      throw new Error(`FakeOnboardingDb: unrecognised SELECT on onboarding.onboarding_task: ${s}`)
    }
    throw new Error(`FakeOnboardingDb: unrecognised onboarding.onboarding_task query: ${s}`)
  }

  // --- probation ---

  private visibleProbations(): StoredProbationRow[] {
    const byId = new Map<string, StoredProbationRow>()
    for (const r of this.db._allProbations()) byId.set(r.id, r)
    for (const r of this.pendingProbationWrites) byId.set(r.id, r)
    return [...byId.values()]
  }

  private handleProbation(s: string, params: unknown[]): { rows: Array<Record<string, unknown>> } {
    if (/^INSERT INTO/i.test(s)) {
      const [employeeId, endDate] = params as [string, string]
      const visible = this.visibleProbations()
      if (visible.some((r) => r.employee_id === employeeId)) throw new ConstraintViolation('probation_employee_id_key')
      const row: StoredProbationRow = {
        id: randomUUID(),
        employee_id: employeeId,
        end_date: endDate,
        outcome: null,
        decided_at: null,
        extended_to: null,
        created_at: new Date(),
        updated_at: new Date(),
      }
      if (this.inTx) this.pendingProbationWrites.push(row)
      else this.db._putProbation(row)
      return { rows: [row as unknown as Record<string, unknown>] }
    }
    if (/^UPDATE/i.test(s)) {
      const [outcome, decidedAt, extendedTo, id] = params as [string, string, string | null, string]
      if (!PROBATION_OUTCOMES.has(outcome)) throw new ConstraintViolation('probation_outcome_check')
      const visible = this.visibleProbations()
      const current = visible.find((r) => r.id === id)
      if (!current) return { rows: [] }
      const next: StoredProbationRow = { ...current, outcome, decided_at: new Date(decidedAt), extended_to: extendedTo, updated_at: new Date() }
      if (this.inTx) this.pendingProbationWrites.push(next)
      else this.db._putProbation(next)
      return { rows: [next as unknown as Record<string, unknown>] }
    }
    if (/^SELECT/i.test(s)) {
      const [employeeId] = params as [string]
      const visible = this.visibleProbations()
      return { rows: visible.filter((r) => r.employee_id === employeeId) as unknown as Array<Record<string, unknown>> }
    }
    throw new Error(`FakeOnboardingDb: unrecognised onboarding.probation query: ${s}`)
  }

  // --- outbox / processed_events (shared shape with every other schema's fake) ---

  private handleOutboxInsert(params: unknown[]): { rows: Array<Record<string, unknown>> } {
    const [topic, payloadJson] = params as [string, string]
    const row: StoredOutboxRow = { id: randomUUID(), topic, payload: JSON.parse(payloadJson) as unknown, created_at: new Date(), published_at: null }
    if (this.inTx) this.pendingOutboxInserts.push(row)
    else this.db._insertOutboxRow(row)
    return { rows: [{ id: row.id }] }
  }

  private handleProcessedEventsInsert(s: string, params: unknown[]): { rows: Array<Record<string, unknown>> } {
    const schemaMatch = /INSERT INTO\s+(\S+)\.processed_events/i.exec(s)
    const schema = schemaMatch?.[1] ?? 'onboarding'
    const [eventId] = params as [string]
    const alreadyCommitted = this.db._processedEventExists(schema, eventId)
    const alreadyPendingHere = this.pendingProcessedEvents.some((p) => p.schema === schema && p.eventId === eventId)
    if (alreadyCommitted || alreadyPendingHere) return { rows: [] }
    if (this.inTx) this.pendingProcessedEvents.push({ schema, eventId })
    else this.db._insertProcessedEvent(schema, eventId)
    return { rows: [{ event_id: eventId }] }
  }
}

/** Best-effort extraction of an optional filter param's value from a WHERE clause built with named fragments — used only by `list()`'s loosely-shaped SELECT. */
function paramFor(sql: string, params: unknown[], fragmentPattern: string): unknown {
  const re = new RegExp(fragmentPattern + '(\\d+)', 'i')
  const m = re.exec(sql)
  if (!m?.[1]) return undefined
  return params[Number(m[1]) - 1]
}

function applyEmployeeColumn(row: StoredEmployeeRow, col: string, value: unknown): void {
  switch (col) {
    case 'first_name_th': row.first_name_th = toBuffer(value, col); return
    case 'last_name_th': row.last_name_th = toBuffer(value, col); return
    case 'first_name_en': row.first_name_en = toBuffer(value, col); return
    case 'last_name_en': row.last_name_en = toBuffer(value, col); return
    case 'name_zh': row.name_zh = toBufferOrNull(value, col); return
    case 'national_id': row.national_id = toBuffer(value, col); return
    case 'national_id_bidx': row.national_id_bidx = toBuffer(value, col); return
    case 'passport_no': row.passport_no = toBufferOrNull(value, col); return
    case 'tax_id': row.tax_id = toBuffer(value, col); return
    case 'sso_number': row.sso_number = toBuffer(value, col); return
    case 'bank_account': row.bank_account = toBuffer(value, col); return
    case 'bank_code': row.bank_code = String(value); return
    case 'dob': row.dob = toBuffer(value, col); return
    case 'address': row.address = toBuffer(value, col); return
    case 'phone': row.phone = toBuffer(value, col); return
    case 'email': row.email = toBuffer(value, col); return
    case 'email_bidx': row.email_bidx = toBuffer(value, col); return
    case 'employment_type': row.employment_type = String(value); return
    case 'org_unit_id': row.org_unit_id = String(value); return
    case 'position_id': row.position_id = String(value); return
    case 'province_code': row.province_code = String(value); return
    case 'start_date': row.start_date = String(value); return
    case 'termination_date': row.termination_date = value === null ? null : String(value); return
    case 'status': row.status = String(value); return
    case 'preferred_lang': row.preferred_lang = String(value); return
    case 'clock_in_method': row.clock_in_method = String(value); return
    default:
      throw new Error(`FakeOnboardingDb: unrecognised employee column in UPDATE: ${col}`)
  }
}
