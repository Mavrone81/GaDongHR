import { randomUUID } from 'node:crypto'
import type { Queryable } from '../outbox'

/**
 * A tiny in-memory stand-in for Postgres, used only by outbox/relay/consumer
 * tests. There is no Postgres in this test environment (and none should be
 * added — see the Task 4 brief); `Queryable` exists precisely so these units
 * can be exercised against a fake instead.
 *
 * It models just enough real Postgres behaviour for the properties under
 * test to be provable, not merely assertable:
 *  - `db.connect()` returns an independent session (like `pg.Pool#connect`).
 *    Writes made through one session are staged locally and only become
 *    visible to other sessions on COMMIT — the mechanism the tests use to
 *    prove `writeOutbox` and `idempotent` genuinely participate in the
 *    caller's transaction rather than opening a connection of their own.
 *  - `SELECT ... FOR UPDATE SKIP LOCKED` takes a real, cross-session lock at
 *    SELECT time, held until that session's COMMIT/ROLLBACK — so a second
 *    session's concurrent SELECT genuinely skips the row, the same as it
 *    would against real Postgres.
 *  - `INSERT ... ON CONFLICT DO NOTHING` checks only the committed table,
 *    matching Postgres's read-committed default.
 */

interface StoredOutboxRow {
  id: string
  topic: string
  payload: unknown
  createdAt: Date
  publishedAt: Date | null
  seq: number
}

export class FakeDb {
  private readonly outbox = new Map<string, StoredOutboxRow>()
  private readonly processedEvents = new Set<string>() // keyed `${schema}:${eventId}`
  private readonly lockedRowIds = new Set<string>()
  private seq = 0

  connect(): FakeConnection {
    return new FakeConnection(this)
  }

  /** Test-only introspection of the committed store — never used by production code. */
  debugOutboxRows(): StoredOutboxRow[] {
    return [...this.outbox.values()].sort((a, b) => a.seq - b.seq)
  }

  // --- internals used only by FakeConnection ---

  _nextSeq(): number {
    return this.seq++
  }

  _insertOutboxRow(row: StoredOutboxRow): void {
    this.outbox.set(row.id, row)
  }

  _selectForUpdateSkipLocked(limit: number): StoredOutboxRow[] {
    const candidates = [...this.outbox.values()]
      .filter((r) => r.publishedAt === null && !this.lockedRowIds.has(r.id))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.seq - b.seq)
      .slice(0, limit)
    for (const row of candidates) this.lockedRowIds.add(row.id)
    return candidates
  }

  _releaseLocks(ids: Iterable<string>): void {
    for (const id of ids) this.lockedRowIds.delete(id)
  }

  _markPublished(id: string): void {
    const row = this.outbox.get(id)
    if (row) row.publishedAt = new Date()
  }

  _processedEventExists(schema: string, eventId: string): boolean {
    return this.processedEvents.has(`${schema}:${eventId}`)
  }

  _insertProcessedEvent(schema: string, eventId: string): void {
    this.processedEvents.add(`${schema}:${eventId}`)
  }

  /** Atomic check-and-insert for the non-transactional (autocommit) path. */
  _tryInsertProcessedEvent(schema: string, eventId: string): boolean {
    if (this._processedEventExists(schema, eventId)) return false
    this._insertProcessedEvent(schema, eventId)
    return true
  }
}

/** One session/connection obtained from a `FakeDb`. See class doc above. */
export class FakeConnection implements Queryable {
  private inTx = false
  private pendingOutboxInserts: StoredOutboxRow[] = []
  private pendingPublished: string[] = []
  private pendingProcessedEvents: Array<{ schema: string; eventId: string }> = []
  private readonly heldLocks = new Set<string>()

  constructor(private readonly db: FakeDb) {}

  async query(sql: string, params: unknown[] = []): Promise<{ rows: Array<Record<string, unknown>> }> {
    const s = sql.trim()

    if (/^BEGIN\b/i.test(s)) {
      this.inTx = true
      this.pendingOutboxInserts = []
      this.pendingPublished = []
      this.pendingProcessedEvents = []
      return { rows: [] }
    }

    if (/^COMMIT\b/i.test(s)) {
      for (const row of this.pendingOutboxInserts) this.db._insertOutboxRow(row)
      for (const id of this.pendingPublished) this.db._markPublished(id)
      for (const { schema, eventId } of this.pendingProcessedEvents) this.db._insertProcessedEvent(schema, eventId)
      this.db._releaseLocks(this.heldLocks)
      this.heldLocks.clear()
      this.inTx = false
      return { rows: [] }
    }

    if (/^ROLLBACK\b/i.test(s)) {
      this.pendingOutboxInserts = []
      this.pendingPublished = []
      this.pendingProcessedEvents = []
      this.db._releaseLocks(this.heldLocks)
      this.heldLocks.clear()
      this.inTx = false
      return { rows: [] }
    }

    if (/^INSERT INTO\s+\S*outbox\b/i.test(s)) {
      const [topic, payloadJson] = params as [string, string]
      const row: StoredOutboxRow = {
        id: randomUUID(),
        topic,
        payload: JSON.parse(payloadJson),
        createdAt: new Date(),
        publishedAt: null,
        seq: this.db._nextSeq(),
      }
      if (this.inTx) this.pendingOutboxInserts.push(row)
      else this.db._insertOutboxRow(row)
      return { rows: [{ id: row.id }] }
    }

    if (/^SELECT[\s\S]*FROM\s+\S*outbox\b[\s\S]*published_at IS NULL[\s\S]*FOR UPDATE SKIP LOCKED/i.test(s)) {
      const [limit] = params as [number]
      const rows = this.db._selectForUpdateSkipLocked(limit)
      for (const row of rows) this.heldLocks.add(row.id)
      return {
        rows: rows.map((r) => ({
          id: r.id,
          topic: r.topic,
          payload: r.payload,
          created_at: r.createdAt,
          published_at: r.publishedAt,
        })),
      }
    }

    if (/^UPDATE\s+\S*outbox\s+SET published_at/i.test(s)) {
      const [id] = params as [string]
      if (this.inTx) this.pendingPublished.push(id)
      else this.db._markPublished(id)
      return { rows: [] }
    }

    if (/^INSERT INTO\s+\S*processed_events\b/i.test(s)) {
      // schema is baked into the SQL text (`${schema}.processed_events`), not a bind
      // param — recover it the same way real SQL would resolve the qualified name.
      const schemaMatch = /INSERT INTO\s+(\S+)\.processed_events/i.exec(s)
      const schema = schemaMatch?.[1] ?? 'public'
      const [eventId] = params as [string]
      const alreadyCommitted = this.db._processedEventExists(schema, eventId)
      const alreadyPendingHere = this.pendingProcessedEvents.some((p) => p.schema === schema && p.eventId === eventId)
      const duplicate = alreadyCommitted || alreadyPendingHere
      if (duplicate) return { rows: [] } // ON CONFLICT DO NOTHING RETURNING event_id -> no rows

      if (this.inTx) this.pendingProcessedEvents.push({ schema, eventId })
      else this.db._insertProcessedEvent(schema, eventId)
      return { rows: [{ event_id: eventId }] }
    }

    throw new Error(`FakeDb: unrecognised query: ${s}`)
  }
}
