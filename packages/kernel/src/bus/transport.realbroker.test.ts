/**
 * Real-broker, real-Postgres proof for the transport this task builds —
 * `OutboxRelay` (already correct, already tested against a fake) actually
 * reaching a real RabbitMQ via `AmqpPublisher`, and a real `ConsumerLoop`
 * actually dispatching deliveries into a real DB transaction via kernel's
 * own `idempotent()`. Every one of the other 2,587 tests in this repo uses
 * an in-memory fake for both the database and the broker — which is
 * exactly why the defect this task fixes (`OutboxRelay.drainOnce` never
 * called anywhere; no AMQP client in the monorepo) shipped without a
 * single failing test. This file is the antidote: it does not construct a
 * fake anywhere.
 *
 * Requires `deploy/docker-compose.eventbus-test.yml`'s `postgres` +
 * `rabbitmq` up and the `payroll` schema migrated — see
 * `.superpowers/sdd/02-modules/event-bus.md` for the exact commands. Run
 * with `pnpm test:realbroker`, never as part of plain `pnpm test`
 * (`jest.config.js` explicitly ignores `*.realbroker.test.ts`).
 */
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { AmqpPublisher } from './publisher'
import { ConsumerLoop } from './consumer-loop'
import { assertServiceQueue, deadLetterQueueName } from './topology'
import { OutboxRelay } from '../outbox/relay'
import { writeOutbox } from '../outbox/outbox'
import { idempotent } from '../outbox/consumer'
import * as amqp from 'amqplib'

const DATABASE_URL = process.env['EVENTBUS_TEST_DATABASE_URL_PAYROLL'] ?? 'postgresql://payroll:test_pw@localhost:25432/gadonghr_eventbus_test'
const RABBITMQ_URL = process.env['EVENTBUS_TEST_RABBITMQ_URL'] ?? 'amqp://gadong_test:gadong_test_pw@localhost:25672'
const SCHEMA = 'payroll'

let pool: Pool

beforeAll(async () => {
  pool = new Pool({ connectionString: DATABASE_URL })
  // A scratch effects table this file owns end-to-end — kept separate from
  // any real business table so this generic transport test has no
  // dependency on `svc-payroll`'s own schema evolving.
  await pool.query(`CREATE TABLE IF NOT EXISTS ${SCHEMA}.eventbus_test_effects (marker text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`)
})

afterAll(async () => {
  await pool.query(`DROP TABLE IF EXISTS ${SCHEMA}.eventbus_test_effects`)
  await pool.end()
})

