import { randomUUID } from 'node:crypto'
import type { Queryable } from '@gadong/kernel'

/**
 * A tiny in-memory stand-in for Postgres, scoped to the `claims` schema —
 * same reason and shape as `services/svc-config/src/testing/fake-db.ts`:
 * there is no Postgres in this environment (Task 14 brief CONSTRAINTS).
 * Migrations in `migrations/` are the source of truth for the real schema;
 * a later integration task re-proves this suite against real Postgres.
 *
 * Reads happen on an "autocommit" connection (`asPool()`) that never sees
 * BEGIN, so every query it runs commits to the shared store immediately —
 * this mirrors a real Postgres client outside a transaction, and is why
 * `claims.service.ts`'s repositories only ever see data another
 * connection's transaction has actually COMMITted, never a pending write.
 */

interface StoredClaimType {
  code: string
  name: string
  per_claim_limit: string | null
  per_claim_limit_kind: string | null
  monthly_limit: string | null
  monthly_limit_kind: string | null
  annual_limit: string | null
  annual_limit_kind: string | null
  receipt_required: boolean
  required_fields: string // jsonb stored as serialised text
  mileage_rate: string | null
  active: boolean
  created_at: Date
}

interface StoredBand {
  id: string
  max_amount: string | null
  approver_roles: string // jsonb
  sort_order: number
}

interface StoredClaim {
  id: string
  employee_id: string
  claim_type: string
  amount_thb: string
  status: string
  dup_hash: string | null
  claim_date: string | null
  vendor: string | null
  mileage_km: string | null
  vat_amount: string | null
  reimbursement_route: string | null
  rejection_reason: string | null
  round: number
  soft_limit_warning: boolean
  submitted_at: string | null
  decided_at: string | null
  routed_at: string | null
  paid_at: string | null
  fields: string // jsonb
}

interface StoredReceipt {
  id: string
  claim_id: string
  file_ref: Buffer
  vat_amount: string | null
}

interface StoredStep {
  id: string
  subject_id: string
  level: number
  approver_role: string
  approver_id: string | null
  decided_at: Date | null
  decision: string | null
  comment: string | null
  round: number
}

interface StoredEmployeeRef {
  employee_id: string
  status: string
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
    super(`FakeClaimsDb: violates constraint "${constraint}"`)
  }
}

export class FakeClaimsDb {
  private readonly claimTypes = new Map<string, StoredClaimType>()
  private readonly bands = new Map<string, StoredBand>()
  private readonly claims = new Map<string, StoredClaim>()
  private readonly receipts = new Map<string, StoredReceipt>()
  private readonly steps = new Map<string, StoredStep>()
  private readonly employeeRefs = new Map<string, StoredEmployeeRef>()
  private readonly outbox = new Map<string, StoredOutboxRow>()
  private readonly processedEvents = new Set<string>()

  connect(): FakeClaimsConnection {
    return new FakeClaimsConnection(this)
  }

  asPool(): Queryable {
    const conn = this.connect()
    return { query: (sql: string, params?: unknown[]) => conn.query(sql, params) }
  }

  /** Seeds the PRD worked example directly into the store — the same two bands the real migration's `pgm.sql` INSERT seeds, for tests that don't run the migration. */
  seedDefaultApprovalBands(): void {
    this._insertBand({ id: randomUUID(), max_amount: '2000', approver_roles: JSON.stringify(['manager']), sort_order: 1 })
    this._insertBand({ id: randomUUID(), max_amount: null, approver_roles: JSON.stringify(['manager', 'finance']), sort_order: 2 })
  }

  debugClaims(): StoredClaim[] {
    return [...this.claims.values()]
  }

  debugReceipts(): StoredReceipt[] {
    return [...this.receipts.values()]
  }

  debugSteps(): StoredStep[] {
    return [...this.steps.values()]
  }

  debugOutboxRows(): StoredOutboxRow[] {
    return [...this.outbox.values()]
  }

