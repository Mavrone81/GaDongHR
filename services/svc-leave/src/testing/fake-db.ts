import { randomUUID } from 'node:crypto'
import type { Queryable } from '@gadong/kernel'

/**
 * A small in-memory stand-in for Postgres, scoped to the `leave` schema —
 * same reason as `services/svc-config/src/testing/fake-db.ts`: no Postgres
 * in this environment (Task brief CONSTRAINTS). Unlike that fake (one
 * table, hand-written per-query branches), this one is a small GENERIC
 * engine: every repository in this service writes SQL in one of four fixed
 * shapes —
 *
 *   INSERT INTO leave.<table> (c1, c2, ...) VALUES ($1, $2, ...) RETURNING *
 *   UPDATE leave.<table> SET c1 = $2, c2 = $3 WHERE id = $1 RETURNING *
 *   SELECT * FROM leave.<table> WHERE c1 = $1 [AND c2 = $2 ...] [ORDER BY c] [LIMIT n]
 *   SELECT * FROM leave.<table> [ORDER BY c] [LIMIT n]   (no WHERE)
 *
 * — and this file parses exactly those four shapes generically, rather than
 * hand-rolling a per-table branch the way `FakeConfigDb` did for its single
 * table. Multi-row overlap/range logic (e.g. "does this date range overlap
 * an existing request") is DELIBERATELY NOT expressed in SQL at all: the
 * repositories that need it (`requests.repository.ts`) fetch by a plain
 * equality WHERE and let the service layer filter in TypeScript, so this
 * fake never needs a `daterange &&` operator or an `= ANY($n)` array
 * parameter — see `requests.repository.ts`'s own comment for why that's a
 * deliberate simplification, not a missed case.
 *
 * `writeOutbox`/`idempotent` (kernel) issue their own fixed SQL text
 * directly against `<schema>.outbox`/`<schema>.processed_events` — those two
 * shapes are matched explicitly, ahead of the generic dispatch, mirroring
 * `FakeConfigDb`'s precedent exactly (this fake does not own that SQL text;
 * kernel does).
 *
 * Transactions: `BEGIN`/`COMMIT`/`ROLLBACK` stage writes on the connection
 * and only join the shared committed store on COMMIT — the same shape
 * kernel's real `withTransaction` (a real `pg.PoolClient`) has, so a
 * transaction spanning a state change AND its outbox row commits or rolls
 * back together here too.
 */

export type Row = Record<string, unknown>

interface PendingWrite {
  table: string
  row: Row
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
    super(`FakeLeaveDb: violates constraint "${constraint}"`)
  }
}

/** Registered so `insert` can apply a `UNIQUE` check without a real Postgres constraint behind it — the property this fake exists to approximate, per-table. Keyed by table name; each entry is the list of column-sets that must be unique together. */
const UNIQUE_CONSTRAINTS: Record<string, string[][]> = {
  leave_type: [['code']],
  leave_balance: [['employee_id', 'leave_type_id', 'year']],
  approval_level: [['leave_type_id', 'level']],
}

/** Every table in this schema keys on a generated `id` EXCEPT `leave_employee_ref`, whose real (and only) primary key is `employee_id` — see the parent migration's file header. This map lets `INSERT`/`UPDATE` generalise to whichever column is actually the key, rather than assuming `id` everywhere. */
const PRIMARY_KEY_COLUMN: Record<string, string> = {
  leave_employee_ref: 'employee_id',
}

function primaryKeyColumn(table: string): string {
  return PRIMARY_KEY_COLUMN[table] ?? 'id'
}

export class FakeLeaveDb {
  private readonly tables = new Map<string, Map<string, Row>>()
  private readonly outbox = new Map<string, StoredOutboxRow>()
  private readonly processedEvents = new Set<string>()

  connect(): FakeLeaveConnection {
    return new FakeLeaveConnection(this)
  }

  /** A `Queryable` that runs every statement outside a transaction (autocommit) — enough for read-only repository methods. */
  asPool(): Queryable {
    const conn = this.connect()
    return { query: (sql: string, params?: unknown[]) => conn.query(sql, params) }
  }

  /** Top-level autocommit `query`, alongside `connect()` — together these two methods are the exact `pg.Pool` surface kernel's `withTransaction`/controller-level health checks need, so a `FakeLeaveDb` can stand in directly for `Pool` in controller-level tests (cast `as unknown as Pool`). */
  query(sql: string, params?: unknown[]): Promise<{ rows: Row[] }> {
    return this.asPool().query(sql, params)
  }

  debugTable(name: string): Row[] {
    return [...(this.tables.get(name)?.values() ?? [])]
  }

  debugOutboxRows(): StoredOutboxRow[] {
    return [...this.outbox.values()]
  }

  // --- internals used only by FakeLeaveConnection ---

