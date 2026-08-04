import { randomUUID } from 'node:crypto'
import type { Queryable } from '@gadong/kernel'

/**
 * In-memory stand-in for Postgres, scoped to the `attendance` schema — same
 * shape and reasoning as `services/svc-onboarding/src/testing/fake-db.ts`:
 * no Postgres in this environment (task CONSTRAINTS), so every repository
 * is proven against this fake instead. `migrations/*.js` is the source of
 * truth for the real schema.
 *
 * Constraints enforced here because they are load-bearing for this
 * service's compliance claims and must be provable without a live database:
 *  - `punch_event_idem_key_key UNIQUE`, honoured via `ON CONFLICT (idem_key)
 *    DO NOTHING` semantics — the actual mechanism behind the 24h-offline-
 *    kiosk-replay guarantee (M4-4/M4-6).
 *  - `enrollment_employee_id_key UNIQUE` — one enrolment per employee.
 *  - `alternative_credential_hash_key UNIQUE` — a scanned QR/badge resolves
 *    to exactly one employee.
 *  - every CHECK constraint the migrations declare.
 */

export interface StoredConsentStateRow {
  employee_id: string
  state: string
  updated_at: Date
}

export interface StoredEnrolmentRow {
  id: string
  employee_id: string
  method: string
  face_subject_ref: string | null
  status: string
  enrolled_at: Date
  template_deleted_at: Date | null
}

export interface StoredAlternativeCredentialRow {
  employee_id: string
  kind: string
  credential_hash: Buffer
  created_at: Date
}

export interface StoredDeviceRow {
  id: string
  kind: string
  site_code: string
  device_secret: Buffer
  status: string
  registered_by: string | null
  approved_by: string | null
  approved_at: Date | null
}

export interface StoredPunchRow {
  id: string
  idem_key: string
  employee_id: string
  device_id: string
  punched_at: Date
  direction: string
  method: string
  match_score: number | null
  liveness_passed: boolean | null
  site_code: string
  geo: unknown | null
}

export interface StoredSecurityEventRow {
  id: string
  kind: string
  device_id: string | null
  employee_id: string | null
  site_code: string
  at: Date
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
    super(`FakeAttendanceDb: violates constraint "${constraint}"`)
  }
}

const CONSENT_STATES = new Set(['granted', 'withdrawn'])
const ENROLMENT_METHODS = new Set(['face', 'pin', 'qr', 'badge'])
const ENROLMENT_STATUSES = new Set(['active', 'suspended', 'deleted'])
const ALT_KINDS = new Set(['pin', 'qr', 'badge'])
const DEVICE_KINDS = new Set(['kiosk', 'mobile'])
const DEVICE_STATUSES = new Set(['pending', 'active', 'revoked'])
const PUNCH_DIRECTIONS = new Set(['in', 'out'])
const PUNCH_METHODS = new Set(['face', 'pin', 'qr', 'badge', 'manual'])
const SECURITY_EVENT_KINDS = new Set(['liveness_failed', 'multi_face'])

export class FakeAttendanceDb {
  private readonly consentStates = new Map<string, StoredConsentStateRow>()
  private readonly enrolments = new Map<string, StoredEnrolmentRow>() // keyed by employee_id
  private readonly altCredentials = new Map<string, StoredAlternativeCredentialRow>() // keyed by employee_id
  private readonly devices = new Map<string, StoredDeviceRow>()
  private readonly punches = new Map<string, StoredPunchRow>() // keyed by id
  private readonly securityEvents = new Map<string, StoredSecurityEventRow>()
  private readonly outbox = new Map<string, StoredOutboxRow>()
  private readonly processedEvents = new Set<string>()

  connect(): FakeAttendanceConnection {
    return new FakeAttendanceConnection(this)
  }

  asPool(): Queryable {
    const conn = this.connect()
    return { query: (sql: string, params?: unknown[]) => conn.query(sql, params) }
  }