  debugEmployeeRefs(): StoredEmployeeRef[] {
    return [...this.employeeRefs.values()]
  }

  // --- internals used only by FakeClaimsConnection ---

  _allClaimTypes(): StoredClaimType[] {
    return [...this.claimTypes.values()]
  }
  _upsertClaimType(row: StoredClaimType): void {
    this.claimTypes.set(row.code, row)
  }

  _allBands(): StoredBand[] {
    return [...this.bands.values()]
  }
  _insertBand(row: StoredBand): void {
    this.bands.set(row.id, row)
  }
  _clearBands(): void {
    this.bands.clear()
  }

  _allClaims(): StoredClaim[] {
    return [...this.claims.values()]
  }
  _upsertClaim(row: StoredClaim): void {
    this.claims.set(row.id, row)
  }

  _allReceipts(): StoredReceipt[] {
    return [...this.receipts.values()]
  }
  _insertReceipt(row: StoredReceipt): void {
    this.receipts.set(row.id, row)
  }

  _allSteps(): StoredStep[] {
    return [...this.steps.values()]
  }
  _upsertStep(row: StoredStep): void {
    this.steps.set(row.id, row)
  }

  _employeeRef(id: string): StoredEmployeeRef | undefined {
    return this.employeeRefs.get(id)
  }
  _upsertEmployeeRef(row: StoredEmployeeRef): void {
    this.employeeRefs.set(row.employee_id, row)
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

function toClaimTypeReturned(r: StoredClaimType): Record<string, unknown> {
  return { ...r, required_fields: JSON.parse(r.required_fields) as unknown }
}
function toBandReturned(r: StoredBand): Record<string, unknown> {
  return { ...r, approver_roles: JSON.parse(r.approver_roles) as unknown }
}
function toClaimReturned(r: StoredClaim): Record<string, unknown> {
  return { ...r, fields: JSON.parse(r.fields) as unknown }
}

/** One session/connection. Writes made inside BEGIN/COMMIT are staged locally (mirroring `services/svc-config`'s `FakeConfigConnection`) and only join the committed store on COMMIT; a connection that never sees BEGIN commits every statement immediately (autocommit), matching a real `pg` client used outside an explicit transaction. */
export class FakeClaimsConnection implements Queryable {
  private inTx = false
  private pendingClaimTypes: StoredClaimType[] = []
  private pendingBands: StoredBand[] | null = null // null = no pending DELETE-then-INSERT staged
  private pendingClaims: StoredClaim[] = []
  private pendingReceipts: StoredReceipt[] = []
  private pendingSteps: StoredStep[] = []
  private pendingEmployeeRefs: StoredEmployeeRef[] = []
  private pendingOutboxInserts: StoredOutboxRow[] = []
  private pendingProcessedEvents: Array<{ schema: string; eventId: string }> = []

  constructor(private readonly db: FakeClaimsDb) {}

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
      this.commitPending()
      this.inTx = false
      return { rows: [] }
    }
    if (/^ROLLBACK\b/i.test(s)) {
      this.resetPending()
      this.inTx = false
      return { rows: [] }
    }

    // --- claim_type ---
    if (/^INSERT INTO\s+claims\.claim_type\b/i.test(s)) return { rows: [toClaimTypeReturned(this.insertClaimType(params))] }
    if (/^UPDATE\s+claims\.claim_type\b/i.test(s)) return this.updateClaimType(params)
    if (/^SELECT[\s\S]*FROM\s+claims\.claim_type\b/i.test(s)) return this.selectClaimType(s, params)

    // --- approval_band ---
    if (/^DELETE FROM\s+claims\.approval_band\b/i.test(s)) {
      this.pendingBands = []
      if (!this.inTx) this.db._clearBands()
      return { rows: [] }
    }
    if (/^INSERT INTO\s+claims\.approval_band\b/i.test(s)) return { rows: [toBandReturned(this.insertBand(params))] }
    if (/^SELECT[\s\S]*FROM\s+claims\.approval_band\b/i.test(s)) {
      const visible = this.visibleBands().sort((a, b) => a.sort_order - b.sort_order)
      return { rows: visible.map(toBandReturned) }
    }

    // --- claim ---
    if (/^INSERT INTO\s+claims\.claim\b/i.test(s)) return { rows: [toClaimReturned(this.insertClaim(params))] }
    if (/^UPDATE\s+claims\.claim\b[\s\S]*SET amount_thb = \$2/i.test(s)) return this.applyResubmission(params)
    if (/^UPDATE\s+claims\.claim\b[\s\S]*status = 'rejected'/i.test(s)) return this.markClaimStatus(params, 'rejected', true)
    if (/^UPDATE\s+claims\.claim\b[\s\S]*status = 'approved'/i.test(s)) return this.markClaimStatus(params, 'approved', false)
    if (/^UPDATE\s+claims\.claim\b[\s\S]*SET status = \$2/i.test(s)) return this.routeClaim(params)
    if (/^SELECT SUM\(amount_thb\)/i.test(s)) return this.sumActiveAmount(params)
    if (/^SELECT[\s\S]*FROM\s+claims\.claim\b/i.test(s)) return this.selectClaim(s, params)

    // --- receipt ---
    if (/^INSERT INTO\s+claims\.receipt\b/i.test(s)) return { rows: [this.insertReceipt(params)] }
    if (/^SELECT[\s\S]*FROM\s+claims\.receipt\b/i.test(s)) {
      const [claimId] = params as [string]
      const visible = this.visibleReceipts().filter((r) => r.claim_id === claimId)
      return { rows: visible.map((r) => ({ ...r })) }
    }

    // --- approval_step2 ---
    if (/^INSERT INTO\s+claims\.approval_step2\b/i.test(s)) return { rows: [this.insertStep(params)] }
    if (/^UPDATE\s+claims\.approval_step2\b/i.test(s)) return this.decideStep(params)
    if (/^SELECT[\s\S]*FROM\s+claims\.approval_step2\b/i.test(s)) {
      const [subjectId, round] = params as [string, number]
      const visible = this.visibleSteps()
        .filter((st) => st.subject_id === subjectId && st.round === round)
        .sort((a, b) => a.level - b.level)
      return { rows: visible.map((st) => ({ ...st })) }
    }

    // --- claims_employee_ref ---
    if (/^INSERT INTO\s+claims\.claims_employee_ref\b/i.test(s)) return { rows: [this.upsertEmployeeRef(params)] }
    if (/^SELECT[\s\S]*FROM\s+claims\.claims_employee_ref\b/i.test(s)) {
      const [employeeId] = params as [string]
      const row = this.visibleEmployeeRef(employeeId)
      return { rows: row ? [{ ...row }] : [] }
    }

    // --- outbox / processed_events (generic, any schema prefix) ---
    if (/^INSERT INTO\s+\S*outbox\b/i.test(s)) {
      const [topic, payloadJson] = params as [string, string]
      const row: StoredOutboxRow = { id: randomUUID(), topic, payload: JSON.parse(payloadJson) as unknown, created_at: new Date(), published_at: null }
      if (this.inTx) this.pendingOutboxInserts.push(row)
      else this.db._insertOutboxRow(row)
      return { rows: [{ id: row.id }] }
    }
    if (/^INSERT INTO\s+\S*processed_events\b/i.test(s)) {
      const schemaMatch = /INSERT INTO\s+(\S+)\.processed_events/i.exec(s)
      const schema = schemaMatch?.[1] ?? 'claims'
      const [eventId] = params as [string]
      const alreadyCommitted = this.db._processedEventExists(schema, eventId)
      const alreadyPendingHere = this.pendingProcessedEvents.some((p) => p.schema === schema && p.eventId === eventId)
      if (alreadyCommitted || alreadyPendingHere) return { rows: [] }
      if (this.inTx) this.pendingProcessedEvents.push({ schema, eventId })
      else this.db._insertProcessedEvent(schema, eventId)
      return { rows: [{ event_id: eventId }] }
    }

    // kernel `outboxDepth` (event-bus health/metrics) — fixed SQL text this fake doesn't own, same precedent as the two branches above.
    if (/^SELECT\s+count\(\*\)/i.test(s) && /FROM\s+\S*outbox\b/i.test(s)) {
      const pending = this.db.debugOutboxRows().filter((r) => r.published_at === null)
      const oldestAgeSeconds =
        pending.length === 0 ? null : Math.max(0, (Date.now() - Math.min(...pending.map((r) => r.created_at.getTime()))) / 1000)
      return { rows: [{ pending: pending.length, oldest_age_seconds: oldestAgeSeconds }] }
    }

    throw new Error(`FakeClaimsDb: unrecognised query: ${s}`)
  }