async function countEffects(marker: string): Promise<number> {
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${SCHEMA}.eventbus_test_effects WHERE marker = $1`, [marker])
  return (rows[0] as { n: number }).n
}

describe('OutboxRelay + AmqpPublisher against a real RabbitMQ, ConsumerLoop against a real Postgres transaction', () => {
  it('drains a real outbox row onto the real broker and a real ConsumerLoop applies it exactly once', async () => {
    // Every test below uses a fresh `randomUUID()` queue/topic pair — there
    // is never a pre-existing queue or DLQ to purge, which is also why
    // asserting/purging one up front used to crash the whole file: AMQP
    // closes the CHANNEL (not just the operation) on `purgeQueue`/`assertQueue`
    // against a queue that does not exist with mismatched options, and that
    // close arrives as an `'error'` event — fatal if nothing is listening.
    const topic = `eventbus.transport.${randomUUID()}`
    const queue = `q.eventbus-test.${randomUUID()}`

    const marker = randomUUID()
    const applications: string[] = []
    const consumer = new ConsumerLoop({
      url: RABBITMQ_URL,
      pool,
      queue,
      routingKeys: [topic],
      handlers: {
        [topic]: (tx, eventId, payload) =>
          idempotent(tx, SCHEMA, eventId, async () => {
            const p = payload as { marker: string }
            await tx.query(`INSERT INTO ${SCHEMA}.eventbus_test_effects (marker) VALUES ($1)`, [p.marker])
            applications.push(p.marker)
          }),
      },
    })
    await consumer.start()

    try {
      // Real outbox row, written the same way every producer in this repo
      // writes one, then drained by the real `OutboxRelay` through a real
      // `AmqpPublisher` — no shortcuts, no direct queue injection.
      const client = await pool.connect()
      let outboxRowId: string
      try {
        await client.query('BEGIN')
        outboxRowId = await writeOutbox(client, SCHEMA, topic, { marker })
        await client.query('COMMIT')
      } finally {
        client.release()
      }

      const relayClient = await pool.connect()
      const publisher = new AmqpPublisher({ url: RABBITMQ_URL })
      try {
        const relay = new OutboxRelay(relayClient, publisher, SCHEMA)
        const result = await relay.drainOnce()
        expect(result).toEqual({ published: 1, failed: 0 })

        const { rows } = await pool.query(`SELECT published_at FROM ${SCHEMA}.outbox WHERE id = $1`, [outboxRowId])
        expect((rows[0] as { published_at: Date | null }).published_at).toBeInstanceOf(Date)

        await expect(waitFor(() => countEffects(marker).then((n) => n === 1))).resolves.toBe(true)
        expect(applications).toEqual([marker])
      } finally {
        relayClient.release()
        await publisher.close()
      }
    } finally {
      await consumer.stop()
    }
  })

  it('a transient handler failure is retried and succeeds on redelivery, with exactly one committed effect — not zero, not two', async () => {
    const topic = `eventbus.retry.${randomUUID()}`
    const queue = `q.eventbus-test.${randomUUID()}`

    const marker = randomUUID()
    let attempts = 0
    const consumer = new ConsumerLoop({
      url: RABBITMQ_URL,
      pool,
      queue,
      routingKeys: [topic],
      maxRetries: 5,
      handlers: {
        [topic]: (tx, eventId, payload) =>
          idempotent(tx, SCHEMA, eventId, async () => {
            attempts += 1
            if (attempts === 1) throw new Error('simulated transient failure — e.g. a momentary DB blip')
            const p = payload as { marker: string }
            await tx.query(`INSERT INTO ${SCHEMA}.eventbus_test_effects (marker) VALUES ($1)`, [p.marker])
          }),
      },
    })
    await consumer.start()

    try {
      const publisher = new AmqpPublisher({ url: RABBITMQ_URL })
      try {
        await publisher.publish(topic, { marker }, randomUUID())
      } finally {
        await publisher.close()
      }

      await expect(waitFor(() => countEffects(marker).then((n) => n === 1))).resolves.toBe(true)
      expect(attempts).toBe(2) // one failure, one success — never zero attempts, never a third
    } finally {
      await consumer.stop()
    }
  })

  it('the same eventId delivered twice (a genuine redelivery/duplicate) produces exactly one effect — XC-EVENTS', async () => {
    const topic = `eventbus.duplicate.${randomUUID()}`
    const queue = `q.eventbus-test.${randomUUID()}`

    const marker = randomUUID()
    const eventId = randomUUID()
    let handlerInvocations = 0
    const consumer = new ConsumerLoop({
      url: RABBITMQ_URL,
      pool,
      queue,
      routingKeys: [topic],
      handlers: {
        [topic]: (tx, receivedEventId, payload) => {
          handlerInvocations += 1
          return idempotent(tx, SCHEMA, receivedEventId, async () => {
            const p = payload as { marker: string }
            await tx.query(`INSERT INTO ${SCHEMA}.eventbus_test_effects (marker) VALUES ($1)`, [p.marker])
          })
        },
      },
    })
    await consumer.start()

    try {
      const publisher = new AmqpPublisher({ url: RABBITMQ_URL })
      try {
        // Same messageId both times — exactly what a producer retry after a
        // lost publish-confirm, or a broker redelivery, looks like on the wire.
        await publisher.publish(topic, { marker }, eventId)
        await publisher.publish(topic, { marker }, eventId)
      } finally {
        await publisher.close()
      }

      await expect(waitFor(() => countEffects(marker).then((n) => n === 1))).resolves.toBe(true)
      // The transport delivered the message twice — `idempotent()`'s job is
      // to make the SECOND invocation a no-op, not to prevent it running at
      // all, so `handlerInvocations` reaching 2 while the effect count stays
      // at 1 is the whole point being proved here, not a bug.
      await new Promise((resolve) => setTimeout(resolve, 500))
      expect(handlerInvocations).toBe(2)
      expect(await countEffects(marker)).toBe(1)
    } finally {
      await consumer.stop()
    }
  })

  it('a poison message (always throws) is dead-lettered after exhausting retries, and does NOT stall later messages on the same queue', async () => {
    const topic = `eventbus.poison.${randomUUID()}`
    const queue = `q.eventbus-test.${randomUUID()}`

    const goodMarker = randomUUID()
    const deadLettered: Array<{ topic: string; attempts: number }> = []
    const consumer = new ConsumerLoop({
      url: RABBITMQ_URL,
      pool,
      queue,
      routingKeys: [topic],
      maxRetries: 1, // small on purpose so this test does not spend a real minute retrying
      handlers: {
        [topic]: (tx, eventId, payload) =>
          idempotent(tx, SCHEMA, eventId, async () => {
            const p = payload as { poison?: boolean; marker?: string }
            if (p.poison) throw new Error('poison payload: this handler always fails')
            await tx.query(`INSERT INTO ${SCHEMA}.eventbus_test_effects (marker) VALUES ($1)`, [p.marker])
          }),
      },
      onDeadLetter: (info) => deadLettered.push({ topic: info.topic, attempts: info.attempts }),
    })
    await consumer.start()

    try {
      const publisher = new AmqpPublisher({ url: RABBITMQ_URL })
      try {
        await publisher.publish(topic, { poison: true }, randomUUID())
        // A later, unrelated, healthy message on the SAME queue/topic —
        // this is the "does not stall the queue" half of the assertion.
        await publisher.publish(topic, { marker: goodMarker }, randomUUID())
      } finally {
        await publisher.close()
      }

      await expect(waitFor(() => Promise.resolve(deadLettered.length === 1))).resolves.toBe(true)
      expect(deadLettered[0]).toEqual({ topic, attempts: 2 }) // maxRetries=1 → original attempt + 1 retry, then dead-lettered
      await expect(waitFor(() => countEffects(goodMarker).then((n) => n === 1))).resolves.toBe(true)

      // The poisoned message actually landed in the DLQ, not just that our
      // callback fired — a broker-side check, not just an in-process one.
      const conn = await amqp.connect(RABBITMQ_URL)
      conn.on('error', () => {})
      const ch = await conn.createChannel()
      ch.on('error', () => {})
      const dlqMsg = await ch.get(deadLetterQueueName(queue), { noAck: true })
      expect(dlqMsg).not.toBe(false)
      await ch.close()
      await conn.close()
    } finally {
      await consumer.stop()
    }
  })

  it('assertServiceQueue is idempotent — repeated declaration against an already-declared topology does not throw (cold start on an empty broker)', async () => {
    const queue = `q.eventbus-test.${randomUUID()}`
    const conn = await amqp.connect(RABBITMQ_URL)
    conn.on('error', () => {})
    const ch = await conn.createChannel()
    ch.on('error', () => {})
    try {
      await assertServiceQueue(ch, { queue, routingKeys: ['a.b', 'c.#'] })
      await assertServiceQueue(ch, { queue, routingKeys: ['a.b', 'c.#'] })
      await assertServiceQueue(ch, { queue, routingKeys: ['a.b', 'c.#'] })
    } finally {
      await ch.close()
      await conn.close()
    }
  })
})

async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000, intervalMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return true
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  return check()
}
