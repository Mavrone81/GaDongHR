import type { Queryable } from '@gadong/kernel'

/**
 * A tiny in-memory stand-in for Postgres, scoped to the `audit` schema —
 * same reason and shape as `services/svc-config`'s `testing/fake-db.ts` and
 * `@gadong/kernel`'s `outbox/testing/fake-db.ts`: there is no Postgres in
 * this environment (Task 9 brief CONSTRAINTS), so the repository/consumer
 * layers are proven against a fake instead. `migrations/*.js` is the source
 * of truth for the real schema.
 *
 * Two properties this fake genuinely models (not just stubs):
 *  - `db.connect()` returns an independent session. Rows inserted through
 *    one session are staged locally and only become visible to other
 *    sessions (and to the committed store `debugEntries()` reads) on
 *    COMMIT — proving `EntriesRepository.insert`/`AuditConsumer.consume`
 *    genuinely participate in the caller's transaction rather than opening
 *    one of their own.
 *  - `id` (bigserial) is assigned at INSERT time regardless of whether the
 *    surrounding transaction later commits or rolls back — matching real
 *    Postgres sequence behaviour, where a rolled-back insert still burns a
 *    sequence value. `chain.ts#verifyChain` never depends on `id` being
 *    gapless, so this is safe to model exactly.
 */

export interface StoredEntryRow {
  id: string
  occurred_at: Date
  actor_id: string
  actor_role: string
  action: string
  entity: string
  entity_id: string
  purpose: string | null
  before_hash: string | null
  after_hash: string | null
  prev_entry_hash: string
  entry_hash: string
}

export class FakeAuditDb {
  private readonly committed: StoredEntryRow[] = []
  private nextId = 1
  private readonly processedEvents = new Set<string>() // keyed `${schema}:${eventId}`

  connect(): FakeAuditConnection {
    return new FakeAuditConnection(this)
  }

  /** A `Queryable` that runs every statement outside a transaction (autocommit) — enough for the repository's read-only methods. */
  asPool(): Queryable {
    const conn = this.connect()
    return { query: (sql: string, params?: unknown[]) => conn.query(sql, params) }
  }

  /** Test-only introspection of the committed store — never used by production code. */
  debugEntries(): StoredEntryRow[] {
    return this._allEntriesOrdered()
  }

  /**
   * Test-only: simulates an attacker directly rewriting a row's content
   * despite the migration's GRANT never giving the `audit` role UPDATE —
   * used to prove `/verify` catches what bypassing that grant would allow.
   * Production code has no equivalent method (`EntriesRepository` exposes
   * no `update`), so this exists only here.
   */
  debugOverwrite(id: string, patch: Partial<Omit<StoredEntryRow, 'id'>>): void {
    const idx = this.committed.findIndex((e) => e.id === id)
    if (idx === -1) throw new Error(`FakeAuditDb.debugOverwrite: no committed entry ${id}`)
    const current = this.committed[idx]
    if (current === undefined) throw new Error('unreachable')
    this.committed[idx] = { ...current, ...patch }
  }

  /** Test-only: simulates an attacker deleting a row despite the migration's GRANT never giving the `audit` role DELETE. */
  debugDelete(id: string): void {
    const idx = this.committed.findIndex((e) => e.id === id)
    if (idx === -1) throw new Error(`FakeAuditDb.debugDelete: no committed entry ${id}`)
    this.committed.splice(idx, 1)
  }

  // --- internals used only by FakeAuditConnection ---

  _allEntriesOrdered(): StoredEntryRow[] {
    return [...this.committed].sort((a, b) => Number(a.id) - Number(b.id))
  }

  _reserveInsert(row: Omit<StoredEntryRow, 'id'>): StoredEntryRow {
    return { ...row, id: String(this.nextId++) }
  }

  _commitInsert(row: StoredEntryRow): void {
    this.committed.push(row)
  }

  _processedEventExists(schema: string, eventId: string): boolean {
    return this.processedEvents.has(`${schema}:${eventId}`)
  }

  _insertProcessedEvent(schema: string, eventId: string): void {
    this.processedEvents.add(`${schema}:${eventId}`)
  }
}

function toReturnedRow(r: StoredEntryRow): Record<string, unknown> {
  return {
    id: r.id,
    occurred_at: r.occurred_at,
    actor_id: r.actor_id,
    actor_role: r.actor_role,
    action: r.action,
    entity: r.entity,
    entity_id: r.entity_id,
    purpose: r.purpose,
    before_hash: r.before_hash,
    after_hash: r.after_hash,
    prev_entry_hash: r.prev_entry_hash,
    entry_hash: r.entry_hash,
  }
}

/** One session/connection. Mirrors kernel's `FakeConnection`/svc-config's `FakeConfigConnection`: writes made in a transaction are staged locally and only join the committed store on COMMIT. */
export class FakeAuditConnection implements Queryable {
  private inTx = false
  private pendingInserts: StoredEntryRow[] = []
  private pendingProcessedEvents: Array<{ schema: string; eventId: string }> = []

  constructor(private readonly db: FakeAuditDb) {}

  /** No-op — present so kernel's `withTransaction`/`withConnection` (which call `client.release()`) can drive this fake directly, the same as a real `pg.PoolClient`. */
  release(_err?: Error): void {
    void _err
  }

