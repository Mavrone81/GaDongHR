import { assertValidSchemaName } from './outbox'
import type { Queryable } from './outbox'

export interface OutboxDepth {
  /** Count of rows with `published_at IS NULL` — everything `OutboxRelay.drainOnce` still has to get through. */
  pending: number
  /** Age in seconds of the OLDEST unpublished row, or `null` when the outbox is empty. A relay that stopped ticking shows up here as this number climbing without bound, not as `pending` alone (a bursty-but-healthy service can have a high `pending` count for a moment; only age proves the relay has actually stalled). */
  oldestAgeSeconds: number | null
}

/**
 * There is no alerting anywhere in this system (verified — brief). This is
 * the minimum viable fix for "a stuck outbox must be observable": read the
 * two numbers a human or a monitor needs to notice a relay that silently
 * stopped draining, straight off the table `RelayLoop` is supposed to be
 * emptying. Every service that owns an outbox wires this into its `/health`
 * response (`buildHealth`'s optional `outbox` argument) rather than a
 * separate endpoint, so there is exactly one place an operator looks.
 */
export async function outboxDepth(pool: Queryable, schema: string): Promise<OutboxDepth> {
  assertValidSchemaName(schema)
  const { rows } = await pool.query(
    `SELECT count(*)::int AS pending, EXTRACT(EPOCH FROM (now() - min(created_at)))::float8 AS oldest_age_seconds
     FROM ${schema}.outbox
     WHERE published_at IS NULL`,
  )
  const row = rows[0] as { pending?: number; oldest_age_seconds?: number | null } | undefined
  const pending = typeof row?.pending === 'number' ? row.pending : 0
  const oldestAgeSeconds = typeof row?.oldest_age_seconds === 'number' ? row.oldest_age_seconds : null
  return { pending, oldestAgeSeconds }
}

/**
 * Above this age, an unpublished row stops looking like "the relay hasn't
 * gotten to it yet" and starts looking like "the relay isn't running" —
 * `RelayLoop`'s default 5s tick means a healthy queue clears in low single
 * digits of seconds even under load; five minutes is a wide margin above
 * that before treating it as `degraded`, not a tight SLO.
 */
export const DEFAULT_STALE_THRESHOLD_SECONDS = 300

export function isOutboxStale(depth: OutboxDepth, thresholdSeconds: number = DEFAULT_STALE_THRESHOLD_SECONDS): boolean {
  return depth.pending > 0 && depth.oldestAgeSeconds !== null && depth.oldestAgeSeconds > thresholdSeconds
}