  // --- debug/seed helpers ---
  debugEnrolments(): StoredEnrolmentRow[] {
    return [...this.enrolments.values()]
  }
  debugPunches(): StoredPunchRow[] {
    return [...this.punches.values()]
  }
  debugSecurityEvents(): StoredSecurityEventRow[] {
    return [...this.securityEvents.values()]
  }
  debugOutboxRows(): StoredOutboxRow[] {
    return [...this.outbox.values()]
  }
  debugDevices(): StoredDeviceRow[] {
    return [...this.devices.values()]
  }
  seedDevice(row: StoredDeviceRow): void {
    this.devices.set(row.id, row)
  }
  seedConsentState(row: StoredConsentStateRow): void {
    this.consentStates.set(row.employee_id, row)
  }
  seedEnrolment(row: StoredEnrolmentRow): void {
    this.enrolments.set(row.employee_id, row)
  }
  seedPunch(row: StoredPunchRow): void {
    this.punches.set(row.id, row)
  }

  // --- internals used only by FakeAttendanceConnection ---
  _consentState(employeeId: string): StoredConsentStateRow | undefined {
    return this.consentStates.get(employeeId)
  }
  _putConsentState(row: StoredConsentStateRow): void {
    this.consentStates.set(row.employee_id, row)
  }
  _enrolment(employeeId: string): StoredEnrolmentRow | undefined {
    return this.enrolments.get(employeeId)
  }
  _allEnrolments(): StoredEnrolmentRow[] {
    return [...this.enrolments.values()]
  }
  _putEnrolment(row: StoredEnrolmentRow): void {
    this.enrolments.set(row.employee_id, row)
  }
  _altCredential(employeeId: string): StoredAlternativeCredentialRow | undefined {
    return this.altCredentials.get(employeeId)
  }
  _allAltCredentials(): StoredAlternativeCredentialRow[] {
    return [...this.altCredentials.values()]
  }
  _putAltCredential(row: StoredAlternativeCredentialRow): void {
    this.altCredentials.set(row.employee_id, row)
  }
  _device(id: string): StoredDeviceRow | undefined {
    return this.devices.get(id)
  }
  _allDevices(): StoredDeviceRow[] {
    return [...this.devices.values()]
  }
  _putDevice(row: StoredDeviceRow): void {
    this.devices.set(row.id, row)
  }
  _allPunches(): StoredPunchRow[] {
    return [...this.punches.values()]
  }
  _punchByIdemKey(idemKey: string): StoredPunchRow | undefined {
    return [...this.punches.values()].find((p) => p.idem_key === idemKey)
  }
  _putPunch(row: StoredPunchRow): void {
    this.punches.set(row.id, row)
  }
  _putSecurityEvent(row: StoredSecurityEventRow): void {
    this.securityEvents.set(row.id, row)
  }
  _allSecurityEvents(): StoredSecurityEventRow[] {
    return [...this.securityEvents.values()]
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
  throw new Error(`FakeAttendanceDb: expected ${field} to be a Buffer (bytea), got ${typeof v}`)
}

/** One session/connection. Writes made inside a transaction are staged locally and only join the committed store on COMMIT — mirrors `svc-onboarding`'s fake. */
export class FakeAttendanceConnection implements Queryable {
  private inTx = false
  private pendingConsentStates: StoredConsentStateRow[] = []
  private pendingEnrolments: StoredEnrolmentRow[] = []
  private pendingAltCredentials: StoredAlternativeCredentialRow[] = []
  private pendingDevices: StoredDeviceRow[] = []
  private pendingPunches: StoredPunchRow[] = []
  private pendingSecurityEvents: StoredSecurityEventRow[] = []
  private pendingOutboxInserts: StoredOutboxRow[] = []
  private pendingProcessedEvents: Array<{ schema: string; eventId: string }> = []

  constructor(private readonly db: FakeAttendanceDb) {}

  /** No-op — lets kernel's `withTransaction`/`withConnection` (which call `client.release()`) drive this fake directly, the same as a real `pg.PoolClient`. */
  release(_err?: Error): void {
    void _err
  }

