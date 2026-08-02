import { randomUUID } from 'node:crypto'
import type { Queryable } from '@gadong/kernel'

/**
 * A tiny in-memory stand-in for Postgres, scoped to the `docs` schema — the
 * same reason and shape as `services/svc-config/src/testing/fake-db.ts`
 * (Task 7) and `@gadong/kernel`'s `outbox/testing/fake-db.ts` (Task 4):
 * there is no Postgres in this environment (CONSTRAINTS: "no Postgres"), so
 * the repository layer is proven against a fake instead. `migrations/` is
 * the source of truth for the real schema.
 */

export interface StoredDocumentRow {
  id: string
  kind: string
  entity_type: string
  entity_id: string
  lang: string
  file_ref: Buffer
  sha256: string
  created_at: Date
}

interface StoredOutboxRow {
  id: string
  topic: string
  payload: unknown
  created_at: Date
  published_at: Date | null
}

export class FakeDocsDb {
  private readonly documents = new Map<string, StoredDocumentRow>()
  private readonly outbox = new Map<string, StoredOutboxRow>()
  private readonly processedEvents = new Set<string>()

  connect(): FakeDocsConnection {
    return new FakeDocsConnection(this)
  }

  /** A `Queryable` that runs every statement outside a transaction (autocommit) — enough for the repository's read-only methods. */
  asPool(): Queryable {
    const conn = this.connect()
    return { query: (sql: string, params?: unknown[]) => conn.query(sql, params) }
  }

  debugDocuments(): StoredDocumentRow[] {
    return [...this.documents.values()]
  }

  debugOutboxRows(): StoredOutboxRow[] {
    return [...this.outbox.values()]
  }

  // --- internals used only by FakeDocsConnection ---

  _all(): StoredDocumentRow[] {
    return [...this.documents.values()]
  }

  _insert(row: StoredDocumentRow): void {
    this.documents.set(row.id, row)
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

function toReturnedRow(r: StoredDocumentRow): Record<string, unknown> {
  return {
    id: r.id,
    kind: r.kind,
    entity_type: r.entity_type,
    entity_id: r.entity_id,
    lang: r.lang,
    file_ref: r.file_ref,
    sha256: r.sha256,
    created_at: r.created_at,
  }
}

/** One session/connection. Mirrors `svc-config`'s `FakeConfigConnection`: writes made in a transaction are staged locally and only join the committed store on COMMIT. */
export class FakeDocsConnection implements Queryable {
  private inTx = false
  private pendingInserts: StoredDocumentRow[] = []
  private pendingOutboxInserts: StoredOutboxRow[] = []
  private pendingProcessedEvents: Array<{ schema: string; eventId: string }> = []

  constructor(private readonly db: FakeDocsDb) {}

  /** No-op — present so kernel's `withTransaction`/`withConnection` (which call `client.release()`) can drive this fake directly, the same as a real `pg.PoolClient`. */
  release(_err?: Error): void {
    void _err
  }

  async query(sql: string, params: unknown[] = []): Promise<{ rows: Array<Record<string, unknown>> }> {
    const s = sql.trim()

    if (/^BEGIN\b/i.test(s)) {
      this.inTx = true
      this.pendingInserts = []
      this.pendingOutboxInserts = []
      this.pendingProcessedEvents = []
      return { rows: [] }
    }

    if (/^COMMIT\b/i.test(s)) {
      for (const row of this.pendingInserts) this.db._insert(row)
      for (const row of this.pendingOutboxInserts) this.db._insertOutboxRow(row)
      for (const { schema, eventId } of this.pendingProcessedEvents) this.db._insertProcessedEvent(schema, eventId)
      this.inTx = false
      return { rows: [] }
    }

    if (/^ROLLBACK\b/i.test(s)) {
      this.pendingInserts = []
      this.pendingOutboxInserts = []
      this.pendingProcessedEvents = []
      this.inTx = false
      return { rows: [] }
    }

    if (/^INSERT INTO\s+docs\.document\b/i.test(s)) {
      return { rows: [toReturnedRow(this.insertDocument(params))] }
    }

    if (/^SELECT[\s\S]*FROM\s+docs\.document\b/i.test(s)) {
      if (!/WHERE id = \$1/i.test(s)) throw new Error(`FakeDocsDb: unrecognised SELECT: ${s}`)
      const [id] = params as [string]
      const visible = [...this.db._all(), ...this.pendingInserts]
      const match = [...visible].reverse().find((r) => r.id === id)
      return { rows: match ? [toReturnedRow(match)] : [] }
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
      const schema = schemaMatch?.[1] ?? 'docs'
      const [eventId] = params as [string]
      const alreadyCommitted = this.db._processedEventExists(schema, eventId)
      const alreadyPendingHere = this.pendingProcessedEvents.some((p) => p.schema === schema && p.eventId === eventId)
      if (alreadyCommitted || alreadyPendingHere) return { rows: [] }
      if (this.inTx) this.pendingProcessedEvents.push({ schema, eventId })
      else this.db._insertProcessedEvent(schema, eventId)
      return { rows: [{ event_id: eventId }] }
    }

    if (/^SELECT 1\b/i.test(s)) return { rows: [{ '?column?': 1 }] }

    throw new Error(`FakeDocsDb: unrecognised query: ${s}`)
  }

  private insertDocument(params: unknown[]): StoredDocumentRow {
    const [kind, entityType, entityId, lang, fileRef, sha256] = params as [string, string, string, string, Buffer, string]
    const row: StoredDocumentRow = {
      id: randomUUID(),
      kind,
      entity_type: entityType,
      entity_id: entityId,
      lang,
      file_ref: fileRef,
      sha256,
      created_at: new Date(),
    }
    if (this.inTx) this.pendingInserts.push(row)
    else this.db._insert(row)
    return row
  }
}
