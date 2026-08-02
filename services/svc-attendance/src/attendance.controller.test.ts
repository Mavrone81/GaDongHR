import type { Pool } from 'pg'
import { AttendanceController } from './attendance.controller'
import type { HealthCheckPort } from './attendance.controller'

function fakePool(overrides: Partial<Pool> = {}): Pool {
  return {
    query: jest.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
    ...overrides,
  } as unknown as Pool
}

function fakeHealthCheck(result: 'up' | 'down' = 'up'): HealthCheckPort {
  return { check: jest.fn().mockResolvedValue(result) }
}

describe('AttendanceController — GET /health', () => {
  it('reports ok with db, crypto and face_engine all up', async () => {
    const controller = new AttendanceController(fakePool(), fakeHealthCheck('up'), fakeHealthCheck('up'))

    const out = await controller.health()

    expect(out).toMatchObject({
      status: 'ok',
      service: 'svc-attendance',
      dependencies: { db: 'up', crypto: 'up', face_engine: 'up' },
    })
  })

  it('reports degraded — not a crash — when db is down', async () => {
    const pool = fakePool({ query: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as Pool['query'] })
    const controller = new AttendanceController(pool, fakeHealthCheck('up'), fakeHealthCheck('up'))

    const out = await controller.health()

    expect(out).toMatchObject({ status: 'degraded', dependencies: { db: 'down', crypto: 'up', face_engine: 'up' } })
  })

  it('reports degraded — not a crash — when crypto is down', async () => {
    const controller = new AttendanceController(fakePool(), fakeHealthCheck('down'), fakeHealthCheck('up'))

    const out = await controller.health()

    expect(out).toMatchObject({ status: 'degraded', dependencies: { db: 'up', crypto: 'down', face_engine: 'up' } })
  })

  it('reports degraded — not a crash — when face_engine is down', async () => {
    const controller = new AttendanceController(fakePool(), fakeHealthCheck('up'), fakeHealthCheck('down'))

    const out = await controller.health()

    expect(out).toMatchObject({ status: 'degraded', dependencies: { db: 'up', crypto: 'up', face_engine: 'down' } })
  })

  it('reports degraded when every dependency is down simultaneously', async () => {
    const downPool = fakePool({ query: jest.fn().mockRejectedValue(new Error('down')) as unknown as Pool['query'] })
    const controller = new AttendanceController(downPool, fakeHealthCheck('down'), fakeHealthCheck('down'))

    const out = await controller.health()

    expect(out).toMatchObject({ status: 'degraded', dependencies: { db: 'down', crypto: 'down', face_engine: 'down' } })
  })
})
