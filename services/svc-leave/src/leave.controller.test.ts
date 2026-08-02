import type { Pool } from 'pg'
import { LeaveController } from './leave.controller'
import type { HealthCheckPort } from './leave.controller'

function fakePool(overrides: Partial<Pool> = {}): Pool {
  return {
    query: jest.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
    ...overrides,
  } as unknown as Pool
}

function fakeHealthCheck(result: 'up' | 'down' = 'up'): HealthCheckPort {
  return { check: jest.fn().mockResolvedValue(result) }
}

describe('LeaveController — GET /health', () => {
  it('reports ok with db and crypto both up', async () => {
    const controller = new LeaveController(fakePool(), fakeHealthCheck('up'))

    const out = await controller.health()

    expect(out).toMatchObject({
      status: 'ok',
      service: 'svc-leave',
      dependencies: { db: 'up', crypto: 'up' },
    })
  })

  it('reports degraded — not a crash — when db is down', async () => {
    const pool = fakePool({ query: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as Pool['query'] })
    const controller = new LeaveController(pool, fakeHealthCheck('up'))

    const out = await controller.health()

    expect(out).toMatchObject({ status: 'degraded', dependencies: { db: 'down', crypto: 'up' } })
  })

  it('reports degraded — not a crash — when crypto is down', async () => {
    const controller = new LeaveController(fakePool(), fakeHealthCheck('down'))

    const out = await controller.health()

    expect(out).toMatchObject({ status: 'degraded', dependencies: { db: 'up', crypto: 'down' } })
  })

  it('reports degraded when every dependency is down simultaneously', async () => {
    const downPool = fakePool({ query: jest.fn().mockRejectedValue(new Error('down')) as unknown as Pool['query'] })
    const controller = new LeaveController(downPool, fakeHealthCheck('down'))

    const out = await controller.health()

    expect(out).toMatchObject({ status: 'degraded', dependencies: { db: 'down', crypto: 'down' } })
  })
})
