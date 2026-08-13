import type { Pool, PoolClient } from 'pg'
import { RelayLoop } from './relay-loop'
import type { Publisher } from './relay'
import { writeOutbox } from './outbox'
import { FakeDb } from './testing/fake-db'

/**
 * Wraps `FakeDb` (the same in-memory Postgres stand-in `relay.test.ts` and
 * `consumer.test.ts` use) behind the `pg.Pool`-shaped surface `RelayLoop`
 * actually calls: `pool.connect()` returning something with `.query` and
 * `.release`. `release(err?)` is recorded so tests can assert `RelayLoop`
 * discards a connection after a failed tick, matching `db/pool.ts`'s
 * `withTransaction` poisoned-connection handling.
 */
function fakePool(db: FakeDb): { pool: Pool; releaseCalls: Array<Error | undefined> } {
  const releaseCalls: Array<Error | undefined> = []
  const connect = jest.fn(async () => {
    const conn = db.connect()
    const client = {
      query: conn.query.bind(conn),
      release: (err?: Error) => {
        releaseCalls.push(err)
      },
    } as unknown as PoolClient
    return client
  })
  return { pool: { connect } as unknown as Pool, releaseCalls }
}

async function seedRow(db: FakeDb, topic: string, payload: unknown): Promise<string> {
  const tx = db.connect()
  await tx.query('BEGIN')
  const id = await writeOutbox(tx, 'payroll', topic, payload)
  await tx.query('COMMIT')
  return id
}

describe('RelayLoop', () => {
  it('drains on start and again after each interval tick', async () => {
    const db = new FakeDb()
    await seedRow(db, 'employee.created', { n: 1 })
    const { pool } = fakePool(db)
    const published: string[] = []
    const publisher: Publisher = { publish: jest.fn(async (_t, _p, messageId: string) => void published.push(messageId)) }
    const drains: Array<{ published: number; failed: number }> = []

    const loop = new RelayLoop({ pool, schema: 'payroll', publisher, intervalMs: 20, onDrain: (r) => drains.push(r) })
    await loop.start()
    await new Promise((r) => setTimeout(r, 5))
    expect(drains).toEqual([{ published: 1, failed: 0 }])
    expect(published).toHaveLength(1)

    await seedRow(db, 'employee.updated', { n: 2 })
    await new Promise((r) => setTimeout(r, 40))
    expect(drains.length).toBeGreaterThanOrEqual(2)
    expect(published).toHaveLength(2)

    await loop.stop()
  })

  it('discards the dedicated connection after a failed tick and acquires a fresh one for the next tick — one bad tick must not permanently stall every future drain', async () => {
    const db = new FakeDb()
    await seedRow(db, 'employee.created', { n: 1 })
    const { pool, releaseCalls } = fakePool(db)
    const publisher: Publisher = { publish: jest.fn(async () => {}) }
    const errors: unknown[] = []

    const loop = new RelayLoop({
      pool,
      schema: 'payroll',
      publisher,
      intervalMs: 15,
      onDrain: () => {
        throw new Error('onDrain callback exploded — simulates a tick-level failure')
      },
      onError: (err) => errors.push(err),
    })
    await loop.start()
    await new Promise((r) => setTimeout(r, 5))

    expect(errors).toHaveLength(1)
    expect(releaseCalls[0]).toBeInstanceOf(Error)

    await new Promise((r) => setTimeout(r, 30))
    // A second tick happened on a freshly-acquired connection (pool.connect called again) rather than the loop staying wedged.
    expect((pool.connect as jest.Mock).mock.calls.length).toBeGreaterThanOrEqual(2)

    await loop.stop()
  })

  it('stop() waits for an in-flight tick, then releases cleanly with no error', async () => {
    const db = new FakeDb()
    const { pool, releaseCalls } = fakePool(db)
    const publisher: Publisher = { publish: jest.fn(async () => {}) }
    const loop = new RelayLoop({ pool, schema: 'payroll', publisher, intervalMs: 5000 })

    await loop.start()
    await loop.stop()

    expect(releaseCalls).toEqual([undefined])
  })
})