  // ---------------- pending lifecycle ----------------

  private resetPending(): void {
    this.pendingClaimTypes = []
    this.pendingBands = null
    this.pendingClaims = []
    this.pendingReceipts = []
    this.pendingSteps = []
    this.pendingEmployeeRefs = []
    this.pendingOutboxInserts = []
    this.pendingProcessedEvents = []
  }

  private commitPending(): void {
    for (const row of this.pendingClaimTypes) this.db._upsertClaimType(row)
    if (this.pendingBands !== null) {
      this.db._clearBands()
      for (const row of this.pendingBands) this.db._insertBand(row)
    }
    for (const row of this.pendingClaims) this.db._upsertClaim(row)
    for (const row of this.pendingReceipts) this.db._insertReceipt(row)
    for (const row of this.pendingSteps) this.db._upsertStep(row)
    for (const row of this.pendingEmployeeRefs) this.db._upsertEmployeeRef(row)
    for (const row of this.pendingOutboxInserts) this.db._insertOutboxRow(row)
    for (const { schema, eventId } of this.pendingProcessedEvents) this.db._insertProcessedEvent(schema, eventId)
  }

  // ---------------- claim_type ----------------

  private visibleClaimTypes(): StoredClaimType[] {
    const byCode = new Map<string, StoredClaimType>()
    for (const r of this.db._allClaimTypes()) byCode.set(r.code, r)
    for (const r of this.pendingClaimTypes) byCode.set(r.code, r)
    return [...byCode.values()]
  }

