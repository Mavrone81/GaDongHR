import type { Pool } from 'pg'
import { writeOutbox } from '@gadong/kernel'
import { AttendanceController } from './attendance.controller'
import type { HealthCheckPort } from './attendance.controller'
import { FakeAttendanceDb } from './testing/fake-attendance-db'

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

  it('reports outbox depth (event-bus health/metrics) — a fresh, undrained row is visible but not yet "stale"', async () => {
    const db = new FakeAttendanceDb()
    const tx = db.connect()
    await writeOutbox(tx, 'attendance', 'attendance.punch', { punchId: 'p1' })

    const controller = new AttendanceController(db.asPool() as unknown as Pool, fakeHealthCheck('up'), fakeHealthCheck('up'))
    const out = await controller.health()

    expect(out.outbox).toMatchObject({ pending: 1, stale: false })
    expect(out.status).toBe('ok') // freshly-written, well under the staleness threshold
  })

  it('degrades — and reports `outboxQuery: down` — when the outbox table cannot be read', async () => {
    const pool = fakePool({
      query: jest.fn((sql: string) => {
        if (/count\(\*\)/i.test(sql)) return Promise.reject(new Error('relation "attendance.outbox" does not exist'))
        return Promise.resolve({ rows: [{ '?column?': 1 }] })
      }) as unknown as Pool['query'],
    })
    const controller = new AttendanceController(pool, fakeHealthCheck('up'), fakeHealthCheck('up'))

    const out = await controller.health()

    expect(out).toMatchObject({ status: 'degraded', dependencies: { db: 'up', crypto: 'up', face_engine: 'up', outboxQuery: 'down' } })
  })
})
