import 'reflect-metadata'
import type { Queryable } from '@gadong/kernel'
import { HealthController } from './health.controller'

/** A minimal `Queryable` double — sufficient because `HealthController` only ever calls `query('SELECT 1')`. */
function fakePool(overrides: Partial<Queryable> = {}): Queryable {
  return {
    query: jest.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
    ...overrides,
  }
}

describe('HealthController.health', () => {
  it('reports db:up and overall status ok when the pool query succeeds', async () => {
    const controller = new HealthController(fakePool())

    const out = await controller.health()

    expect(out).toMatchObject({ status: 'ok', service: 'svc-scheduler', dependencies: { db: 'up' } })
  })

  it('reports db:down and overall status degraded when the pool query rejects — not a crash', async () => {
    const pool = fakePool({ query: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) })
    const controller = new HealthController(pool)

    const out = await controller.health()

    // `outboxQuery: 'down'` too — the same rejecting pool answers the
    // event-bus outbox-depth query (event-bus task) no better than
    // `SELECT 1`, so it correctly shows up as its own down dependency
    // rather than being silently skipped.
    expect(out).toMatchObject({ status: 'degraded', dependencies: { db: 'down', outboxQuery: 'down' } })
  })

  it('reports outbox depth (event-bus health/metrics) when the db is healthy', async () => {
    const pool = fakePool({
      query: jest.fn().mockImplementation((sql: string) => {
        if (/count\(\*\)/i.test(sql)) return Promise.resolve({ rows: [{ pending: 2, oldest_age_seconds: 5 }] })
        return Promise.resolve({ rows: [{ '?column?': 1 }] })
      }),
    })
    const controller = new HealthController(pool)

    const out = await controller.health()

    expect(out.status).toBe('ok') // pending rows well under the staleness threshold
    expect(out.outbox).toEqual({ pending: 2, oldestAgeSeconds: 5, stale: false })
  })
})