  private insertClaimType(params: unknown[]): StoredClaimType {
    const [code, name, perClaimLimit, perClaimLimitKind, monthlyLimit, monthlyLimitKind, annualLimit, annualLimitKind, receiptRequired, requiredFieldsJson, mileageRate, active] =
      params as [string, string, string | null, string | null, string | null, string | null, string | null, string | null, boolean, string, string | null, boolean]
    if (this.visibleClaimTypes().some((r) => r.code === code)) {
      throw new ConstraintViolation('claim_type_pkey')
    }
    const row: StoredClaimType = {
      code,
      name,
      per_claim_limit: perClaimLimit,
      per_claim_limit_kind: perClaimLimitKind,
      monthly_limit: monthlyLimit,
      monthly_limit_kind: monthlyLimitKind,
      annual_limit: annualLimit,
      annual_limit_kind: annualLimitKind,
      receipt_required: receiptRequired,
      required_fields: requiredFieldsJson,
      mileage_rate: mileageRate,
      active,
      created_at: new Date(),
    }
    if (this.inTx) this.pendingClaimTypes.push(row)
    else this.db._upsertClaimType(row)
    return row
  }

  private updateClaimType(params: unknown[]): { rows: Array<Record<string, unknown>> } {
    const [code, name, perClaimLimit, perClaimLimitKind, monthlyLimit, monthlyLimitKind, annualLimit, annualLimitKind, receiptRequired, requiredFieldsJson, mileageRate, active] =
      params as [string, string, string | null, string | null, string | null, string | null, string | null, string | null, boolean, string, string | null, boolean]
    const current = [...this.visibleClaimTypes()].reverse().find((r) => r.code === code)
    if (!current) return { rows: [] }
    const updated: StoredClaimType = {
      ...current,
      name,
      per_claim_limit: perClaimLimit,
      per_claim_limit_kind: perClaimLimitKind,
      monthly_limit: monthlyLimit,
      monthly_limit_kind: monthlyLimitKind,
      annual_limit: annualLimit,
      annual_limit_kind: annualLimitKind,
      receipt_required: receiptRequired,
      required_fields: requiredFieldsJson,
      mileage_rate: mileageRate,
      active,
    }
    if (this.inTx) this.pendingClaimTypes.push(updated)
    else this.db._upsertClaimType(updated)
    return { rows: [toClaimTypeReturned(updated)] }
  }