  async query(sql: string, params: unknown[] = []): Promise<{ rows: Array<Record<string, unknown>> }> {
    const s = sql.trim()

    if (/^BEGIN\b/i.test(s)) {
      this.inTx = true
      this.pendingConsentStates = []
      this.pendingEnrolments = []
      this.pendingAltCredentials = []
      this.pendingDevices = []
      this.pendingPunches = []
      this.pendingSecurityEvents = []
      this.pendingOutboxInserts = []
      this.pendingProcessedEvents = []
      return { rows: [] }
    }
    if (/^COMMIT\b/i.test(s)) {
      for (const row of this.pendingConsentStates) this.db._putConsentState(row)
      for (const row of this.pendingEnrolments) this.db._putEnrolment(row)
      for (const row of this.pendingAltCredentials) this.db._putAltCredential(row)
      for (const row of this.pendingDevices) this.db._putDevice(row)
      for (const row of this.pendingPunches) this.db._putPunch(row)
      for (const row of this.pendingSecurityEvents) this.db._putSecurityEvent(row)
      for (const row of this.pendingOutboxInserts) this.db._insertOutboxRow(row)
      for (const { schema, eventId } of this.pendingProcessedEvents) this.db._insertProcessedEvent(schema, eventId)
      this.inTx = false
      return { rows: [] }
    }
    if (/^ROLLBACK\b/i.test(s)) {
      this.pendingConsentStates = []
      this.pendingEnrolments = []
      this.pendingAltCredentials = []
      this.pendingDevices = []
      this.pendingPunches = []
      this.pendingSecurityEvents = []
      this.pendingOutboxInserts = []
      this.pendingProcessedEvents = []
      this.inTx = false
      return { rows: [] }
    }

    if (/\battendance\.biometric_consent\b/i.test(s)) return this.handleConsentState(s, params)
    if (/\battendance\.enrollment\b/i.test(s)) return this.handleEnrolment(s, params)
    if (/\battendance\.alternative_credential\b/i.test(s)) return this.handleAltCredential(s, params)
    if (/\battendance\.device\b/i.test(s)) return this.handleDevice(s, params)
    if (/\battendance\.punch_event\b/i.test(s)) return this.handlePunch(s, params)
    if (/\battendance\.security_event\b/i.test(s)) return this.handleSecurityEvent(s, params)
    if (/INSERT INTO\s+\S*outbox\b/i.test(s)) return this.handleOutboxInsert(params)
    if (/INSERT INTO\s+\S*processed_events\b/i.test(s)) return this.handleProcessedEventsInsert(s, params)

    throw new Error(`FakeAttendanceDb: unrecognised query: ${s}`)
  }

  // --- biometric_consent ---

  private visibleConsentState(employeeId: string): StoredConsentStateRow | undefined {
    return this.pendingConsentStates.find((r) => r.employee_id === employeeId) ?? this.db._consentState(employeeId)
  }

  private handleConsentState(s: string, params: unknown[]): { rows: Array<Record<string, unknown>> } {
    if (/^INSERT INTO/i.test(s)) {
      const [employeeId, state, updatedAt] = params as [string, string, string]
      if (!CONSENT_STATES.has(state)) throw new ConstraintViolation('biometric_consent_state_check')
      const row: StoredConsentStateRow = { employee_id: employeeId, state, updated_at: new Date(updatedAt) }
      if (this.inTx) {
        this.pendingConsentStates = this.pendingConsentStates.filter((r) => r.employee_id !== employeeId)
        this.pendingConsentStates.push(row)
      } else {
        this.db._putConsentState(row)
      }
      return { rows: [row as unknown as Record<string, unknown>] }
    }
    if (/^SELECT/i.test(s)) {
      const [employeeId] = params as [string]
      const row = this.visibleConsentState(employeeId)
      return { rows: row ? [row as unknown as Record<string, unknown>] : [] }
    }
    throw new Error(`FakeAttendanceDb: unrecognised biometric_consent query: ${s}`)
  }

  // --- enrollment ---

  private visibleEnrolments(): StoredEnrolmentRow[] {
    const byEmployee = new Map<string, StoredEnrolmentRow>()
    for (const r of this.db._allEnrolments()) byEmployee.set(r.employee_id, r)
    for (const r of this.pendingEnrolments) byEmployee.set(r.employee_id, r)
    return [...byEmployee.values()]
  }

