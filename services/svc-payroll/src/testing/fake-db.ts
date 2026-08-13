import { randomUUID } from 'node:crypto'
import type { Queryable } from '@gadong/kernel'

/**
 * A small in-memory stand-in for Postgres, scoped to the `payroll` schema.
 * There is no Postgres in this environment, so this fake is what every
 * repository- and service-level test in this module runs against —
 * the same generic four-shape SQL engine
 * `services/svc-leave/src/testing/fake-db.ts` established:
 *
 *   INSERT INTO payroll.<table> (c1, c2, ...) VALUES ($1, $2, ...) RETURNING *
 *   UPDATE payroll.<table> SET c1 = $2, ... WHERE <key> = $1 RETURNING *
 *   SELECT * FROM payroll.<table> WHERE c1 = $1 [AND c2 = $2 ...] [ORDER BY c]
 *   SELECT * FROM payroll.<table> [ORDER BY c]
 *
 * `writeOutbox`/`idempotent` (kernel) issue their own fixed SQL text against
 * `<schema>.outbox`/`<schema>.processed_events`; those two shapes are matched
 * explicitly ahead of the generic dispatch, because this fake does not own
 * that SQL — kernel does.
 *
 * WHAT THIS FAKE ADDS BEYOND ITS `svc-leave` ANCESTOR, AND WHY IT MATTERS
 * HERE MORE THAN ANYWHERE ELSE IN THE CODEBASE: it emulates the two
 * database-level LEGAL CONTROLS the payroll migrations install.
 *
 *  1. COMMITTED-RUN IMMUTABILITY. `payroll_run_immutable_when_committed`,
 *     `payslip_immutable_when_run_committed`,
 *     `statutory_export_immutable_when_run_committed` and
 *     `pay_item_immutable_when_run_committed` are mirrored in
 *     `assertNotFrozen` below, INCLUDING the difference in which operations
 *     each one fires on (payslip's trigger is UPDATE/DELETE only; the
 *     statutory_export and pay_item triggers also fire on INSERT). Without
 *     this, a test asserting "a committed run cannot be edited" would only
 *     be testing the service-layer check and would pass just as happily
 *     against a database with no triggers at all.
 *  2. SEGREGATION OF DUTIES. `payroll_run_sod_check` is mirrored in
 *     `assertSod`, so `runs.service.test.ts` can delete the SERVICE-layer
 *     check and observe the DATABASE still refusing — which is the whole
 *     point of having two layers, and the demonstration the brief asks for.
 *
 * Both mirrors raise `ConstraintViolation`, carrying the real constraint or
 * trigger name so a test asserts against the same identifier the migration
 * declares.
 *
 * Transactions: `BEGIN`/`COMMIT`/`ROLLBACK` stage writes on the connection
 * and only join the shared committed store on COMMIT — the same shape
 * kernel's real `withTransaction` has, so a transaction spanning a state
 * change AND its outbox row commits or rolls back together here too.
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
    super(`FakePayrollDb: violates constraint "${constraint}"`)
  }
}

/** Registered so `insert` can apply a `UNIQUE` check without a real Postgres constraint behind it — the property this fake exists to approximate, per-table. Keyed by table name; each entry is the list of column-sets that must be unique together. */
const UNIQUE_CONSTRAINTS: Record<string, string[][]> = {
  pay_profile: [['employee_id']],
  // One payslip per employee per run — without it a half-failed
  // recalculation leaves two, and the bank file pays both.
  payslip: [['run_id', 'employee_id']],
  // A redelivered `claim.approved_for_payroll` cannot queue a second
  // reimbursement for the same claim.
  pay_input: [['source', 'source_ref']],
}

/** Three tables in this schema key on something other than a generated `id` — the read models and the termination record. This map lets `INSERT`/`UPDATE` generalise to whichever column is actually the key. */
const PRIMARY_KEY_COLUMN: Record<string, string> = {
  payroll_employee_ref: 'employee_id',
  timesheet_lock: 'period',
  termination: 'employee_id',
}

function primaryKeyColumn(table: string): string {
  return PRIMARY_KEY_COLUMN[table] ?? 'id'
}

export class FakePayrollDb {
  private readonly tables = new Map<string, Map<string, Row>>()
  private readonly outbox = new Map<string, StoredOutboxRow>()
  private readonly processedEvents = new Set<string>()

  connect(): FakePayrollConnection {
    return new FakePayrollConnection(this)
  }

  /** A `Queryable` that runs every statement outside a transaction (autocommit) — enough for read-only repository methods. */
  asPool(): Queryable {
    const conn = this.connect()
    return { query: (sql: string, params?: unknown[]) => conn.query(sql, params) }
  }

