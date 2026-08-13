import * as amqp from 'amqplib'
import type { Channel, ConfirmChannel, ConsumeMessage, RecoveringChannelModel } from 'amqplib'
import type { Pool } from 'pg'
import { withTransaction } from '../db/pool'
import type { Queryable } from '../outbox/outbox'
import type { AmqpRecoveryOptions } from './publisher'
import { DEAD_LETTER_EXCHANGE, assertServiceQueue } from './topology'
import { decideRetry, readOriginalTopic } from './retry'
import type { AmqpHeaders } from './retry'

/** See `publisher.ts`'s identical `ConfirmChannelSource` doc — same reason: `ChannelModel` and `RecoveringChannelModel` don't share a common named type, only this structural shape. */
interface ConfirmChannelSource {
  createConfirmChannel(): Promise<ConfirmChannel>
}

/**
 * One event handler: runs inside `withTransaction` (the same connection the
 * kernel's `idempotent()` needs to dedupe-and-apply atomically), receives
 * the eventId `idempotent()` dedupes on (the outbox row id — `AmqpPublisher`
 * carries it as the AMQP `messageId` property) and the parsed JSON payload.
 * Matches every existing `handle*` method's `(tx, eventId, payload)` shape
 * exactly (`EventsConsumer`, `EventConsumersService`, `EventsService`, ...)
 * — this loop calls into those methods, it does not reimplement them.
 */
export type EventHandler = (tx: Queryable, eventId: string, payload: unknown) => Promise<unknown>

export interface DeadLetterInfo {
  queue: string
  topic: string
  eventId: string | undefined
  error: string
  attempts: number
}

export interface ConsumerLoopLogger {
  error: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
}

export interface ConsumerLoopOptions {
  url: string
  pool: Pool
  queue: string
  /** Routing keys to bind this queue to — exact event names, or a pattern like `audit.#`. */
  routingKeys: string[]
  /** Exact-routing-key dispatch table. */
  handlers?: Record<string, EventHandler>
  /**
   * Used for a queue bound with a wildcard pattern (`svc-audit`'s
   * `audit.#`), where the routing key itself is data the handler
   * interprets rather than a lookup key. Receives the routing key as the
   * `topic` argument. If both `handlers[routingKey]` and `fallbackHandler`
   * would apply, the exact match wins.
   */
  fallbackHandler?: (tx: Queryable, eventId: string, topic: string, payload: unknown) => Promise<unknown>
  /** Retries before a message is dead-lettered (see `decideRetry`). Default 5. */
  maxRetries?: number
  /** `channel.prefetch` — bounds how many unacked deliveries this consumer holds at once. Default 10. */
  prefetch?: number
  onDeadLetter?: (info: DeadLetterInfo) => void
  logger?: ConsumerLoopLogger
  recovery?: AmqpRecoveryOptions
}

const noopLogger: ConsumerLoopLogger = { error: () => {}, warn: () => {} }

/**
 * The consume side of the transport `OutboxRelay` was missing a partner
 * for: binds a durable queue to `gadong.events`, dispatches each delivery
 * into the matching existing `handle*` method wrapped in a real DB
 * transaction, and acks only after that transaction commits — so a crash
 * between delivery and ack leaves the message unacked and RabbitMQ
 * redelivers it (at-least-once), while `idempotent()` inside the handler
 * makes that redelivery a no-op effect the second time.
 *
 * **Failure isolation.** A handler that throws does not requeue the
 * message in place (which would re-deliver it at the HEAD of the queue,
 * blocking every message behind it — the exact "one poison message stalls
 * the queue forever" failure this exists to prevent). Instead it is
 * explicitly republished to the TAIL of the same queue with an
 * incremented retry-count header (`decideRetry`), so queue order continues
 * past it. Once retries are exhausted the message is republished to the
 * service's own dead-letter queue instead, and `onDeadLetter` fires so a
 * caller can surface it (metrics, logs) — "make the failure visible".
 *
 * **Reconnection.** Same amqplib built-in `recovery` mechanism as
 * `AmqpPublisher`; `setup` re-declares the queue/bindings and resumes
 * consuming on every successful (re)connection, so a broker restart does
 * not leave this consumer silently unsubscribed.
 *
 * **Graceful shutdown.** `stop()` cancels the consumer (no new
 * deliveries), waits for every in-flight handler transaction to settle,
 * then closes the channel/connection — an in-flight message is acked or
 * retried before the process exits, never abandoned mid-transaction.
 */
export class ConsumerLoop {
  private model: RecoveringChannelModel | null = null
  private channel: ConfirmChannel | null = null
  private consumerTag: string | null = null
  private stopped = false
  private readonly inFlight = new Set<Promise<void>>()
  private readonly logger: ConsumerLoopLogger

  constructor(private readonly options: ConsumerLoopOptions) {
    this.logger = options.logger ?? noopLogger
  }

  async start(): Promise<void> {
    const model = await amqp.connect(this.options.url, { recovery: { ...this.options.recovery } })
    this.model = model
    model.on('connect', (channelModel: ConfirmChannelSource) => {
      this.setup(channelModel).catch((err: unknown) => this.logger.error(`ConsumerLoop[${this.options.queue}]: resubscribe after reconnect failed`, err))
    })
    model.on('error', (err: Error) => this.logger.error(`ConsumerLoop[${this.options.queue}]: connection error`, err))
    await this.setup(model)
  }