  private selectClaimType(sql: string, params: unknown[]): { rows: Array<Record<string, unknown>> } {
    const visible = this.visibleClaimTypes()
    if (/WHERE code = \$1/i.test(sql)) {
      const [code] = params as [string]
      return { rows: visible.filter((r) => r.code === code).map(toClaimTypeReturned) }
    }
    return { rows: visible.sort((a, b) => a.code.localeCompare(b.code)).map(toClaimTypeReturned) }
  }

  // ---------------- approval_band ----------------

  private visibleBands(): StoredBand[] {
    if (this.pendingBands !== null) return this.pendingBands
    return this.db._allBands()
  }

  private insertBand(params: unknown[]): StoredBand {
    const [maxAmount, approverRolesJson, sortOrder] = params as [string | null, string, number]
    const row: StoredBand = { id: randomUUID(), max_amount: maxAmount, approver_roles: approverRolesJson, sort_order: sortOrder }
    if (this.inTx) {
      if (this.pendingBands === null) this.pendingBands = [...this.db._allBands()]
      this.pendingBands.push(row)
    } else {
      this.db._insertBand(row)
    }
    return row
  }

  // ---------------- claim ----------------

  private visibleClaims(): StoredClaim[] {
    const byId = new Map<string, StoredClaim>()
    for (const r of this.db._allClaims()) byId.set(r.id, r)
    for (const r of this.pendingClaims) byId.set(r.id, r)
    return [...byId.values()]
  }

  private insertClaim(params: unknown[]): StoredClaim {
    const [employeeId, claimType, amountThb, status, dupHash, claimDate, vendor, mileageKm, vatAmount, round, softLimitWarning, submittedAt, fieldsJson] =
      params as [string, string, string, string, string | null, string | null, string | null, string | null, string | null, number, boolean, string | null, string]
    const row: StoredClaim = {
      id: randomUUID(),
      employee_id: employeeId,
      claim_type: claimType,
      amount_thb: amountThb,
      status,
      dup_hash: dupHash,
      claim_date: claimDate,
      vendor,
      mileage_km: mileageKm,
      vat_amount: vatAmount,
      reimbursement_route: null,
      rejection_reason: null,
      round,
      soft_limit_warning: softLimitWarning,
      submitted_at: submittedAt,
      decided_at: null,
      routed_at: null,
      paid_at: null,
      fields: fieldsJson,
    }
    if (this.inTx) this.pendingClaims.push(row)
    else this.db._upsertClaim(row)
    return row
  }

  private applyResubmission(params: unknown[]): { rows: Array<Record<string, unknown>> } {
    const [id, amountThb, dupHash, claimDate, vendor, mileageKm, vatAmount, round, softLimitWarning, fieldsJson] = params as [
      string,
      string,
      string | null,
      string | null,
      string | null,
      string | null,
      string | null,
      number,
      boolean,
      string,
    ]
    const current = [...this.visibleClaims()].find((r) => r.id === id)
    if (!current) return { rows: [] }
    const updated: StoredClaim = {
      ...current,
      amount_thb: amountThb,
      dup_hash: dupHash,
      claim_date: claimDate,
      vendor,
      mileage_km: mileageKm,
      vat_amount: vatAmount,
      round,
      soft_limit_warning: softLimitWarning,
      status: 'pending',
      rejection_reason: null,
      submitted_at: new Date().toISOString(),
      decided_at: null,
      fields: fieldsJson,
    }
    if (this.inTx) this.pendingClaims.push(updated)
    else this.db._upsertClaim(updated)
    return { rows: [toClaimReturned(updated)] }
  }

