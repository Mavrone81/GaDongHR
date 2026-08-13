import type { Pool, PoolClient } from 'pg'
import { OutboxRelay } from './relay'
import type { Publisher } from './relay'

export interface RelayLoopOptions {
  pool: Pool
  schema: string
  publisher: Publisher
  /** Milliseconds between drains. Default 5000. */
  intervalMs?: number
  /** Rows per `drainOnce` call. Default 50 (matches `OutboxRelay`'s own default). */
  batchSize?: number
  onDrain?: (result: { published: number; failed: number }) => void
  onError?: (err: unknown) => void
}

/**
 * `OutboxRelay.drainOnce` was implemented correctly and never called from
 * anywhere outside its own tests — `rg "new OutboxRelay|drainOnce"` outside
 * `relay.ts`/`relay.test.ts` matched nothing before this change. This class
 * is the missing call site: it holds the ONE dedicated connection
 * `OutboxRelay`'s own header comment requires (`pool.connect()`, not
 * round-robin `pool.query()` — `SELECT ... FOR UPDATE` and the later
 * `UPDATE` must share a session for the lock to hold across the publish
 * call), and calls `drainOnce` on a fixed interval for as long as the
 * service runs.
 *
 * **Poisoned-connection defense.** A dedicated `PoolClient` whose last
 * query threw sits in an ambiguous transaction state (a real Postgres
 * session with an aborted transaction rejects every further query until
 * `ROLLBACK`, which `OutboxRelay.drainOnce` already issues on its own
 * failure path — but a failure OUTSIDE `drainOnce`'s own try/catch, e.g.
 * the initial `pool.connect()` succeeding but the connection dying mid-tick,
 * is not something `OutboxRelay` can protect against with its own logic).
 * `tick()` treats any thrown error as reason to discard the held client
 * (`release(err)`, which tells `pg` to destroy rather than pool the
 * connection — the same defensive pattern `db/pool.ts`'s `withTransaction`
 * already uses) and open a fresh one before the next tick, so a single bad
 * tick cannot permanently stall every future drain.
 */
export class RelayLoop {
  private client: PoolClient | null = null
  private relay: OutboxRelay | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private currentTick: Promise<void> | null = null

  constructor(private readonly options: RelayLoopOptions) {}

  async start(): Promise<void> {
    await this.acquire()
    this.scheduleNext(0)
  }

  private async acquire(): Promise<void> {
    this.client = await this.options.pool.connect()
    this.relay = new OutboxRelay(this.client, this.options.publisher, this.options.schema)
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return
    this.timer = setTimeout(() => {
      this.currentTick = this.tick()
    }, delayMs)
  }

  private async tick(): Promise<void> {
    try {
      if (!this.relay) await this.acquire()
      const relay = this.relay
      if (!relay) throw new Error('RelayLoop: acquire() did not establish a relay connection')
      const result = await relay.drainOnce(this.options.batchSize ?? 50)
      this.options.onDrain?.(result)
    } catch (err) {
      this.options.onError?.(err)
      const client = this.client
      this.client = null
      this.relay = null
      if (client) client.release(err instanceof Error ? err : new Error(String(err)))
    } finally {
      this.scheduleNext(this.options.intervalMs ?? 5000)
    }
  }

  /** Stops scheduling further drains, waits for an in-progress tick to finish, then releases the dedicated connection. */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    if (this.currentTick) await this.currentTick.catch(() => {})
    if (this.client) this.client.release()
    this.client = null
    this.relay = null
  }
}
