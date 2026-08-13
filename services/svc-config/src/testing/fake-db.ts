import { randomUUID } from 'node:crypto'
import type { Queryable } from '@gadong/kernel'

/**
 * A tiny in-memory stand-in for Postgres, scoped to the `config` schema —
 * the same reason and the same shape as `@gadong/kernel`'s
 * `outbox/testing/fake-db.ts` (Task 4): there is no Postgres in this
 * environment (Task 7 brief), so the repository layer is proven against a
 * fake instead. Migrations in `migrations/` are the source of truth for the
 * real schema; Task 13b re-proves this suite against real Postgres.
 *
 * Two constraints are enforced here because they are load-bearing for this
 * task's compliance claim (Task 7 brief §3) and must be provable even
 * without a live database:
 *  - `UNIQUE (rule_key, effective_from)`
 *  - `CHECK (proposed_by IS NULL OR approved_by IS NULL OR proposed_by <> approved_by)`
 * Both are checked at INSERT time against already-committed rows and this
 * connection's own uncommitted (pending) rows — matching Postgres, which
 * validates a non-deferrable constraint immediately when the row is
 * written, not deferred to COMMIT.
 */

export interface StoredRuleRow {
  id: string
  rule_key: string
  value: string // jsonb stored as its serialised text, like Postgres would return via a driver that doesn't auto-parse
  unit: string
  statutory_floor: string
  statutory_ceiling: string
  citation: string
  effective_from: string
  effective_to: string | null
  governance_class: string
  status: string
  proposed_by: string | null
  approved_by: string | null
  reason: string | null
  created_at: Date
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
    super(`FakeDb: violates constraint "${constraint}"`)
  }
}

export class FakeConfigDb {
  private readonly rules = new Map<string, StoredRuleRow>()
  private readonly outbox = new Map<string, StoredOutboxRow>()
  private readonly processedEvents = new Set<string>()

  connect(): FakeConfigConnection {
    return new FakeConfigConnection(this)
  }

  /** A `Queryable` that runs every statement outside a transaction (autocommit) — enough for the repository's read-only methods. */
  asPool(): Queryable {
    const conn = this.connect()
    return { query: (sql: string, params?: unknown[]) => conn.query(sql, params) }
  }

  debugRules(): StoredRuleRow[] {
    return [...this.rules.values()]
  }

  debugOutboxRows(): StoredOutboxRow[] {
    return [...this.outbox.values()]
  }

  // --- internals used only by FakeConfigConnection ---

  _allRules(): StoredRuleRow[] {
    return [...this.rules.values()]
  }

  _insertRule(row: StoredRuleRow): void {
    this.rules.set(row.id, row)
  }

