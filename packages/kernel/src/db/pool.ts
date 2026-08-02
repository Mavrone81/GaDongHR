import { Pool, type PoolClient } from 'pg'

/**
 * Server-side statement timeout (ms). Fail-closed: a relay holding
 * `FOR UPDATE` locks across a hung publish, or any other runaway query,
 * must not block writers indefinitely. `01-roles.sql` sets the same 30s
 * statement timeout at the role level; this is belt-and-suspenders at the
 * pool level so it applies even if a future role's DB-side default drifts.
 */
export const STATEMENT_TIMEOUT_MS = 30_000

/**
 * Client-side timeout (ms) for a query that never gets a response at all
 * (as opposed to `statement_timeout`, which is enforced server-side once
 * the server has the query). Same 30s figure, for the same fail-closed
 * reason: no query should be able to hang a connection forever.
 */
export const QUERY_TIMEOUT_MS = 30_000

/**
 * How long (ms) to wait for a connection to become available before
 * failing. The `pg` default is 0 — wait forever — which turns pool
 * exhaustion into a silent hang instead of a visible failure. 5s is long
 * enough to absorb a brief spike, short enough that a genuinely exhausted
 * pool surfaces as an error quickly.
 */
export const CONNECTION_TIMEOUT_MS = 5_000

/**
 * Max connections per service's pool. `01-roles.sql` grants each service's
 * DB role a 20-connection limit; 10 per pool leaves headroom for the relay
 * (which holds its own dedicated connection) and any short-lived
 * migration/admin connections without a single service pool being able to
 * exhaust its own role's ceiling on its own.
 */
export const MAX_POOL_SIZE = 10

/**
 * Every service owns exactly one Postgres schema and its DB role is granted
 * only that schema (global-constraints). Pinning `search_path` per
 * connection lets `writeOutbox`/`idempotent` use unqualified table names
 * (`outbox`, `processed_events`, and the service's own tables) and have
 * them resolve there and nowhere else.
 */
export function createPool(connectionString: string, schema: string): Pool {
  return new Pool({
    connectionString,
    options: `-c search_path=${schema}`,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    max: MAX_POOL_SIZE,
  })
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
    client.release()
    return result
  } catch (err) {
    try {
      await client.query('ROLLBACK')
      client.release()
    } catch {
      // The ROLLBACK itself failed, so the connection's transaction state
      // is now unknown (open or aborted) rather than cleanly closed.
      // Passing the original error to release() tells node-postgres to
      // destroy this connection instead of returning it to the pool — a
      // client with a stale transaction going back to the pool would let
      // the next borrower's writeOutbox silently execute inside it and
      // later be rolled back too, which is precisely the kind of loss
      // this task exists to prevent.
      client.release(err instanceof Error ? err : new Error(String(err)))
    }
    throw err
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
