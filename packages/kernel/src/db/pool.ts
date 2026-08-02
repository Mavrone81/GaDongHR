import { Pool, type PoolClient } from 'pg'

/**
 * Every service owns exactly one Postgres schema and its DB role is granted
 * only that schema (global-constraints). Pinning `search_path` per
 * connection lets `writeOutbox`/`idempotent` use unqualified table names
 * (`outbox`, `processed_events`, and the service's own tables) and have
 * them resolve there and nowhere else.
 */
export function createPool(connectionString: string, schema: string): Pool {
  return new Pool({ connectionString, options: `-c search_path=${schema}` })
}

/**
 * Runs `fn` on a single dedicated connection wrapped in BEGIN/COMMIT, and
 * ROLLBACKs on any failure. This is the intended way to obtain the `tx`
 * handle that `writeOutbox` and `idempotent` require: because `fn` receives
 * the same client for its whole lifetime, everything it does — the state
 * change and the outbox/processed_events row — commits or rolls back
 * together (ADR-005; PRD M4-4: zero punch events lost).
 */
export async function withTransaction<T>(pool: Pool, fn: (tx: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

/**
 * Hands `fn` a single dedicated connection (not a round-robin pool call).
 * `OutboxRelay` needs this: its SELECT ... FOR UPDATE SKIP LOCKED and the
 * later UPDATE must run on the same session for the row lock to hold across
 * the publish call in between, and `pool.query()` alone does not guarantee
 * session affinity across calls.
 */
export async function withConnection<T>(pool: Pool, fn: (conn: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    return await fn(client)
  } finally {
    client.release()
  }
}
