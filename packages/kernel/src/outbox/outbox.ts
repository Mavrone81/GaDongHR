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

/**
 * Inserts a row into the caller's own schema's `outbox` table (unqualified —
 * every service's DB role has `search_path` pinned to its one schema, per
 * global-constraints) through `tx`, the CALLER's transaction handle. This is
 * the one property that makes the outbox pattern work at all: because the
 * insert runs on the same connection/transaction as the state change that
 * produced the event, they commit or roll back together.
 */
export async function writeOutbox(tx: Queryable, topic: string, payload: unknown): Promise<string> {
  const result = await tx.query(
    `INSERT INTO outbox (topic, payload) VALUES ($1, $2::jsonb) RETURNING id`,
    [topic, JSON.stringify(payload)],
  )
  const id: unknown = result.rows[0]?.id
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('writeOutbox: INSERT ... RETURNING id did not return a row id')
  }
  return id
}