  private markClaimStatus(params: unknown[], status: string, withReason: boolean): { rows: Array<Record<string, unknown>> } {
    const [id, reason] = params as [string, string | undefined]
    const current = [...this.visibleClaims()].find((r) => r.id === id)
    if (!current) return { rows: [] }
    const updated: StoredClaim = {
      ...current,
      status,
      rejection_reason: withReason ? (reason ?? null) : current.rejection_reason,
      decided_at: new Date().toISOString(),
    }
    if (this.inTx) this.pendingClaims.push(updated)
    else this.db._upsertClaim(updated)
    return { rows: [toClaimReturned(updated)] }
  }

  private routeClaim(params: unknown[]): { rows: Array<Record<string, unknown>> } {
    const [id, newStatus, route] = params as [string, string, string]
    const current = [...this.visibleClaims()].find((r) => r.id === id)
    if (!current) return { rows: [] }
    const now = new Date().toISOString()
    const updated: StoredClaim = {
      ...current,
      status: newStatus,
      reimbursement_route: route,
      routed_at: now,
      paid_at: route === 'offcycle' ? now : current.paid_at,
    }
    if (this.inTx) this.pendingClaims.push(updated)
    else this.db._upsertClaim(updated)
    return { rows: [toClaimReturned(updated)] }
  }

  private selectClaim(sql: string, params: unknown[]): { rows: Array<Record<string, unknown>> } {
    const visible = this.visibleClaims()
    if (/WHERE id = \$1/i.test(sql)) {
      const [id] = params as [string]
      return { rows: visible.filter((r) => r.id === id).map(toClaimReturned) }
    }
    if (/dup_hash = \$3/i.test(sql)) {
      const [employeeId, claimType, dupHash, excludeId] = params as [string, string, string, string | null]
      const rows = visible.filter(
        (r) =>
          r.employee_id === employeeId &&
          r.claim_type === claimType &&
          r.dup_hash === dupHash &&
          r.status !== 'rejected' &&
          r.status !== 'draft' &&
          (excludeId === null || r.id !== excludeId),
      )
      return { rows: rows.map(toClaimReturned) }
    }
    if (/employee_id = \$1 AND status = \$2/i.test(sql)) {
      const [employeeId, status] = params as [string, string]
      const rows = visible.filter((r) => r.employee_id === employeeId && r.status === status)
      return { rows: rows.map(toClaimReturned) }
    }
    if (/employee_id = \$1/i.test(sql)) {
      const [employeeId] = params as [string]
      const rows = visible.filter((r) => r.employee_id === employeeId)
      return { rows: rows.map(toClaimReturned) }
    }
    throw new Error(`FakeClaimsDb: unrecognised claim SELECT: ${sql}`)
  }

  private sumActiveAmount(params: unknown[]): { rows: Array<Record<string, unknown>> } {
    const [employeeId, claimType, fromDate, toDate, excludeId] = params as [string, string, string, string, string | null]
    const visible = this.visibleClaims().filter(
      (r) =>
        r.employee_id === employeeId &&
        r.claim_type === claimType &&
        r.status !== 'rejected' &&
        r.status !== 'draft' &&
        r.claim_date !== null &&
        r.claim_date >= fromDate &&
        r.claim_date < toDate &&
        (excludeId === null || r.id !== excludeId),
    )
    if (visible.length === 0) return { rows: [{ total: null }] }
    const total = visible.reduce((acc, r) => addPlainDecimal(acc, r.amount_thb), '0')
    return { rows: [{ total }] }
  }

  // ---------------- receipt ----------------

  private visibleReceipts(): StoredReceipt[] {
    const byId = new Map<string, StoredReceipt>()
    for (const r of this.db._allReceipts()) byId.set(r.id, r)
    for (const r of this.pendingReceipts) byId.set(r.id, r)
    return [...byId.values()]
  }

