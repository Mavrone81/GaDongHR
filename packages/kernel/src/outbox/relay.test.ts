import { OutboxRelay } from './relay'
import type { Publisher } from './relay'
import { writeOutbox } from './outbox'
import type { Queryable } from './outbox'
import { FakeDb } from './testing/fake-db'

async function seedOutboxRow(db: FakeDb, topic: string, payload: unknown): Promise<string> {
  const tx = db.connect()
  await tx.query('BEGIN')
  const id = await writeOutbox(tx, 'attendance', topic, payload)
  await tx.query('COMMIT')
  return id
}

describe('OutboxRelay construction', () => {
  it('rejects a schema name that cannot safely be interpolated into SQL', () => {
    const publisher: Publisher = { publish: jest.fn() }
    expect(() => new OutboxRelay({ query: jest.fn() }, publisher, 'attendance; DROP TABLE outbox;--')).toThrow(
      /invalid schema name/i,
    )
  })
})

describe('OutboxRelay.drainOnce', () => {
  it('wraps the batch in an explicit transaction (BEGIN ... COMMIT) so the row lock survives the publish call', async () => {
    // This is the mechanism the SKIP LOCKED test below depends on: against
    // real Postgres, a SELECT ... FOR UPDATE issued without an enclosing
    // transaction releases its lock the instant the SELECT returns, so two
    // relay instances would double-publish. The fake enforces SKIP LOCKED
    // regardless of BEGIN/COMMIT, so that test alone would not catch a
    // regression here — this test asserts the transaction wrapping
    // directly by recording the literal sequence of statements sent.
    const db = new FakeDb()
    await seedOutboxRow(db, 'employee.created', { n: 1 })

    const conn = db.connect()
    const calls: string[] = []
    const recordingConn: Queryable = {
      query: async (sql: string, params?: unknown[]) => {
        calls.push(sql.trim().split(/\s+/)[0]?.toUpperCase() ?? '')
        return conn.query(sql, params)
      },
    }
    const publisher: Publisher = { publish: jest.fn(async () => {}) }
    const relay = new OutboxRelay(recordingConn, publisher, 'attendance')

    await relay.drainOnce(10)

    expect(calls[0]).toBe('BEGIN')
    expect(calls).toContain('SELECT')
    expect(calls[calls.length - 1]).toBe('COMMIT')
    expect(calls).not.toContain('ROLLBACK')
  })

  it('selects unpublished rows in created_at order, publishes each, and stamps published_at after success', async () => {
    const db = new FakeDb()
    const id1 = await seedOutboxRow(db, 'employee.created', { n: 1 })
    const id2 = await seedOutboxRow(db, 'employee.updated', { n: 2 })

    const publishedIds: string[] = []
    const publisher: Publisher = {
      publish: jest.fn(async (_topic: string, _payload: unknown, messageId: string) => {
        publishedIds.push(messageId)
      }),
    }
    const relay = new OutboxRelay(db.connect(), publisher, 'attendance')

    const result = await relay.drainOnce(10)

    expect(result).toEqual({ published: 2, failed: 0 })
    expect(publishedIds).toEqual([id1, id2])
    const rows = db.debugOutboxRows()
    expect(rows.find((r) => r.id === id1)?.publishedAt).toBeInstanceOf(Date)
    expect(rows.find((r) => r.id === id2)?.publishedAt).toBeInstanceOf(Date)
  })

  it('a publish failure leaves published_at NULL, is reported in failed, and does not throw', async () => {
    const db = new FakeDb()
    const id = await seedOutboxRow(db, 'attendance.punch', { bad: true })

    const publisher: Publisher = { publish: jest.fn().mockRejectedValue(new Error('amqp unreachable')) }
    const relay = new OutboxRelay(db.connect(), publisher, 'attendance')

    const result = await expect(relay.drainOnce(10)).resolves.toEqual({ published: 0, failed: 1 })
    void result

    const row = db.debugOutboxRows().find((r) => r.id === id)
    expect(row?.publishedAt).toBeNull()
  })

  it('stamps published_at only AFTER a successful publish, never before — proved with a throwing publisher', async () => {
    const db = new FakeDb()
    const id = await seedOutboxRow(db, 'attendance.punch', { ok: false })

    let publishedAtDuringPublish: Date | null | undefined
    const publisher: Publisher = {
      publish: jest.fn(async () => {
        // Inspect the row's state WHILE inside publish, before the relay has
        // had any chance to stamp it — must already be null, and must stay
        // null once we throw.
        publishedAtDuringPublish = db.debugOutboxRows().find((r) => r.id === id)?.publishedAt
        throw new Error('boom')
      }),
    }
    const relay = new OutboxRelay(db.connect(), publisher, 'attendance')

    const result = await relay.drainOnce(10)

    expect(publishedAtDuringPublish).toBeNull()
    expect(result).toEqual({ published: 0, failed: 1 })
    expect(db.debugOutboxRows().find((r) => r.id === id)?.publishedAt).toBeNull()
  })

  it('one poisoned message does not stall the queue: later rows in the batch still publish', async () => {
    const db = new FakeDb()
    const badId = await seedOutboxRow(db, 'attendance.punch', { bad: true })
    const goodId = await seedOutboxRow(db, 'attendance.punch', { bad: false })

    const publisher: Publisher = {
      publish: jest.fn(async (_topic: string, payload: unknown) => {
        if ((payload as { bad: boolean }).bad) throw new Error('poisoned')
      }),
    }
    const relay = new OutboxRelay(db.connect(), publisher, 'attendance')

    const result = await relay.drainOnce(10)

    expect(result).toEqual({ published: 1, failed: 1 })
    const rows = db.debugOutboxRows()
    expect(rows.find((r) => r.id === badId)?.publishedAt).toBeNull()
    expect(rows.find((r) => r.id === goodId)?.publishedAt).toBeInstanceOf(Date)
  })

  it('FOR UPDATE SKIP LOCKED prevents two relay instances from publishing the same row twice', async () => {
    const db = new FakeDb()
    const id = await seedOutboxRow(db, 'employee.created', { n: 1 })

    let signalPublishStarted: () => void = () => {}
    const publishStarted = new Promise<void>((resolve) => {
      signalPublishStarted = resolve
    })
    let releaseFirstPublish: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      releaseFirstPublish = resolve
    })

    const publisherA: Publisher = {
      publish: jest.fn(async () => {
        signalPublishStarted()
        await gate
      }),
    }
    const publisherB: Publisher = { publish: jest.fn(async () => {}) }

    const relayA = new OutboxRelay(db.connect(), publisherA, 'attendance')
    const relayB = new OutboxRelay(db.connect(), publisherB, 'attendance')

    const drainAPromise = relayA.drainOnce(10)
    // Wait until relayA has selected + locked the row and is blocked inside
    // publish, before letting relayB attempt to drain the same row.
    await publishStarted

    const resultB = await relayB.drainOnce(10)
    expect(resultB).toEqual({ published: 0, failed: 0 })
    expect(publisherB.publish).not.toHaveBeenCalled()

    releaseFirstPublish()
    const resultA = await drainAPromise
    expect(resultA).toEqual({ published: 1, failed: 0 })
    expect(db.debugOutboxRows().find((r) => r.id === id)?.publishedAt).toBeInstanceOf(Date)
  })
})
