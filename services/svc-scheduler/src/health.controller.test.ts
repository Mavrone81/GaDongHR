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

    expect(out).toMatchObject({ status: 'degraded', dependencies: { db: 'down' } })
  })
})