  /** Top-level autocommit `query`, alongside `connect()` — together these two methods are the exact `pg.Pool` surface kernel's `withTransaction`/controller-level health checks need, so a `FakePayrollDb` can stand in directly for `Pool` in controller-level tests (cast `as unknown as Pool`). */
  query(sql: string, params?: unknown[]): Promise<{ rows: Row[] }> {
    return this.asPool().query(sql, params)
  }

  debugTable(name: string): Row[] {
    return [...(this.tables.get(name)?.values() ?? [])]
  }

  debugOutboxRows(): StoredOutboxRow[] {
    return [...this.outbox.values()]
  }

  // --- internals used only by FakePayrollConnection ---

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
export class FakePayrollConnection implements Queryable {
  private inTx = false
  private pendingWrites: PendingWrite[] = []
  private pendingOutbox: StoredOutboxRow[] = []
  private pendingProcessedEvents: Array<{ schema: string; eventId: string }> = []
  private pendingDeletes: Array<{ table: string; key: string }> = []

  constructor(private readonly db: FakePayrollDb) {}

  /** No-op — present so kernel's `withTransaction` (which calls `client.release()`) can drive this fake directly, the same as a real `pg.PoolClient`. */
  release(_err?: Error): void {
    void _err
  }

  async query(sql: string, params: unknown[] = []): Promise<{ rows: Row[] }> {
    const s = sql.trim()

    // Every service's health check issues a bare `SELECT 1` against the
    // pool directly (not through any repository) — matched here so a
    // `FakePayrollDb` can stand in for `Pool` in controller-level tests.
    if (/^SELECT 1$/i.test(s)) {
      return { rows: [{ '?column?': 1 }] }
    }

    if (/^BEGIN\b/i.test(s)) {
      this.inTx = true
      this.pendingWrites = []
      this.pendingOutbox = []
      this.pendingProcessedEvents = []
      this.pendingDeletes = []
      return { rows: [] }
    }

    if (/^COMMIT\b/i.test(s)) {
      for (const { table, row } of this.pendingWrites) {
        // Keyed by the table's REAL primary key, not always `id` — the
        // read models key on `employee_id`/`period`.
        this.db._table(table).set(String(row[primaryKeyColumn(table)]), row)
      }
      for (const { table, key } of this.pendingDeletes) this.db._table(table).delete(key)
      for (const row of this.pendingOutbox) this.db._insertOutboxRow(row)
      for (const { schema, eventId } of this.pendingProcessedEvents) this.db._insertProcessedEvent(schema, eventId)
      this.inTx = false
      this.pendingDeletes = []
      return { rows: [] }
    }

    if (/^ROLLBACK\b/i.test(s)) {
      this.pendingWrites = []
      this.pendingOutbox = []
      this.pendingProcessedEvents = []
      this.pendingDeletes = []
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

    // kernel `outboxDepth` (event-bus health/metrics) — fixed SQL text this fake doesn't own, same precedent as the two blocks above.
    if (/^SELECT\s+count\(\*\)/i.test(s) && /FROM\s+\S*outbox\b/i.test(s)) {
      const pending = [...this.db.debugOutboxRows()].filter((r) => r.published_at === null)
      const oldestAgeSeconds =
        pending.length === 0 ? null : Math.max(0, (Date.now() - Math.min(...pending.map((r) => r.created_at.getTime()))) / 1000)
      return { rows: [{ pending: pending.length, oldest_age_seconds: oldestAgeSeconds }] }
    }

    // kernel `idempotent` — fixed SQL text this fake doesn't own.
    if (/^INSERT INTO\s+\S*processed_events\b/i.test(s)) {
      const schemaMatch = /INSERT INTO\s+(\S+)\.processed_events/i.exec(s)
      const schema = schemaMatch?.[1] ?? 'payroll'
      const [eventId] = params as [string]
      const alreadyCommitted = this.db._processedEventExists(schema, eventId)
      const alreadyPendingHere = this.pendingProcessedEvents.some((p) => p.schema === schema && p.eventId === eventId)
      if (alreadyCommitted || alreadyPendingHere) return { rows: [] }
      if (this.inTx) this.pendingProcessedEvents.push({ schema, eventId })
      else this.db._insertProcessedEvent(schema, eventId)
      return { rows: [{ event_id: eventId }] }
    }

    const insertMatch = /^INSERT INTO\s+payroll\.(\w+)\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/i.exec(s)
    if (insertMatch) {
      return { rows: [this.handleInsert(insertMatch, params)] }
    }

    const updateMatch = /^UPDATE\s+payroll\.(\w+)\s+SET\s+([\s\S]*?)\s+WHERE\s+(\w+)\s*=\s*\$1\b/i.exec(s)
    if (updateMatch) {
      const result = this.handleUpdate(updateMatch, params)
      return { rows: result ? [result] : [] }
    }

    // DELETE is a fifth shape this schema needs (its `svc-leave` ancestor
    // did not): recalculating a draft run must REPLACE its payslips, not
    // accumulate a second set. The immutability triggers fire on DELETE
    // too, so a delete against a committed run's children is refused here
    // exactly as the database would refuse it.
    const deleteMatch = /^DELETE FROM\s+payroll\.(\w+)\s+WHERE\s+(\w+)\s*=\s*\$1\b/i.exec(s)
    if (deleteMatch) {
      return { rows: this.handleDelete(deleteMatch, params) }
    }

    const selectMatch = /^SELECT\s+\*\s+FROM\s+payroll\.(\w+)\b([\s\S]*)$/i.exec(s)
    if (selectMatch) {
      return { rows: this.handleSelect(selectMatch, params) }
    }

    throw new Error(`FakePayrollDb: unrecognised query: ${s}`)
  }

  private visible(table: string): Row[] {
    const pk = primaryKeyColumn(table)
    const byId = new Map<string, Row>()
    for (const row of this.db._table(table).values()) byId.set(String(row[pk]), row)
    for (const { table: t, row } of this.pendingWrites) {
      if (t === table) byId.set(String(row[pk]), row)
    }
    for (const { table: t, key } of this.pendingDeletes) {
      if (t === table) byId.delete(key)
    }
    return [...byId.values()]
  }

  /** `DELETE FROM payroll.<table> WHERE <col> = $1`, returning the rows removed. Fires the same immutability check the real triggers apply on DELETE. */
  private handleDelete(match: RegExpExecArray, params: unknown[]): Row[] {
    const table = match[1]
    const whereCol = match[2]
    if (table === undefined || whereCol === undefined) throw new Error('FakePayrollDb: delete missing table or WHERE column')
    const pk = primaryKeyColumn(table)
    const doomed = this.visible(table).filter((r) => r[whereCol] === params[0])
    for (const row of doomed) {
      this.assertNotFrozen(table, row, 'UPDATE')
      const key = String(row[pk])
      if (this.inTx) this.pendingDeletes.push({ table, key })
      else this.db._table(table).delete(key)
    }
    return doomed
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

  /** The status of the `payroll_run` a row belongs to, following whichever join shape the real trigger follows for that table. */
  private owningRunStatus(table: string, row: Row): string | null {
    if (table === 'payroll_run') return typeof row['status'] === 'string' ? row['status'] : null
    if (table === 'payslip' || table === 'statutory_export') {
      const run = this.visible('payroll_run').find((r) => r['id'] === row['run_id'])
      return run === undefined ? null : String(run['status'])
    }
    if (table === 'pay_item') {
      const slip = this.visible('payslip').find((s) => s['id'] === row['payslip_id'])
      if (slip === undefined) return null
      const run = this.visible('payroll_run').find((r) => r['id'] === slip['run_id'])
      return run === undefined ? null : String(run['status'])
    }
    return null
  }

  /**
   * Mirrors the four committed-run immutability triggers, including which
   * operations each fires on. `payslip`'s trigger (from the original
   * schema migration) is `BEFORE UPDATE OR DELETE` only; `statutory_export`
   * and `pay_item` (from the child-immutability migration) also fire on
   * INSERT, because adding a filing or a line item to a committed run
   * changes what that run's evidence says just as effectively as editing
   * one would.
   */
  private assertNotFrozen(table: string, row: Row, operation: 'INSERT' | 'UPDATE'): void {
    const TRIGGERS: Record<string, { name: string; onInsert: boolean }> = {
      payroll_run: { name: 'payroll_run_immutable_when_committed', onInsert: false },
      payslip: { name: 'payslip_immutable_when_run_committed', onInsert: false },
      statutory_export: { name: 'statutory_export_immutable_when_run_committed', onInsert: true },
      pay_item: { name: 'pay_item_immutable_when_run_committed', onInsert: true },
    }
    const trigger = TRIGGERS[table]
    if (trigger === undefined) return
    if (operation === 'INSERT' && !trigger.onInsert) return
    if (this.owningRunStatus(table, row) === 'committed') throw new ConstraintViolation(trigger.name)
  }

  /** Mirrors `payroll_run_sod_check` — the DB half of the preparer ≠ approver control. */
  private assertSod(table: string, row: Row): void {
    if (table !== 'payroll_run') return
    const approvedBy = row['approved_by']
    if (approvedBy !== null && approvedBy !== undefined && approvedBy === row['prepared_by']) {
      throw new ConstraintViolation('payroll_run_sod_check')
    }
  }

  private handleInsert(match: RegExpExecArray, params: unknown[]): Row {
    const table = match[1]
    const colsRaw = match[2] ?? ''
    const valsRaw = match[3] ?? ''
    if (table === undefined) throw new Error('FakePayrollDb: insert missing table name')
    const pk = primaryKeyColumn(table)
    const cols = colsRaw.split(',').map((c) => c.trim())
    const vals = valsRaw.split(',').map((v) => v.trim())
    const row: Row = {}
    cols.forEach((col, i) => {
      const raw = vals[i]
      if (raw === undefined) throw new Error(`FakePayrollDb: insert column "${col}" has no matching value expression`)
      const stripped = stripCast(raw)
      const idxMatch = /^\$(\d+)$/.exec(stripped)
      if (!idxMatch || idxMatch[1] === undefined) {
        throw new Error(`FakePayrollDb: unsupported value expression "${raw}" for column "${col}" (only bare $n placeholders are supported)`)
      }
      const paramIdx = Number(idxMatch[1]) - 1
      let value: unknown = params[paramIdx]
      if (/::jsonb$/.test(raw) && typeof value === 'string') value = JSON.parse(value)
      row[col] = value ?? null
    })
    // Only the `id`-keyed tables get a generated key when omitted — the
    // read models and `termination` always supply their own key.
    if (pk === 'id' && (row['id'] === undefined || row['id'] === null)) row['id'] = randomUUID()
    this.checkUnique(table, row)
    this.assertNotFrozen(table, row, 'INSERT')
    this.assertSod(table, row)
    if (this.inTx) this.pendingWrites.push({ table, row })
    else this.db._table(table).set(String(row[pk]), row)
    return row
  }

  private handleUpdate(match: RegExpExecArray, params: unknown[]): Row | null {
    const table = match[1]
    const setClause = match[2] ?? ''
    const whereCol = match[3]
    if (table === undefined) throw new Error('FakePayrollDb: update missing table name')
    if (whereCol === undefined) throw new Error('FakePayrollDb: update missing WHERE column')
    const id = params[0]
    const current = this.visible(table).find((r) => r[whereCol] === id)
    if (!current) return null

    const assignments = setClause.split(',').map((a) => a.trim())
    const patch: Row = {}
    for (const assignment of assignments) {
      const eqIdx = assignment.indexOf('=')
      if (eqIdx === -1) throw new Error(`FakePayrollDb: unparseable SET assignment "${assignment}"`)
      const col = assignment.slice(0, eqIdx).trim()
      const rawVal = assignment.slice(eqIdx + 1).trim()
      const stripped = stripCast(rawVal)
      const idxMatch = /^\$(\d+)$/.exec(stripped)
      if (!idxMatch || idxMatch[1] === undefined) {
        throw new Error(`FakePayrollDb: unsupported SET value expression "${rawVal}" for column "${col}"`)
      }
      const paramIdx = Number(idxMatch[1]) - 1
      let value: unknown = params[paramIdx]
      if (/::jsonb$/.test(rawVal) && typeof value === 'string') value = JSON.parse(value)
      patch[col] = value ?? null
    }

    const updated: Row = { ...current, ...patch }
    const pk = primaryKeyColumn(table)
    this.checkUnique(table, updated, String(current[pk]))
    // The trigger reads OLD, not NEW: a run whose status is ALREADY
    // 'committed' is frozen, which is what lets the commit UPDATE itself
    // (OLD.status = 'approved') through.
    this.assertNotFrozen(table, current, 'UPDATE')
    this.assertSod(table, updated)
    if (this.inTx) this.pendingWrites.push({ table, row: updated })
    else this.db._table(table).set(String(updated[pk]), updated)
    return updated
  }

  private handleSelect(match: RegExpExecArray, params: unknown[]): Row[] {
    const table = match[1]
    const rest = match[2] ?? ''
    if (table === undefined) throw new Error('FakePayrollDb: select missing table name')
    let rows = this.visible(table)

    const whereMatch = /^\s*WHERE\s+([\s\S]*?)(?:\s+ORDER BY|\s+LIMIT|\s*$)/i.exec(rest)
    if (whereMatch?.[1] !== undefined) {
      const conditions = whereMatch[1].split(/\s+AND\s+/i).map((c) => c.trim())
      for (const condition of conditions) {
        const condMatch = /^(\w+)\s*=\s*\$(\d+)$/.exec(condition)
        if (!condMatch || condMatch[1] === undefined || condMatch[2] === undefined) {
          throw new Error(`FakePayrollDb: unsupported WHERE condition "${condition}" (only "col = $n" equalities are supported)`)
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