  private insertReceipt(params: unknown[]): Record<string, unknown> {
    const [claimId, fileRef, vatAmount] = params as [string, Buffer, string | null]
    const row: StoredReceipt = { id: randomUUID(), claim_id: claimId, file_ref: fileRef, vat_amount: vatAmount }
    if (this.inTx) this.pendingReceipts.push(row)
    else this.db._insertReceipt(row)
    return { ...row }
  }

  // ---------------- approval_step2 ----------------

  private visibleSteps(): StoredStep[] {
    const byId = new Map<string, StoredStep>()
    for (const r of this.db._allSteps()) byId.set(r.id, r)
    for (const r of this.pendingSteps) byId.set(r.id, r)
    return [...byId.values()]
  }

  private insertStep(params: unknown[]): Record<string, unknown> {
    const [subjectId, level, approverRole, round] = params as [string, number, string, number]
    const row: StoredStep = {
      id: randomUUID(),
      subject_id: subjectId,
      level,
      approver_role: approverRole,
      approver_id: null,
      decided_at: null,
      decision: null,
      comment: null,
      round,
    }
    if (this.inTx) this.pendingSteps.push(row)
    else this.db._upsertStep(row)
    return { ...row }
  }

  private decideStep(params: unknown[]): { rows: Array<Record<string, unknown>> } {
    const [id, approverId, decision, comment] = params as [string, string, string, string | null]
    const current = [...this.visibleSteps()].find((r) => r.id === id)
    if (!current) return { rows: [] }
    const updated: StoredStep = { ...current, approver_id: approverId, decision, comment, decided_at: new Date() }
    if (this.inTx) this.pendingSteps.push(updated)
    else this.db._upsertStep(updated)
    return { rows: [{ ...updated }] }
  }

  // ---------------- claims_employee_ref ----------------

  private visibleEmployeeRef(employeeId: string): StoredEmployeeRef | undefined {
    return [...this.pendingEmployeeRefs].reverse().find((r) => r.employee_id === employeeId) ?? this.db._employeeRef(employeeId)
  }

  private upsertEmployeeRef(params: unknown[]): Record<string, unknown> {
    const [employeeId, status] = params as [string, string]
    const row: StoredEmployeeRef = { employee_id: employeeId, status, updated_at: new Date() }
    if (this.inTx) this.pendingEmployeeRefs.push(row)
    else this.db._upsertEmployeeRef(row)
    return { ...row }
  }
}

/** Plain decimal string addition for the fake's SUM() emulation — duplicated from `../decimal.ts` rather than imported, so this test-only fixture has no production import (keeps the dependency direction test -> src, never src -> test). Same BigInt approach: SUM must not touch a float either. */
function addPlainDecimal(a: string, b: string): string {
  const scale = Math.max(decimalScale(a), decimalScale(b))
  const av = toScaledBigInt(a, scale)
  const bv = toScaledBigInt(b, scale)
  const sum = av + bv
  const negative = sum < 0n
  const abs = negative ? -sum : sum
  const digits = abs.toString().padStart(scale + 1, '0')
  const intPart = digits.slice(0, digits.length - scale) || '0'
  const fracPart = scale > 0 ? digits.slice(digits.length - scale) : ''
  const body = fracPart.length > 0 ? `${intPart}.${fracPart}` : intPart
  return negative && abs !== 0n ? `-${body}` : body
}
function decimalScale(v: string): number {
  const dot = v.indexOf('.')
  return dot === -1 ? 0 : v.length - dot - 1
}
function toScaledBigInt(v: string, scale: number): bigint {
  const negative = v.startsWith('-')
  const unsigned = negative ? v.slice(1) : v
  const [intPart, fracPart = ''] = unsigned.split('.')
  const padded = fracPart.padEnd(scale, '0')
  const value = BigInt((intPart || '0') + padded)
  return negative ? -value : value
}