  private handleEnrolment(s: string, params: unknown[]): { rows: Array<Record<string, unknown>> } {
    if (/^INSERT INTO/i.test(s)) {
      const [id, employeeId, method, faceSubjectRef] = params as [string, string, string, string | null]
      if (!ENROLMENT_METHODS.has(method)) throw new ConstraintViolation('enrollment_method_check')
      if (this.visibleEnrolments().some((r) => r.employee_id === employeeId)) {
        throw new ConstraintViolation('enrollment_employee_id_key')
      }
      const row: StoredEnrolmentRow = {
        id, employee_id: employeeId, method, face_subject_ref: faceSubjectRef,
        status: 'active', enrolled_at: new Date(), template_deleted_at: null,
      }
      if (this.inTx) this.pendingEnrolments.push(row)
      else this.db._putEnrolment(row)
      return { rows: [row as unknown as Record<string, unknown>] }
    }
    if (/^SELECT/i.test(s) && /WHERE face_subject_ref = \$1/i.test(s)) {
      const [faceSubjectRef] = params as [string]
      const row = this.visibleEnrolments().find((r) => r.face_subject_ref === faceSubjectRef)
      return { rows: row ? [row as unknown as Record<string, unknown>] : [] }
    }
    if (/^SELECT/i.test(s)) {
      const [employeeId] = params as [string]
      const row = this.visibleEnrolments().find((r) => r.employee_id === employeeId)
      return { rows: row ? [row as unknown as Record<string, unknown>] : [] }
    }
    if (/^UPDATE/i.test(s)) {
      const [employeeId, templateDeletedAt] = params as [string, string]
      const current = this.visibleEnrolments().find((r) => r.employee_id === employeeId)
      if (!current) return { rows: [] }
      if (!ENROLMENT_STATUSES.has('deleted')) throw new ConstraintViolation('enrollment_status_check')
      const next: StoredEnrolmentRow = { ...current, status: 'deleted', template_deleted_at: new Date(templateDeletedAt) }
      if (this.inTx) this.pendingEnrolments.push(next)
      else this.db._putEnrolment(next)
      return { rows: [next as unknown as Record<string, unknown>] }
    }
    throw new Error(`FakeAttendanceDb: unrecognised enrollment query: ${s}`)
  }

  // --- alternative_credential ---

  private visibleAltCredentials(): StoredAlternativeCredentialRow[] {
    const byEmployee = new Map<string, StoredAlternativeCredentialRow>()
    for (const r of this.db._allAltCredentials()) byEmployee.set(r.employee_id, r)
    for (const r of this.pendingAltCredentials) byEmployee.set(r.employee_id, r)
    return [...byEmployee.values()]
  }

  private handleAltCredential(s: string, params: unknown[]): { rows: Array<Record<string, unknown>> } {
    if (/^INSERT INTO/i.test(s)) {
      const [employeeId, kind, credentialHash] = params as [string, string, Buffer]
      if (!ALT_KINDS.has(kind)) throw new ConstraintViolation('alternative_credential_kind_check')
      const hash = toBuffer(credentialHash, 'credential_hash')
      const existingForOtherEmployee = this.visibleAltCredentials().find(
        (r) => r.employee_id !== employeeId && r.credential_hash.equals(hash),
      )
      if (existingForOtherEmployee) throw new ConstraintViolation('alternative_credential_hash_key')
      const row: StoredAlternativeCredentialRow = { employee_id: employeeId, kind, credential_hash: hash, created_at: new Date() }
      if (this.inTx) {
        this.pendingAltCredentials = this.pendingAltCredentials.filter((r) => r.employee_id !== employeeId)
        this.pendingAltCredentials.push(row)
      } else {
        this.db._putAltCredential(row)
      }
      return { rows: [row as unknown as Record<string, unknown>] }
    }
    if (/^SELECT/i.test(s) && /WHERE employee_id = \$1/i.test(s)) {
      const [employeeId] = params as [string]
      const row = this.visibleAltCredentials().find((r) => r.employee_id === employeeId)
      return { rows: row ? [row as unknown as Record<string, unknown>] : [] }
    }
    if (/^SELECT/i.test(s) && /WHERE credential_hash = \$1/i.test(s)) {
      const [credentialHash] = params as [Buffer]
      const hash = toBuffer(credentialHash, 'credential_hash')
      const row = this.visibleAltCredentials().find((r) => r.credential_hash.equals(hash))
      return { rows: row ? [row as unknown as Record<string, unknown>] : [] }
    }
    throw new Error(`FakeAttendanceDb: unrecognised alternative_credential query: ${s}`)
  }

