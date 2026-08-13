import * as amqp from 'amqplib'
import type { ConfirmChannel, RecoveringChannelModel } from 'amqplib'
import type { Publisher } from '../outbox/relay'
import { EVENTS_EXCHANGE, assertTopology } from './topology'

/**
 * `amqplib`'s `ChannelModel` (a first, non-recovering connection) and
 * `RecoveringChannelModel` (`amqp.connect(url, { recovery: true })`'s
 * return type) are separate, not-assignable-to-each-other interfaces that
 * both expose `createConfirmChannel` — this is the minimal structural
 * shape both this class's initial `connect()` call and its `'connect'`
 * event listener need, so one type covers both without an unsound cast.
 */
interface ConfirmChannelSource {
  createConfirmChannel(): Promise<ConfirmChannel>
}

export interface AmqpRecoveryOptions {
  initialDelay?: number
  maxDelay?: number
  factor?: number
  jitter?: number
  maxRetries?: number
}

export interface AmqpPublisherOptions {
  url: string
  /** Passed straight through to `amqplib`'s built-in reconnect-with-backoff (`amqp.connect(url, { recovery })`) — defaults (100ms initial, 30s max, infinite retries) are amqplib's own and are what every reconnect test below exercises. */
  recovery?: AmqpRecoveryOptions
  logger?: Pick<Console, 'error'>
}

/**
 * The concrete `Publisher` `OutboxRelay` was written against but never
 * got — see this repo's kernel `outbox/relay.ts` header. Publishes to the
 * single `gadong.events` topic exchange with the outbox row's `topic` as
 * the routing key, exactly matching `assertServiceQueue`'s bindings on the
 * consuming side.
 *
 * **Confirm-channel, not a plain channel.** `publish` only resolves once
 * the broker has acked the message (`ConfirmChannel`'s per-message
 * callback), and `OutboxRelay.drainOnce` only stamps `published_at` after
 * `publish` resolves — so a message the broker never actually durably
 * received can never be marked delivered. Without confirms, `channel.publish`
 * returns synchronously the instant the message is handed to the local
 * TCP buffer, which is not the same thing as "RabbitMQ has it."
 *
 * **Reconnection.** Uses amqplib 2.x's built-in `recovery` option
 * (`amqp.connect(url, { recovery: true })`) rather than a hand-rolled
 * backoff loop — that connection transparently reconnects on
 * disconnect/broker restart. What amqplib does NOT do automatically is
 * re-create channels and re-run `assertTopology` after a reconnect (a
 * plain `Channel` object does not survive its underlying connection
 * dying); this class listens for the model's `'connect'` event — which
 * fires on the FIRST connect too, but only after `amqp.connect(...)`'s
 * promise already resolved, i.e. AFTER this class would have missed it —
 * so the constructor does the first channel setup explicitly and relies
 * on the event listener only for every connect after that.
 */
export class AmqpPublisher implements Publisher {
  private model: RecoveringChannelModel | null = null
  private channel: ConfirmChannel | null = null
  private connectPromise: Promise<void> | null = null
  private closed = false

  constructor(private readonly options: AmqpPublisherOptions) {}

  private async ensureConnected(): Promise<void> {
    if (this.channel) return
    if (this.closed) throw new Error('AmqpPublisher: publish() called after close()')
    if (!this.connectPromise) this.connectPromise = this.connect()
    await this.connectPromise
  }

  private async connect(): Promise<void> {
    const model = await amqp.connect(this.options.url, { recovery: { ...this.options.recovery } })
    this.model = model
    model.on('connect', (channelModel: ConfirmChannelSource) => {
      this.setupChannel(channelModel).catch((err: unknown) => {
        this.options.logger?.error('AmqpPublisher: failed to re-establish channel after reconnect', err)
      })
    })
    model.on('error', (err: Error) => {
      this.options.logger?.error('AmqpPublisher: connection error', err)
    })
    await this.setupChannel(model)
  }

  private async setupChannel(channelModel: ConfirmChannelSource): Promise<void> {
    const channel = await channelModel.createConfirmChannel()
    await assertTopology(channel)
    channel.on('error', (err: Error) => {
      this.options.logger?.error('AmqpPublisher: channel error', err)
      if (this.channel === channel) this.channel = null
    })
    channel.on('close', () => {
      if (this.channel === channel) this.channel = null
    })
    this.channel = channel
  }

  async publish(topic: string, payload: unknown, messageId: string): Promise<void> {
    await this.ensureConnected()
    const channel = this.channel
    if (!channel) throw new Error('AmqpPublisher: no broker channel available (reconnecting)')

    await new Promise<void>((resolve, reject) => {
      channel.publish(
        EVENTS_EXCHANGE,
        topic,
        Buffer.from(JSON.stringify(payload)),
        { persistent: true, messageId, contentType: 'application/json', timestamp: Date.now() },
        (err: unknown) => {
          if (err) reject(err instanceof Error ? err : new Error(String(err)))
          else resolve()
        },
      )
    })
  }

  /** Closes the channel and connection. Safe to call even if `connect` never succeeded. */
  async close(): Promise<void> {
    this.closed = true
    const channel = this.channel
    this.channel = null
    if (channel) {
      try {
        await channel.close()
      } catch {
        // Already closed / broker gone — nothing further to clean up.
      }
    }
    const model = this.model
    this.model = null
    if (model) {
      try {
        await model.close()
      } catch {
        // Already closed / broker gone.
      }
    }
  }
}
