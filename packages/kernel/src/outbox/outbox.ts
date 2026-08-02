/**
 * ADR-005's guarantee starts here: a producer writes its state change and the
 * outbox row that will announce it in ONE transaction. `writeOutbox` takes
 * that transaction handle (`tx`) and never opens a connection of its own —
 * doing so would let the state change commit while the outbox row is lost
 * (or vice versa), which is exactly the atomicity this mechanism exists to
 * guarantee (PRD M4-4: zero punch events lost).
 */
export interface OutboxRow {
  id: string
  topic: string
  payload: unknown
  createdAt: Date
  publishedAt: Date | null
}

export interface Queryable {
  // The pg driver types `rows` as `any[]`; every caller narrows the row
  // shape immediately after the call (see writeOutbox below), so the `any`
  // is contained to this one interface boundary rather than spreading.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>
}

const SCHEMA_NAME_PATTERN = /^[a-z_][a-z0-9_]*$/

/**
 * `schema` is interpolated directly into SQL as a table qualifier — Postgres
 * has no way to bind an identifier as a query parameter — so it must be
 * validated before use rather than trusted as "obviously a compile-time
 * constant". A typo, or a future caller that derives it from config/request
 * data, would otherwise be unvalidated SQL identifier injection. Shared by
 * `writeOutbox`, `OutboxRelay`, and `idempotent` — the only three places a
 * schema name reaches a query string.
 */
export function assertValidSchemaName(schema: string): void {
  if (!SCHEMA_NAME_PATTERN.test(schema)) {
    throw new Error(`invalid schema name: ${JSON.stringify(schema)}`)
  }
}

/**
 * Inserts a row into `<schema>.outbox` through `tx`, the CALLER's
 * transaction handle. This is the one property that makes the outbox
 * pattern work at all: because the insert runs on the same
 * connection/transaction as the state change that produced the event, they
 * commit or roll back together.
 *
 * `schema` is explicit and qualifies the table (matching `OutboxRelay` and
 * `idempotent`) rather than being left to an assumed `search_path` — a
 * caller that builds its own `Pool` without going through `db/pool.ts`'s
 * `createPool` would otherwise write to the wrong schema, or error, with no
 * test able to catch it.
 */
export async function writeOutbox(tx: Queryable, schema: string, topic: string, payload: unknown): Promise<string> {
  assertValidSchemaName(schema)
  const result = await tx.query(
    `INSERT INTO ${schema}.outbox (topic, payload) VALUES ($1, $2::jsonb) RETURNING id`,
    [topic, JSON.stringify(payload)],
  )
  const id: unknown = result.rows[0]?.id
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('writeOutbox: INSERT ... RETURNING id did not return a row id')
  }
  return id
}
