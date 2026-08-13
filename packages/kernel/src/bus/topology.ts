import type { Channel } from 'amqplib'

/**
 * The single topic exchange every producer publishes to and every consumer
 * queue binds against — `docs/superpowers/plans/00-PROGRAM-ROADMAP.md`
 * "Event catalog: RabbitMQ topic exchange `gadong.events`". Routing key =
 * event name (`employee.created`, `audit.<action>`, ...), exactly the
 * `topic` argument `OutboxRelay.drainOnce` already passes to
 * `Publisher.publish`.
 */
export const EVENTS_EXCHANGE = 'gadong.events'

/**
 * Where a message lands after it exhausts this consumer's retry budget
 * (`ConsumerLoop`'s `maxRetries`) — "Failure isolation: one poison message
 * must not stall a queue forever. Dead-letter it and make the failure
 * visible." A single shared DLX (not one per service) keeps the topology
 * declaration small; each service still gets its OWN dead-letter queue
 * (see `assertServiceQueue`), because the routing key used to publish onto
 * this exchange is always the destination queue's own name — never the
 * original event topic — so cross-service DLQ bleed is structurally
 * impossible, not just a convention.
 */
export const DEAD_LETTER_EXCHANGE = 'gadong.events.dlx'

/**
 * Declares both exchanges. `assertExchange` is idempotent by construction
 * (AMQP 0-9-1 "declare" semantics: create-if-absent, no-op if an identical
 * one already exists) — repeating this on every service boot, including
 * against a completely empty broker, is exactly what "declare topology
 * idempotently so a cold start on an empty broker works" requires. Both
 * exchanges are `durable: true` so they survive a broker restart without
 * needing to be redeclared before the first message can route.
 */
export async function assertTopology(channel: Channel): Promise<void> {
  await channel.assertExchange(EVENTS_EXCHANGE, 'topic', { durable: true })
  await channel.assertExchange(DEAD_LETTER_EXCHANGE, 'topic', { durable: true })
}

export interface ServiceQueueSpec {
  /**
   * Durable queue name, unique per consuming service and purpose (e.g.
   * `q.svc-payroll.events`). Also used, verbatim, as this queue's own
   * dead-letter routing key — see `DEAD_LETTER_EXCHANGE`'s doc.
   */
  queue: string
  /**
   * Routing key bindings against `EVENTS_EXCHANGE` — exact event names
   * (`employee.created`) or a topic-exchange pattern (`audit.#` for
   * `svc-audit`, which must receive every service's `audit.<action>`
   * event without this file needing to know every action string that will
   * ever exist).
   */
  routingKeys: string[]
}

/**
 * Declares one consuming service's queue plus its private dead-letter
 * queue, and binds both. Called from `ConsumerLoop.start` (and again from
 * its own reconnect `setup`, so a queue that a broker admin deleted while
 * this process was disconnected comes back automatically) — every call is
 * a pure re-assertion, safe to repeat.
 */
export async function assertServiceQueue(channel: Channel, spec: ServiceQueueSpec): Promise<void> {
  await assertTopology(channel)

  const dlq = `${spec.queue}.dlq`
  await channel.assertQueue(spec.queue, {
    durable: true,
    arguments: {
      // Belt-and-suspenders: `ConsumerLoop` dead-letters explicitly (via
      // `channel.publish(DEAD_LETTER_EXCHANGE, ...)`) rather than relying
      // on RabbitMQ's own nack-triggered dead-lettering, so this argument
      // is a safety net for messages RabbitMQ itself rejects (e.g. queue
      // length limits, which this queue does not currently set, but a
      // future one might) rather than the primary DLQ mechanism.
      'x-dead-letter-exchange': DEAD_LETTER_EXCHANGE,
      'x-dead-letter-routing-key': spec.queue,
    },
  })
  await channel.assertQueue(dlq, { durable: true })
  await channel.bindQueue(dlq, DEAD_LETTER_EXCHANGE, spec.queue)

  for (const routingKey of spec.routingKeys) {
    await channel.bindQueue(spec.queue, EVENTS_EXCHANGE, routingKey)
  }
}

/** `<queue>.dlq` — exported so tests and health/metrics code never have to restate the naming convention. */
export function deadLetterQueueName(queue: string): string {
  return `${queue}.dlq`
}
