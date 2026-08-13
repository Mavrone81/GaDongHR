/**
 * Pure retry/dead-letter bookkeeping, split out from `ConsumerLoop` so the
 * bounded-retry decision itself — the part that actually decides whether a
 * poison message escalates to the DLQ — is testable without a real broker.
 * `ConsumerLoop` is the only caller; this file has no amqplib dependency.
 */

export const RETRY_COUNT_HEADER = 'x-gadong-retry-count'
export const LAST_ERROR_HEADER = 'x-gadong-last-error'
export const ORIGINAL_TOPIC_HEADER = 'x-gadong-original-topic'
export const SOURCE_QUEUE_HEADER = 'x-gadong-source-queue'

export const DEFAULT_MAX_RETRIES = 5

export type AmqpHeaders = Record<string, unknown>

/** Reads the prior attempt count off redelivered/retried message headers. Anything not a finite number (absent on first delivery, or a header some other producer set) is treated as zero — fail open toward "still has retries left" rather than accidentally short-circuiting straight to the DLQ. */
export function readRetryCount(headers: AmqpHeaders | undefined): number {
  const value = headers?.[RETRY_COUNT_HEADER]
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/**
 * Resolves the event topic a message should be dispatched under.
 *
 * A first delivery's topic is simply the AMQP routing key it arrived on
 * (`ConsumerLoop`'s queue was bound to `gadong.events` under that key). A
 * RETRIED delivery is different: `ConsumerLoop` requeues via
 * `channel.sendToQueue(queue, ...)` rather than re-publishing to the topic
 * exchange (re-publishing to the exchange would re-fan-out to every OTHER
 * queue bound to the same routing key, not just this one — see
 * `consumer-loop.ts`'s `deadLetterOrRetry`). `sendToQueue` is AMQP shorthand
 * for publishing to the nameless default exchange WITH THE QUEUE NAME AS
 * THE ROUTING KEY — so a redelivered message's `fields.routingKey` is the
 * queue's own name, not the original event topic, once it comes back
 * around. `decideRetry` stamps the real topic into `ORIGINAL_TOPIC_HEADER`
 * on every retried copy specifically so this function can recover it —
 * without this, a retried message would fail handler lookup with "no
 * handler registered for routing key <queue name>" on its very next
 * attempt, which is a real bug this fixes (found via the real-broker test,
 * not by inspection — the fake-based unit tests below cannot see this
 * class of defect at all, matching this task's own warning about what
 * fakes miss).
 */
export function readOriginalTopic(headers: AmqpHeaders | undefined, routingKey: string): string {
  const value = headers?.[ORIGINAL_TOPIC_HEADER]
  return typeof value === 'string' && value.length > 0 ? value : routingKey
}

export interface RetryDecision {
  /** Attempt count this decision is for — the previous count plus one. */
  attempt: number
  /** `'retry'`: republish to the same queue for another attempt. `'dead-letter'`: attempts are exhausted; route to the DLQ instead. */
  action: 'retry' | 'dead-letter'
  headers: AmqpHeaders
}

/**
 * Decides what happens to a message whose handler just threw, and builds
 * the headers the republished/dead-lettered copy should carry — including
 * re-stamping `topic` into `ORIGINAL_TOPIC_HEADER` every time, so it
 * survives arbitrarily many retry hops (see `readOriginalTopic`'s doc for
 * why that header has to exist at all).
 *
 * `attempt <= maxRetries` retries: attempt 1 is the first RE-delivery
 * after the original, so `maxRetries = 5` allows five retries on top of
 * the original attempt (six total tries) before the message is
 * quarantined — matching `ConsumerLoop`'s default.
 */
export function decideRetry(
  priorHeaders: AmqpHeaders | undefined,
  error: unknown,
  topic: string,
  maxRetries: number = DEFAULT_MAX_RETRIES,
): RetryDecision {
  const attempt = readRetryCount(priorHeaders) + 1
  const message = error instanceof Error ? error.message : String(error)
  const headers: AmqpHeaders = { ...priorHeaders, [RETRY_COUNT_HEADER]: attempt, [LAST_ERROR_HEADER]: message, [ORIGINAL_TOPIC_HEADER]: topic }
  return { attempt, action: attempt <= maxRetries ? 'retry' : 'dead-letter', headers }
}
