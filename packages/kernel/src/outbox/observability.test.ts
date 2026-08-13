import { DEFAULT_STALE_THRESHOLD_SECONDS, isOutboxStale, outboxDepth } from './observability'
import type { Queryable } from './outbox'

function fakePool(row: { pending?: number; oldest_age_seconds?: number | null }): Queryable {
  return { query: jest.fn().mockResolvedValue({ rows: [row] }) }
}

describe('outboxDepth', () => {
  it('rejects a schema name that cannot safely be interpolated into SQL', async () => {
    await expect(outboxDepth(fakePool({}), 'attendance; DROP TABLE outbox;--')).rejects.toThrow(/invalid schema name/i)
  })

  it('reports zero pending and null age for an empty outbox', async () => {
    const pool = fakePool({ pending: 0, oldest_age_seconds: null })
    await expect(outboxDepth(pool, 'payroll')).resolves.toEqual({ pending: 0, oldestAgeSeconds: null })
  })

  it('reports pending count and oldest row age', async () => {
    const pool = fakePool({ pending: 4, oldest_age_seconds: 12.5 })
    await expect(outboxDepth(pool, 'payroll')).resolves.toEqual({ pending: 4, oldestAgeSeconds: 12.5 })
  })

  it('scopes the query to the given schema', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ pending: 0, oldest_age_seconds: null }] })
    await outboxDepth({ query }, 'timesheet')
    const sql = (query.mock.calls[0] as [string])[0]
    expect(sql).toContain('timesheet.outbox')
  })
})

describe('isOutboxStale', () => {
  it('is never stale with zero pending rows, regardless of a (meaningless) age', () => {
    expect(isOutboxStale({ pending: 0, oldestAgeSeconds: 10_000 })).toBe(false)
  })

  it('is not stale when pending rows are younger than the threshold', () => {
    expect(isOutboxStale({ pending: 3, oldestAgeSeconds: DEFAULT_STALE_THRESHOLD_SECONDS - 1 })).toBe(false)
  })

  it('is stale once the oldest pending row exceeds the threshold — this is what a stopped relay looks like', () => {
    expect(isOutboxStale({ pending: 3, oldestAgeSeconds: DEFAULT_STALE_THRESHOLD_SECONDS + 1 })).toBe(true)
  })

  it('honours a custom threshold', () => {
    expect(isOutboxStale({ pending: 1, oldestAgeSeconds: 30 }, 10)).toBe(true)
  })
})
