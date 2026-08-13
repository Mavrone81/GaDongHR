import type { Pool } from 'pg'
import { RelayLoop } from '../outbox/relay-loop'
import type { Queryable } from '../outbox/outbox'
import { AmqpPublisher } from './publisher'
import type { AmqpRecoveryOptions } from './publisher'
import { ConsumerLoop } from './consumer-loop'
import type { ConsumerLoopLogger, DeadLetterInfo, EventHandler } from './consumer-loop'

export interface EventBusPublishOptions {
  intervalMs?: number
  batchSize?: number
  onDrain?: (result: { published: number; failed: number }) => void
  onError?: (err: unknown) => void
  recovery?: AmqpRecoveryOptions
}

export interface EventBusConsumeOptions {
  queue: string
  routingKeys: string[]
  handlers?: Record<string, EventHandler>
  fallbackHandler?: (tx: Queryable, eventId: string, topic: string, payload: unknown) => Promise<unknown>
  maxRetries?: number
  prefetch?: number
  onDeadLetter?: (info: DeadLetterInfo) => void
  recovery?: AmqpRecoveryOptions
}

export interface EventBusOptions {
  amqpUrl: string
  pool: Pool
  schema: string
  /** Omit for a service whose schema has no `outbox` table to drain. */
  publish?: EventBusPublishOptions
  /** Omit for a service that consumes no bus events. */
  consume?: EventBusConsumeOptions
  logger?: ConsumerLoopLogger
}

export interface EventBus {
  /** `null` when `publish` was omitted — nothing to publish through. */
  publisher: AmqpPublisher | null
  /** Cancels the consumer, waits for in-flight work, stops the relay, closes every connection. Call from the service's shutdown signal handler. */
  stop(): Promise<void>
}

/**
 * The one call site every service's `main.ts` adds — bundles the relay
 * drain loop (producer side) and the dispatch loop (consumer side) behind a
 * single `start`/`stop` pair, so wiring a new service is "construct this
 * with the service's schema, queue name and handler map", not
 * re-deriving the publish→relay→consume→shutdown orchestration each time.
 * A service that only produces (e.g. `svc-onboarding`) omits `consume`; one
 * that only consumes (e.g. `svc-notify`) omits `publish`; most business
 * services pass both.
 */
export async function startEventBus(options: EventBusOptions): Promise<EventBus> {
  const publisher = options.publish ? new AmqpPublisher({ url: options.amqpUrl, recovery: options.publish.recovery, logger: options.logger }) : null

  const relayLoop =
    options.publish && publisher
      ? new RelayLoop({
          pool: options.pool,
          schema: options.schema,
          publisher,
          intervalMs: options.publish.intervalMs,
          batchSize: options.publish.batchSize,
          onDrain: options.publish.onDrain,
          onError: options.publish.onError,
        })
      : null

  const consumerLoop = options.consume
    ? new ConsumerLoop({
        url: options.amqpUrl,
        pool: options.pool,
        queue: options.consume.queue,
        routingKeys: options.consume.routingKeys,
        handlers: options.consume.handlers,
        fallbackHandler: options.consume.fallbackHandler,
        maxRetries: options.consume.maxRetries,
        prefetch: options.consume.prefetch,
        onDeadLetter: options.consume.onDeadLetter,
        recovery: options.consume.recovery,
        logger: options.logger,
      })
    : null

  if (relayLoop) await relayLoop.start()
  if (consumerLoop) await consumerLoop.start()

  return {
    publisher,
    async stop(): Promise<void> {
      // Stop new consumption first (so no new work starts), let the relay
      // finish/abandon its current tick, then close the publisher's own
      // connection last — a consumer handler or relay tick that is still
      // finishing up may itself be about to publish (e.g. `leave.approved`
      // triggering a downstream event) and needs the publisher alive until
      // it is done.
      await Promise.allSettled([consumerLoop?.stop(), relayLoop?.stop()])
      await publisher?.close()
    },
  }
}