  async query(sql: string, params: unknown[] = []): Promise<{ rows: Array<Record<string, unknown>> }> {
    const s = sql.trim()

    if (/^BEGIN\b/i.test(s)) {
      this.inTx = true
      this.pendingInserts = []
      this.pendingProcessedEvents = []
      return { rows: [] }
    }

    if (/^COMMIT\b/i.test(s)) {
      for (const row of this.pendingInserts) this.db._commitInsert(row)
      for (const { schema, eventId } of this.pendingProcessedEvents) this.db._insertProcessedEvent(schema, eventId)
      this.inTx = false
      return { rows: [] }
    }

    if (/^ROLLBACK\b/i.test(s)) {
      // Sequence values already handed out by `_reserveInsert` are NOT
      // returned — matching real Postgres (a rolled-back INSERT still burns
      // its `bigserial` value). Only the rows/processed_events themselves
      // are discarded.
      this.pendingInserts = []
      this.pendingProcessedEvents = []
      this.inTx = false
      return { rows: [] }
    }

    if (/^INSERT INTO\s+audit\.entry\b/i.test(s)) {
      return { rows: [toReturnedRow(this.insertEntry(params))] }
    }

    if (/^SELECT[\s\S]*FROM\s+audit\.entry\b[\s\S]*ORDER BY id DESC LIMIT 1 FOR UPDATE/i.test(s)) {
      const all = this.visibleEntries()
      const latest = all.length > 0 ? all[all.length - 1] : undefined
      return { rows: latest !== undefined ? [toReturnedRow(latest)] : [] }
    }

    if (/^SELECT[\s\S]*FROM\s+audit\.entry\b[\s\S]*LIMIT \$\d+ OFFSET \$\d+/i.test(s)) {
      return { rows: this.selectPage(s, params).map(toReturnedRow) }
    }

    if (/^SELECT[\s\S]*FROM\s+audit\.entry\b\s*ORDER BY id ASC\s*$/i.test(s)) {
      return { rows: this.visibleEntries().map(toReturnedRow) }
    }

    if (/^INSERT INTO\s+audit\.processed_events\b/i.test(s)) {
      const [eventId] = params as [string]
      const schema = 'audit'
      const alreadyCommitted = this.db._processedEventExists(schema, eventId)
      const alreadyPendingHere = this.pendingProcessedEvents.some((p) => p.schema === schema && p.eventId === eventId)
      if (alreadyCommitted || alreadyPendingHere) return { rows: [] } // ON CONFLICT DO NOTHING RETURNING event_id -> no rows

      if (this.inTx) this.pendingProcessedEvents.push({ schema, eventId })
      else this.db._insertProcessedEvent(schema, eventId)
      return { rows: [{ event_id: eventId }] }
    }

    throw new Error(`FakeAuditDb: unrecognised query: ${s}`)
  }

  private visibleEntries(): StoredEntryRow[] {
    return [...this.db._allEntriesOrdered(), ...this.pendingInserts].sort((a, b) => Number(a.id) - Number(b.id))
  }

  private insertEntry(params: unknown[]): StoredEntryRow {
    const [occurredAt, actorId, actorRole, action, entity, entityId, purpose, beforeHash, afterHash, prevEntryHash, entryHash] =
      params as [string, string, string, string, string, string, string | null, string | null, string | null, string, string]

    const row = this.db._reserveInsert({
      occurred_at: new Date(occurredAt),
      actor_id: actorId,
      actor_role: actorRole,
      action,
      entity,
      entity_id: entityId,
      purpose,
      before_hash: beforeHash,
      after_hash: afterHash,
      prev_entry_hash: prevEntryHash,
      entry_hash: entryHash,
    })
    if (this.inTx) this.pendingInserts.push(row)
    else this.db._commitInsert(row)
    return row
  }

  /**
   * Recovers which optional filters `EntriesRepository.findPage` built into
   * the WHERE clause, and their bound param positions, directly from the
   * SQL text — the fake has no real SQL planner, so it must parse enough of
   * the query to know which of `entity`/`entity_id`/`occurred_at >=`/
   * `occurred_at <=` are present, matching the same generated shape the
   * repository always produces (conditions in that fixed order, `LIMIT`
   * then `OFFSET` always the last two params).
   */
  private selectPage(sql: string, params: unknown[]): StoredEntryRow[] {
    let rows = this.visibleEntries()

    const entityMatch = /\bentity\s*=\s*\$(\d+)/.exec(sql)
    if (entityMatch?.[1] !== undefined) {
      const value = params[Number(entityMatch[1]) - 1] as string
      rows = rows.filter((r) => r.entity === value)
    }

    const entityIdMatch = /\bentity_id\s*=\s*\$(\d+)/.exec(sql)
    if (entityIdMatch?.[1] !== undefined) {
      const value = params[Number(entityIdMatch[1]) - 1] as string
      rows = rows.filter((r) => r.entity_id === value)
    }

    const fromMatch = /\boccurred_at\s*>=\s*\$(\d+)/.exec(sql)
    if (fromMatch?.[1] !== undefined) {
      const value = params[Number(fromMatch[1]) - 1] as string
      rows = rows.filter((r) => r.occurred_at.toISOString() >= value)
    }

    const toMatch = /\boccurred_at\s*<=\s*\$(\d+)/.exec(sql)
    if (toMatch?.[1] !== undefined) {
      const value = params[Number(toMatch[1]) - 1] as string
      rows = rows.filter((r) => r.occurred_at.toISOString() <= value)
    }

    const limitOffsetMatch = /LIMIT \$(\d+) OFFSET \$(\d+)/.exec(sql)
    if (!limitOffsetMatch) throw new Error(`FakeAuditDb.selectPage: could not find LIMIT/OFFSET in: ${sql}`)
    const limitIdx = limitOffsetMatch[1]
    const offsetIdx = limitOffsetMatch[2]
    if (limitIdx === undefined || offsetIdx === undefined) throw new Error('unreachable')
    const limit = params[Number(limitIdx) - 1] as number
    const offset = params[Number(offsetIdx) - 1] as number

    return rows.slice(offset, offset + limit)
  }
}
