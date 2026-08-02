import { idempotent } from './consumer'
import { FakeDb } from './testing/fake-db'

describe('idempotent', () => {
  it('rejects a schema name that cannot safely be interpolated into SQL', async () => {
    const db = new FakeDb()
    const tx = db.connect()
    const handler = jest.fn()

    await tx.query('BEGIN')
    await expect(idempotent(tx, 'attendance; DROP TABLE processed_events;--', 'evt-1', handler)).rejects.toThrow(
      /invalid schema name/i,
    )
    expect(handler).not.toHaveBeenCalled()
  })

  it('inserts into processed_events and runs the handler on first delivery', async () => {
    const db = new FakeDb()
    const tx = db.connect()
    const handler = jest.fn().mockResolvedValue('applied')

    await tx.query('BEGIN')
    const result = await idempotent(tx, 'attendance', 'evt-1', handler)
    await tx.query('COMMIT')

    expect(result).toBe('applied')
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('returns "duplicate" without running the handler when the event was already processed', async () => {
    const db = new FakeDb()

    const tx1 = db.connect()
    await tx1.query('BEGIN')
    await idempotent(tx1, 'attendance', 'evt-1', jest.fn().mockResolvedValue('first'))
    await tx1.query('COMMIT')

    const tx2 = db.connect()
    await tx2.query('BEGIN')
    const handler2 = jest.fn()
    const result = await idempotent(tx2, 'attendance', 'evt-1', handler2)
    await tx2.query('COMMIT')

    expect(result).toBe('duplicate')
    expect(handler2).not.toHaveBeenCalled()
  })

  it('triple delivery of the same eventId runs the handler exactly once (XC-EVENTS)', async () => {
    const db = new FakeDb()
    const handler = jest.fn(async (): Promise<'applied'> => 'applied')
    const results: Array<'applied' | 'duplicate'> = []

    for (let i = 0; i < 3; i++) {
      const tx = db.connect()
      await tx.query('BEGIN')
      const result = await idempotent(tx, 'attendance', 'evt-dup', handler)
      await tx.query('COMMIT')
      results.push(result)
    }

    expect(handler).toHaveBeenCalledTimes(1)
    expect(results).toEqual(['applied', 'duplicate', 'duplicate'])
  })

  it('rolls back the processed_events row when the handler throws, so the event is redelivered', async () => {
    const db = new FakeDb()

    const tx1 = db.connect()
    await tx1.query('BEGIN')
    await expect(
      idempotent(tx1, 'attendance', 'evt-2', async () => {
        throw new Error('handler failed mid-effect')
      }),
    ).rejects.toThrow('handler failed mid-effect')
    await tx1.query('ROLLBACK')

    // Redelivery: a fresh transaction, same eventId, must NOT see it as a
    // duplicate — if the first attempt's processed_events insert had
    // survived the rollback, this would silently mark the event done even
    // though its effect never took effect (silent data loss).
    const tx2 = db.connect()
    await tx2.query('BEGIN')
    const handler2 = jest.fn().mockResolvedValue('applied-on-retry')
    const result = await idempotent(tx2, 'attendance', 'evt-2', handler2)
    await tx2.query('COMMIT')

    expect(result).toBe('applied-on-retry')
    expect(handler2).toHaveBeenCalledTimes(1)
  })
})