  private async setup(channelModel: ConfirmChannelSource): Promise<void> {
    if (this.stopped) return
    const channel = await channelModel.createConfirmChannel()
    await assertServiceQueue(channel, { queue: this.options.queue, routingKeys: this.options.routingKeys })
    await channel.prefetch(this.options.prefetch ?? 10)
    channel.on('error', (err: Error) => this.logger.error(`ConsumerLoop[${this.options.queue}]: channel error`, err))
    this.channel = channel
    const { consumerTag } = await channel.consume(this.options.queue, (msg) => this.onMessage(channel, msg), { noAck: false })
    this.consumerTag = consumerTag
  }

  private onMessage(channel: ConfirmChannel, msg: ConsumeMessage | null): void {
    if (!msg) return // broker cancelled this consumer (e.g. queue deleted)
    if (this.stopped) return
    const task = this.handle(channel, msg).catch((err: unknown) => this.logger.error(`ConsumerLoop[${this.options.queue}]: unhandled error processing message`, err))
    this.inFlight.add(task)
    void task.finally(() => this.inFlight.delete(task))
  }

  private async handle(channel: ConfirmChannel, msg: ConsumeMessage): Promise<void> {
    // A first delivery's topic is its routing key; a RETRIED delivery's
    // routing key is this queue's own name (see `readOriginalTopic`'s doc)
    // — resolve through the header `decideRetry` stamps on every retry so
    // dispatch and dead-letter reporting stay correct across retry hops.
    const topic = readOriginalTopic(msg.properties.headers as AmqpHeaders | undefined, msg.fields.routingKey)
    const eventId = typeof msg.properties.messageId === 'string' ? msg.properties.messageId : undefined

    try {
      if (!eventId) throw new Error(`ConsumerLoop[${this.options.queue}]: message on routing key "${topic}" carries no messageId; cannot dedupe`)
      const exactHandler = this.options.handlers?.[topic]
      if (!exactHandler && !this.options.fallbackHandler) {
        throw new Error(`ConsumerLoop[${this.options.queue}]: no handler registered for routing key "${topic}"`)
      }
      const payload = JSON.parse(msg.content.toString('utf8')) as unknown

      if (exactHandler) {
        await withTransaction(this.options.pool, (tx) => exactHandler(tx, eventId, payload))
      } else {
        const fallback = this.options.fallbackHandler
        if (!fallback) throw new Error('unreachable: checked above')
        await withTransaction(this.options.pool, (tx) => fallback(tx, eventId, topic, payload))
      }
      channel.ack(msg)
    } catch (err) {
      await this.deadLetterOrRetry(channel, msg, topic, eventId, err)
    }
  }

  private async deadLetterOrRetry(
    channel: ConfirmChannel,
    msg: ConsumeMessage,
    topic: string,
    eventId: string | undefined,
    err: unknown,
  ): Promise<void> {
    const decision = decideRetry(msg.properties.headers as AmqpHeaders | undefined, err, topic, this.options.maxRetries)

    await new Promise<void>((resolve, reject) => {
      const onConfirm = (confirmErr: unknown): void => {
        if (confirmErr) reject(confirmErr instanceof Error ? confirmErr : new Error(String(confirmErr)))
        else resolve()
      }
      if (decision.action === 'retry') {
        // Republished to the TAIL of the same queue (never back onto the
        // exchange, which would re-fan-out to every OTHER service bound to
        // this routing key too) so queue order continues past the failure.
        channel.sendToQueue(this.options.queue, msg.content, { ...msg.properties, headers: decision.headers }, onConfirm)
      } else {
        channel.publish(
          DEAD_LETTER_EXCHANGE,
          this.options.queue,
          msg.content,
          { ...msg.properties, headers: decision.headers },
          onConfirm,
        )
      }
    })

    channel.ack(msg)

    if (decision.action === 'dead-letter') {
      const message = err instanceof Error ? err.message : String(err)
      this.logger.warn(`ConsumerLoop[${this.options.queue}]: dead-lettered "${topic}" after ${decision.attempt} attempts: ${message}`)
      this.options.onDeadLetter?.({ queue: this.options.queue, topic, eventId, error: message, attempts: decision.attempt })
    }
  }

  /**
   * Cancels the consumer (stops new deliveries), waits for every in-flight
   * handler transaction to settle, then closes the channel and connection.
   * Called from each service's shutdown path so a redeploy does not abandon
   * a message mid-transaction (`SIGTERM` handler — see service `main.ts`).
   */
  async stop(): Promise<void> {
    this.stopped = true
    const channel = this.channel
    if (channel && this.consumerTag) {
      try {
        await channel.cancel(this.consumerTag)
      } catch {
        // Channel/connection may already be gone — nothing left to cancel.
      }
    }
    await Promise.allSettled([...this.inFlight])
    if (channel) {
      try {
        await channel.close()
      } catch {
        // Already closed.
      }
    }
    const model = this.model
    this.model = null
    if (model) {
      try {
        await model.close()
      } catch {
        // Already closed.
      }
    }
  }
}

// Re-exported so callers that only need the `Channel` type for a
// hand-rolled test double don't have to import `amqplib` directly.
export type { Channel }
