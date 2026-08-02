import { writeOutbox } from './outbox'
import type { Queryable } from './outbox'
import { FakeDb } from './testing/fake-db'

describe('writeOutbox', () => {
  it('writes only through the given tx handle, qualifies the table with schema, serialises the payload as JSON, and returns the generated id', async () => {
    const rows = [{ id: 'outbox-row-1' }]
    const tx: Queryable = { query: jest.fn().mockResolvedValue({ rows }) }

    const id = await writeOutbox(tx, 'onboarding', 'employee.created', { empCode: 'E-001', status: 'active' })

    expect(id).toBe('outbox-row-1')
    expect(tx.query).toHaveBeenCalledTimes(1)
    const call = (tx.query as jest.Mock).mock.calls[0] as [string, unknown[]]
    const [sql, params] = call
    expect(sql).toMatch(/INSERT INTO/i)
    expect(sql).toMatch(/onboarding\.outbox/i)
    expect(params[0]).toBe('employee.created')
    expect(params[1]).toBe(JSON.stringify({ empCode: 'E-001', status: 'active' }))
  })

  it('rejects a schema name that cannot safely be interpolated into SQL', async () => {
    const tx: Queryable = { query: jest.fn() }
    await expect(writeOutbox(tx, 'onboarding; DROP TABLE outbox;--', 'employee.created', {})).rejects.toThrow(
      /invalid schema name/i,
    )
    expect(tx.query).not.toHaveBeenCalled()
  })

  it('participates in the caller transaction: a rollback undoes the outbox insert', async () => {
    const db = new FakeDb()
    const tx = db.connect()

    await tx.query('BEGIN')
    const id = await writeOutbox(tx, 'attendance', 'employee.created', { empCode: 'E-002' })
    await tx.query('ROLLBACK')

    // A separate connection that opened its own transaction (breaking
    // atomicity) would have committed the row regardless of the caller's
    // rollback. It must not appear in the committed store.
    expect(db.debugOutboxRows().find((r) => r.id === id)).toBeUndefined()
  })

  it('participates in the caller transaction: the outbox row is committed when the caller commits', async () => {
    const db = new FakeDb()
    const tx = db.connect()

    await tx.query('BEGIN')
    const id = await writeOutbox(tx, 'attendance', 'employee.created', { empCode: 'E-003' })
    await tx.query('COMMIT')

    const row = db.debugOutboxRows().find((r) => r.id === id)
    expect(row).toBeDefined()
    expect(row?.topic).toBe('employee.created')
    expect(row?.payload).toEqual({ empCode: 'E-003' })
    expect(row?.publishedAt).toBeNull()
  })
})