  _table(name: string): Map<string, Row> {
    let t = this.tables.get(name)
    if (!t) {
      t = new Map()
      this.tables.set(name, t)
    }
    return t
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

function stripCast(expr: string): string {
  return expr.replace(/::[\w"[\].]+$/, '').trim()
}

/** One session/connection. Writes made inside `BEGIN`/`COMMIT` are staged locally (per table) and only join the shared committed store on `COMMIT` — see class doc above. */
export class FakeLeaveConnection implements Queryable {
  private inTx = false
  private pendingWrites: PendingWrite[] = []
  private pendingOutbox: StoredOutboxRow[] = []
  private pendingProcessedEvents: Array<{ schema: string; eventId: string }> = []

  constructor(private readonly db: FakeLeaveDb) {}

  /** No-op — present so kernel's `withTransaction` (which calls `client.release()`) can drive this fake directly, the same as a real `pg.PoolClient`. */
  release(_err?: Error): void {
    void _err
  }

  async query(sql: string, params: unknown[] = []): Promise<{ rows: Row[] }> {
    const s = sql.trim()

    // Every service's health check issues a bare `SELECT 1` against the
    // pool directly (not through any repository) — matched here so a
    // `FakeLeaveDb` can stand in for `Pool` in controller-level tests.
    if (/^SELECT 1$/i.test(s)) {
      return { rows: [{ '?column?': 1 }] }
    }

    if (/^BEGIN\b/i.test(s)) {
      this.inTx = true
      this.pendingWrites = []
      this.pendingOutbox = []
      this.pendingProcessedEvents = []
      return { rows: [] }
    }

    if (/^COMMIT\b/i.test(s)) {
      for (const { table, row } of this.pendingWrites) {
        this.db._table(table).set(String(row['id']), row)
      }
      for (const row of this.pendingOutbox) this.db._insertOutboxRow(row)
      for (const { schema, eventId } of this.pendingProcessedEvents) this.db._insertProcessedEvent(schema, eventId)
      this.inTx = false
      return { rows: [] }
    }

    if (/^ROLLBACK\b/i.test(s)) {
      this.pendingWrites = []
      this.pendingOutbox = []
      this.pendingProcessedEvents = []
      this.inTx = false
      return { rows: [] }
    }

    // kernel `writeOutbox` — fixed SQL text this fake doesn't own, matching FakeConfigDb's precedent.
    if (/^INSERT INTO\s+\S*outbox\b/i.test(s)) {
      const [topic, payloadJson] = params as [string, string]
      const row: StoredOutboxRow = {
        id: randomUUID(),
        topic,
        payload: JSON.parse(payloadJson) as unknown,
        created_at: new Date(),
        published_at: null,
      }
      if (this.inTx) this.pendingOutbox.push(row)
      else this.db._insertOutboxRow(row)
      return { rows: [{ id: row.id }] }
    }

    // kernel `idempotent` — fixed SQL text this fake doesn't own.
    if (/^INSERT INTO\s+\S*processed_events\b/i.test(s)) {
      const schemaMatch = /INSERT INTO\s+(\S+)\.processed_events/i.exec(s)
      const schema = schemaMatch?.[1] ?? 'leave'
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

    const insertMatch = /^INSERT INTO\s+leave\.(\w+)\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/i.exec(s)
    if (insertMatch) {
      return { rows: [this.handleInsert(insertMatch, params)] }
    }

    const updateMatch = /^UPDATE\s+leave\.(\w+)\s+SET\s+([\s\S]*?)\s+WHERE\s+(\w+)\s*=\s*\$1\b/i.exec(s)
    if (updateMatch) {
      const result = this.handleUpdate(updateMatch, params)
      return { rows: result ? [result] : [] }
    }

    const selectMatch = /^SELECT\s+\*\s+FROM\s+leave\.(\w+)\b([\s\S]*)$/i.exec(s)
    if (selectMatch) {
      return { rows: this.handleSelect(selectMatch, params) }
    }

    throw new Error(`FakeLeaveDb: unrecognised query: ${s}`)
  }

  private visible(table: string): Row[] {
    const pk = primaryKeyColumn(table)
    const byId = new Map<string, Row>()
    for (const row of this.db._table(table).values()) byId.set(String(row[pk]), row)
    for (const { table: t, row } of this.pendingWrites) {
      if (t === table) byId.set(String(row[pk]), row)
    }
    return [...byId.values()]
  }

  private checkUnique(table: string, row: Row, excludeId?: string): void {
    const pk = primaryKeyColumn(table)
    const constraints = UNIQUE_CONSTRAINTS[table] ?? []
    for (const cols of constraints) {
      const clash = this.visible(table).some(
        (existing) =>
          String(existing[pk]) !== excludeId && cols.every((c) => existing[c] === row[c]),
      )
      if (clash) throw new ConstraintViolation(`${table}_${cols.join('_')}_key`)
    }
  }

  private handleInsert(match: RegExpExecArray, params: unknown[]): Row {
    const table = match[1]
    const colsRaw = match[2] ?? ''
    const valsRaw = match[3] ?? ''
    if (table === undefined) throw new Error('FakeLeaveDb: insert missing table name')
    const pk = primaryKeyColumn(table)
    const cols = colsRaw.split(',').map((c) => c.trim())
    const vals = valsRaw.split(',').map((v) => v.trim())
    const row: Row = {}
    cols.forEach((col, i) => {
      const raw = vals[i]
      if (raw === undefined) throw new Error(`FakeLeaveDb: insert column "${col}" has no matching value expression`)
      const stripped = stripCast(raw)
      const idxMatch = /^\$(\d+)$/.exec(stripped)
      if (!idxMatch || idxMatch[1] === undefined) {
        throw new Error(`FakeLeaveDb: unsupported value expression "${raw}" for column "${col}" (only bare $n placeholders are supported)`)
      }
      const paramIdx = Number(idxMatch[1]) - 1
      let value: unknown = params[paramIdx]
      if (/::jsonb$/.test(raw) && typeof value === 'string') value = JSON.parse(value)
      row[col] = value ?? null
    })
    // Only the `id`-keyed tables get a generated key when omitted —
    // `leave_employee_ref` (keyed on `employee_id`) always supplies its key
    // explicitly (it comes from the `employee.*` event), so there is
    // nothing to generate for it.
    if (pk === 'id' && (row['id'] === undefined || row['id'] === null)) row['id'] = randomUUID()
    this.checkUnique(table, row)
    if (this.inTx) this.pendingWrites.push({ table, row })
    else this.db._table(table).set(String(row[pk]), row)
    return row
  }

  private handleUpdate(match: RegExpExecArray, params: unknown[]): Row | null {
    const table = match[1]
    const setClause = match[2] ?? ''
    const whereCol = match[3]
    if (table === undefined) throw new Error('FakeLeaveDb: update missing table name')
    if (whereCol === undefined) throw new Error('FakeLeaveDb: update missing WHERE column')
    const id = params[0]
    const current = this.visible(table).find((r) => r[whereCol] === id)
    if (!current) return null

    const assignments = setClause.split(',').map((a) => a.trim())
    const patch: Row = {}
    for (const assignment of assignments) {
      const eqIdx = assignment.indexOf('=')
      if (eqIdx === -1) throw new Error(`FakeLeaveDb: unparseable SET assignment "${assignment}"`)
      const col = assignment.slice(0, eqIdx).trim()
      const rawVal = assignment.slice(eqIdx + 1).trim()
      const stripped = stripCast(rawVal)
      const idxMatch = /^\$(\d+)$/.exec(stripped)
      if (!idxMatch || idxMatch[1] === undefined) {
        throw new Error(`FakeLeaveDb: unsupported SET value expression "${rawVal}" for column "${col}"`)
      }
      const paramIdx = Number(idxMatch[1]) - 1
      let value: unknown = params[paramIdx]
      if (/::jsonb$/.test(rawVal) && typeof value === 'string') value = JSON.parse(value)
      patch[col] = value ?? null
    }

    const updated: Row = { ...current, ...patch }
    const pk = primaryKeyColumn(table)
    this.checkUnique(table, updated, String(current[pk]))
    if (this.inTx) this.pendingWrites.push({ table, row: updated })
    else this.db._table(table).set(String(updated[pk]), updated)
    return updated
  }

  private handleSelect(match: RegExpExecArray, params: unknown[]): Row[] {
    const table = match[1]
    const rest = match[2] ?? ''
    if (table === undefined) throw new Error('FakeLeaveDb: select missing table name')
    let rows = this.visible(table)

    const whereMatch = /^\s*WHERE\s+([\s\S]*?)(?:\s+ORDER BY|\s+LIMIT|\s*$)/i.exec(rest)
    if (whereMatch?.[1] !== undefined) {
      const conditions = whereMatch[1].split(/\s+AND\s+/i).map((c) => c.trim())
      for (const condition of conditions) {
        const condMatch = /^(\w+)\s*=\s*\$(\d+)$/.exec(condition)
        if (!condMatch || condMatch[1] === undefined || condMatch[2] === undefined) {
          throw new Error(`FakeLeaveDb: unsupported WHERE condition "${condition}" (only "col = $n" equalities are supported)`)
        }
        const col = condMatch[1]
        const paramIdx = Number(condMatch[2]) - 1
        const value = params[paramIdx]
        rows = rows.filter((r) => r[col] === value)
      }
    }

    const orderMatch = /ORDER BY\s+(\w+)(\s+DESC)?/i.exec(rest)
    if (orderMatch?.[1] !== undefined) {
      const col = orderMatch[1]
      const desc = orderMatch[2] !== undefined
      rows = [...rows].sort((a, b) => {
        const av = a[col]
        const bv = b[col]
        const cmp = av === bv ? 0 : (av as string | number) < (bv as string | number) ? -1 : 1
        return desc ? -cmp : cmp
      })
    }

    const limitMatch = /LIMIT\s+(\d+)/i.exec(rest)
    if (limitMatch?.[1] !== undefined) {
      rows = rows.slice(0, Number(limitMatch[1]))
    }

    return rows
  }
}