  _updateRule(row: StoredRuleRow): void {
    this.rules.set(row.id, row)
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

const RULE_COLUMNS = [
  'id',
  'rule_key',
  'value',
  'unit',
  'statutory_floor',
  'statutory_ceiling',
  'citation',
  'effective_from',
  'effective_to',
  'governance_class',
  'status',
  'proposed_by',
  'approved_by',
  'reason',
  'created_at',
] as const

function toReturnedRow(r: StoredRuleRow): Record<string, unknown> {
  return {
    id: r.id,
    rule_key: r.rule_key,
    value: JSON.parse(r.value) as unknown,
    unit: r.unit,
    statutory_floor: JSON.parse(r.statutory_floor) as unknown,
    statutory_ceiling: JSON.parse(r.statutory_ceiling) as unknown,
    citation: r.citation,
    effective_from: r.effective_from,
    effective_to: r.effective_to,
    governance_class: r.governance_class,
    status: r.status,
    proposed_by: r.proposed_by,
    approved_by: r.approved_by,
    reason: r.reason,
    created_at: r.created_at,
  }
}

/** One session/connection. Mirrors kernel's `FakeConnection`: writes made in a transaction are staged locally and only join the committed store on COMMIT. */
export class FakeConfigConnection implements Queryable {
  private inTx = false
  private pendingRuleInserts: StoredRuleRow[] = []
  private pendingRuleUpdates: StoredRuleRow[] = []
  private pendingOutboxInserts: StoredOutboxRow[] = []
  private pendingProcessedEvents: Array<{ schema: string; eventId: string }> = []

  constructor(private readonly db: FakeConfigDb) {}

  /** No-op — present so kernel's `withTransaction`/`withConnection` (which call `client.release()`) can drive this fake directly, the same as a real `pg.PoolClient`. */
  release(_err?: Error): void {
    void _err
  }

  async query(sql: string, params: unknown[] = []): Promise<{ rows: Array<Record<string, unknown>> }> {
    const s = sql.trim()

    if (/^BEGIN\b/i.test(s)) {
      this.inTx = true
      this.pendingRuleInserts = []
      this.pendingRuleUpdates = []
      this.pendingOutboxInserts = []
      this.pendingProcessedEvents = []
      return { rows: [] }
    }

    if (/^COMMIT\b/i.test(s)) {
      for (const row of this.pendingRuleInserts) this.db._insertRule(row)
      for (const row of this.pendingRuleUpdates) this.db._updateRule(row)
      for (const row of this.pendingOutboxInserts) this.db._insertOutboxRow(row)
      for (const { schema, eventId } of this.pendingProcessedEvents) this.db._insertProcessedEvent(schema, eventId)
      this.inTx = false
      return { rows: [] }
    }

    if (/^ROLLBACK\b/i.test(s)) {
      this.pendingRuleInserts = []
      this.pendingRuleUpdates = []
      this.pendingOutboxInserts = []
      this.pendingProcessedEvents = []
      this.inTx = false
      return { rows: [] }
    }

    if (/^INSERT INTO\s+config\.statutory_rule\b/i.test(s)) {
      return { rows: [toReturnedRow(this.insertRule(params))] }
    }

    if (/^UPDATE\s+config\.statutory_rule\b/i.test(s)) {
      const [id, approvedBy] = params as [string, string]
      const visible = [...this.db._allRules(), ...this.pendingRuleInserts, ...this.pendingRuleUpdates]
      // last write for this id wins
      const current = [...visible].reverse().find((r) => r.id === id)
      if (!current || current.status !== 'draft') return { rows: [] }
      if (current.proposed_by !== null && current.proposed_by === approvedBy) {
        throw new ConstraintViolation('statutory_rule_sod_check')
      }
      const updated: StoredRuleRow = { ...current, status: 'active', approved_by: approvedBy }
      if (this.inTx) this.pendingRuleUpdates.push(updated)
      else this.db._updateRule(updated)
      return { rows: [toReturnedRow(updated)] }
    }

    if (/^SELECT[\s\S]*FROM\s+config\.statutory_rule\b/i.test(s)) {
      const visible = this.visibleRules()
      let matches: StoredRuleRow[]
      if (/WHERE id = \$1/i.test(s)) {
        const [id] = params as [string]
        matches = visible.filter((r) => r.id === id)
      } else if (/rule_key LIKE \$1/i.test(s)) {
        const [pattern] = params as [string]
        const prefix = pattern.endsWith('%') ? pattern.slice(0, -1) : pattern
        matches = visible.filter((r) => r.status === 'active' && r.rule_key.startsWith(prefix))
      } else if (/status = 'active' AND rule_key = \$1/i.test(s)) {
        const [ruleKey] = params as [string]
        matches = visible.filter((r) => r.status === 'active' && r.rule_key === ruleKey)
      } else if (/ORDER BY effective_from DESC LIMIT 1/i.test(s)) {
        const [ruleKey] = params as [string]
        matches = visible
          .filter((r) => r.rule_key === ruleKey)
          .sort((a, b) => (a.effective_from < b.effective_from ? 1 : a.effective_from > b.effective_from ? -1 : 0))
          .slice(0, 1)
      } else {
        throw new Error(`FakeConfigDb: unrecognised SELECT: ${s}`)
      }
      return { rows: matches.map(toReturnedRow) }
    }

    if (/^INSERT INTO\s+\S*outbox\b/i.test(s)) {
      const [topic, payloadJson] = params as [string, string]
      const row: StoredOutboxRow = {
        id: randomUUID(),
        topic,
        payload: JSON.parse(payloadJson) as unknown,
        created_at: new Date(),
        published_at: null,
      }
      if (this.inTx) this.pendingOutboxInserts.push(row)
      else this.db._insertOutboxRow(row)
      return { rows: [{ id: row.id }] }
    }

    if (/^INSERT INTO\s+\S*processed_events\b/i.test(s)) {
      const schemaMatch = /INSERT INTO\s+(\S+)\.processed_events/i.exec(s)
      const schema = schemaMatch?.[1] ?? 'config'
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

    throw new Error(`FakeConfigDb: unrecognised query: ${s}`)
  }

  private visibleRules(): StoredRuleRow[] {
    const byId = new Map<string, StoredRuleRow>()
    for (const r of this.db._allRules()) byId.set(r.id, r)
    for (const r of this.pendingRuleInserts) byId.set(r.id, r)
    for (const r of this.pendingRuleUpdates) byId.set(r.id, r)
    return [...byId.values()]
  }

  private insertRule(params: unknown[]): StoredRuleRow {
    const [
      ruleKey,
      valueJson,
      unit,
      floorJson,
      ceilingJson,
      citation,
      effectiveFrom,
      effectiveTo,
      governanceClass,
      status,
      proposedBy,
      approvedBy,
      reason,
    ] = params as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string | null,
      string,
      string,
      string | null,
      string | null,
      string | null,
    ]

    // CHECK (proposed_by IS NULL OR approved_by IS NULL OR proposed_by <> approved_by)
    if (proposedBy !== null && approvedBy !== null && proposedBy === approvedBy) {
      throw new ConstraintViolation('statutory_rule_sod_check')
    }

    const visible = this.visibleRules()
    // UNIQUE (rule_key, effective_from)
    if (visible.some((r) => r.rule_key === ruleKey && r.effective_from === effectiveFrom)) {
      throw new ConstraintViolation('statutory_rule_rule_key_effective_from_key')
    }

    const row: StoredRuleRow = {
      id: randomUUID(),
      rule_key: ruleKey,
      value: valueJson,
      unit,
      statutory_floor: floorJson,
      statutory_ceiling: ceilingJson,
      citation,
      effective_from: effectiveFrom,
      effective_to: effectiveTo,
      governance_class: governanceClass,
      status,
      proposed_by: proposedBy,
      approved_by: approvedBy,
      reason,
      created_at: new Date(),
    }
    if (this.inTx) this.pendingRuleInserts.push(row)
    else this.db._insertRule(row)
    return row
  }
}

void RULE_COLUMNS // documents the returned row shape; not otherwise referenced
