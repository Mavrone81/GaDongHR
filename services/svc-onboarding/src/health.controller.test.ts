import 'reflect-metadata'
import type { Pool } from 'pg'
import { HealthController } from './health.controller'
import type { CryptoProbe } from './health.controller'

/** A minimal `pg.Pool` double — the same shape `svc-config`'s `rules.controller.test.ts` `fakePool` uses. */
function fakePool(overrides: Partial<Pool> = {}): Pool {
  return {
    query: jest.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
    ...overrides,
  } as unknown as Pool
}

function fakeCryptoProbe(state: 'up' | 'down' = 'up'): CryptoProbe {
  return { check: jest.fn().mockResolvedValue(state) }
}

describe('HealthController — GET /health reports db and crypto', () => {
  it('reports db:up, crypto:up as overall status ok', async () => {
    const controller = new HealthController(fakePool(), fakeCryptoProbe('up'))

    const out = await controller.health()

    expect(out).toMatchObject({
      status: 'ok',
      service: 'svc-onboarding',
      dependencies: { db: 'up', crypto: 'up' },
    })
  })

  it('reports status degraded when the db pool query rejects — not a crash', async () => {
    const pool = fakePool({ query: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as Pool['query'] })
    const controller = new HealthController(pool, fakeCryptoProbe('up'))

    const out = await controller.health()

    expect(out).toMatchObject({ status: 'degraded', dependencies: { db: 'down', crypto: 'up' } })
  })

  it('reports status degraded when svc-crypto is unreachable — not a crash', async () => {
    const controller = new HealthController(fakePool(), fakeCryptoProbe('down'))

    const out = await controller.health()

    expect(out).toMatchObject({ status: 'degraded', dependencies: { db: 'up', crypto: 'down' } })
  })

  it('reports status ok only when both db and crypto are up', async () => {
    const bothDown = new HealthController(
      fakePool({ query: jest.fn().mockRejectedValue(new Error('down')) as unknown as Pool['query'] }),
      fakeCryptoProbe('down'),
    )

    const out = await bothDown.health()

    expect(out.status).toBe('degraded')
    // `outboxQuery: 'down'` too — the same rejecting pool answers the
    // event-bus outbox-depth query (event-bus task) no better than
    // `SELECT 1`, so it correctly shows up as its own down dependency
    // rather than being silently skipped.
    expect(out.dependencies).toEqual({ db: 'down', crypto: 'down', outboxQuery: 'down' })
  })

  it('reports outbox depth (event-bus health/metrics) when the db is healthy', async () => {
    const pool = fakePool({
      query: jest.fn().mockImplementation((sql: string) => {
        if (/count\(\*\)/i.test(sql)) return Promise.resolve({ rows: [{ pending: 2, oldest_age_seconds: 5 }] })
        return Promise.resolve({ rows: [{ '?column?': 1 }] })
      }) as unknown as Pool['query'],
    })
    const controller = new HealthController(pool, fakeCryptoProbe('up'))

    const out = await controller.health()

    expect(out.status).toBe('ok') // pending rows well under the staleness threshold
    expect(out.outbox).toEqual({ pending: 2, oldestAgeSeconds: 5, stale: false })
  })
})