  // --- device ---

  private visibleDevices(): StoredDeviceRow[] {
    const byId = new Map<string, StoredDeviceRow>()
    for (const r of this.db._allDevices()) byId.set(r.id, r)
    for (const r of this.pendingDevices) byId.set(r.id, r)
    return [...byId.values()]
  }

  private handleDevice(s: string, params: unknown[]): { rows: Array<Record<string, unknown>> } {
    if (/^INSERT INTO/i.test(s)) {
      const [id, kind, siteCode, deviceSecret, registeredBy] = params as [string, string, string, Buffer, string]
      if (!DEVICE_KINDS.has(kind)) throw new ConstraintViolation('device_kind_check')
      const row: StoredDeviceRow = {
        id, kind, site_code: siteCode, device_secret: toBuffer(deviceSecret, 'device_secret'),
        status: 'pending', registered_by: registeredBy, approved_by: null, approved_at: null,
      }
      if (this.inTx) this.pendingDevices.push(row)
      else this.db._putDevice(row)
      return { rows: [row as unknown as Record<string, unknown>] }
    }
    if (/^SELECT/i.test(s) && /WHERE id = \$1/i.test(s)) {
      const [id] = params as [string]
      const row = this.visibleDevices().find((r) => r.id === id)
      return { rows: row ? [row as unknown as Record<string, unknown>] : [] }
    }
    if (/^SELECT/i.test(s) && /ORDER BY site_code/i.test(s)) {
      return { rows: [...this.visibleDevices()].sort((a, b) => a.site_code.localeCompare(b.site_code)) as unknown as Array<Record<string, unknown>> }
    }
    if (/^UPDATE/i.test(s)) {
      const [id, approvedBy, approvedAt] = params as [string, string, string]
      const current = this.visibleDevices().find((r) => r.id === id)
      if (!current) return { rows: [] }
      if (!DEVICE_STATUSES.has('active')) throw new ConstraintViolation('device_status_check')
      const next: StoredDeviceRow = { ...current, status: 'active', approved_by: approvedBy, approved_at: new Date(approvedAt) }
      if (this.inTx) this.pendingDevices.push(next)
      else this.db._putDevice(next)
      return { rows: [next as unknown as Record<string, unknown>] }
    }
    throw new Error(`FakeAttendanceDb: unrecognised device query: ${s}`)
  }

  // --- punch_event ---

  private visiblePunches(): StoredPunchRow[] {
    const byId = new Map<string, StoredPunchRow>()
    for (const r of this.db._allPunches()) byId.set(r.id, r)
    for (const r of this.pendingPunches) byId.set(r.id, r)
    return [...byId.values()]
  }

