import type { Queryable } from './outbox'

/**
 * Makes a consumer's handling of one event idempotent: inserts the event id
 * into `<schema>.processed_events` and, only if that insert was new, runs
 * `handler`. Both the insert and the handler run through `tx` — the
 * CALLER's transaction — so `idempotent` itself never opens a connection or
 * issues BEGIN/COMMIT.
 *
 * That is deliberate, not incidental: if the handler throws, the caller's
 * rollback removes the processed_events row along with whatever partial
 * effect the handler made, so the event is redelivered. Inserting the
 * processed_events row in a separate transaction would mark the event
 * processed even when its effect never took effect — silent data loss, and
 * the hardest class of bug to find later (Task 4 brief, Step 3 note).
 *
 * Triple delivery of the same eventId must produce exactly one effect
 * (XC-EVENTS): the second and third calls see the row already committed by
 * the first, INSERT ... ON CONFLICT DO NOTHING returns no row, and the
 * handler never runs.
 */
export async function idempotent<T>(
  tx: Queryable,
  schema: string,
  eventId: string,
  handler: () => Promise<T>,
): Promise<T | 'duplicate'> {
  const { rows } = await tx.query(
    `INSERT INTO ${schema}.processed_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING event_id`,
    [eventId],
  )
  if (rows.length === 0) {
    return 'duplicate'
  }
  return handler()
}