  private handlePunch(s: string, params: unknown[]): { rows: Array<Record<string, unknown>> } {
    if (/^INSERT INTO/i.test(s)) {
      const [id, idemKey, employeeId, deviceId, punchedAt, direction, method, matchScore, livenessPassed, siteCode, geo] = params as [
        string, string, string, string, string, string, string, number | null, boolean | null, string, string | null,
      ]
      if (!PUNCH_DIRECTIONS.has(direction)) throw new ConstraintViolation('punch_event_direction_check')
      if (!PUNCH_METHODS.has(method)) throw new ConstraintViolation('punch_event_method_check')

      // ON CONFLICT (idem_key) DO NOTHING — the real mechanism under test.
      const existing = this.visiblePunches().find((r) => r.idem_key === idemKey)
      if (existing) return { rows: [] }

      const row: StoredPunchRow = {
        id, idem_key: idemKey, employee_id: employeeId, device_id: deviceId, punched_at: new Date(punchedAt),
        direction, method, match_score: matchScore, liveness_passed: livenessPassed, site_code: siteCode,
        geo: geo === null ? null : (JSON.parse(geo) as unknown),
      }
      if (this.inTx) this.pendingPunches.push(row)
      else this.db._putPunch(row)
      return { rows: [row as unknown as Record<string, unknown>] }
    }
    if (/^SELECT/i.test(s) && /WHERE idem_key = \$1/i.test(s)) {
      const [idemKey] = params as [string]
      const row = this.visiblePunches().find((r) => r.idem_key === idemKey)
      return { rows: row ? [row as unknown as Record<string, unknown>] : [] }
    }
    if (/^SELECT/i.test(s) && /WHERE employee_id = \$1/i.test(s)) {
      const [employeeId, from, to] = params as [string, string, string]
      const fromMs = new Date(from).getTime()
      const toMs = new Date(to).getTime()
      const rows = this.visiblePunches()
        .filter((r) => r.employee_id === employeeId && r.punched_at.getTime() >= fromMs && r.punched_at.getTime() <= toMs)
        .sort((a, b) => b.punched_at.getTime() - a.punched_at.getTime())
      return { rows: rows as unknown as Array<Record<string, unknown>> }
    }
    throw new Error(`FakeAttendanceDb: unrecognised punch_event query: ${s}`)
  }

  // --- security_event ---

  private visibleSecurityEvents(): StoredSecurityEventRow[] {
    return [...this.db._allSecurityEvents(), ...this.pendingSecurityEvents]
  }

  private handleSecurityEvent(s: string, params: unknown[]): { rows: Array<Record<string, unknown>> } {
    if (/^INSERT INTO/i.test(s)) {
      const [id, kind, deviceId, employeeId, siteCode, at] = params as [string, string, string | null, string | null, string, string]
      if (!SECURITY_EVENT_KINDS.has(kind)) throw new ConstraintViolation('security_event_kind_check')
      const row: StoredSecurityEventRow = { id, kind, device_id: deviceId, employee_id: employeeId, site_code: siteCode, at: new Date(at) }
      if (this.inTx) this.pendingSecurityEvents.push(row)
      else this.db._putSecurityEvent(row)
      return { rows: [row as unknown as Record<string, unknown>] }
    }
    if (/^SELECT/i.test(s)) {
      const [kind] = params as [string]
      const rows = this.visibleSecurityEvents()
        .filter((r) => r.kind === kind)
        .sort((a, b) => b.at.getTime() - a.at.getTime())
      return { rows: rows as unknown as Array<Record<string, unknown>> }
    }
    throw new Error(`FakeAttendanceDb: unrecognised security_event query: ${s}`)
  }

  // --- outbox / processed_events ---

  private handleOutboxInsert(params: unknown[]): { rows: Array<Record<string, unknown>> } {
    const [topic, payloadJson] = params as [string, string]
    const row: StoredOutboxRow = { id: randomUUID(), topic, payload: JSON.parse(payloadJson) as unknown, created_at: new Date(), published_at: null }
    if (this.inTx) this.pendingOutboxInserts.push(row)
    else this.db._insertOutboxRow(row)
    return { rows: [{ id: row.id }] }
  }

  private handleProcessedEventsInsert(s: string, params: unknown[]): { rows: Array<Record<string, unknown>> } {
    const schemaMatch = /INSERT INTO\s+(\S+)\.processed_events/i.exec(s)
    const schema = schemaMatch?.[1] ?? 'attendance'
    const [eventId] = params as [string]
    const alreadyCommitted = this.db._processedEventExists(schema, eventId)
    const alreadyPendingHere = this.pendingProcessedEvents.some((p) => p.schema === schema && p.eventId === eventId)
    if (alreadyCommitted || alreadyPendingHere) return { rows: [] }
    if (this.inTx) this.pendingProcessedEvents.push({ schema, eventId })
    else this.db._insertProcessedEvent(schema, eventId)
    return { rows: [{ event_id: eventId }] }
  }
}
