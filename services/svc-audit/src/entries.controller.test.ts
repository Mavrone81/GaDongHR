import 'reflect-metadata'
import { APP_GUARD } from '@nestjs/core'
import { PERMISSION_METADATA_KEY } from '@gadong/kernel'
import type { Pool } from 'pg'
import { EntriesController, DB_POOL } from './entries.controller'
import { AppModule } from './app.module'
import type { EntriesService } from './entries.service'
import type { VerifyResult } from './chain'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/** A minimal `pg.Pool` double, matching `services/svc-config`'s `rules.controller.test.ts` pattern. */
function fakePool(overrides: Partial<Pool> = {}): Pool {
  const client = { query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() }
  return {
    connect: jest.fn().mockResolvedValue(client),
    query: jest.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
    ...overrides,
  } as unknown as Pool
}

type FakeEntriesService = Pick<EntriesService, 'list' | 'verify'>
function fakeEntriesService(overrides: Partial<FakeEntriesService> = {}): EntriesService {
  const base: FakeEntriesService = {
    list: jest.fn().mockResolvedValue({ entries: [], page: 1 }),
    verify: jest.fn().mockResolvedValue({ valid: true, entryCount: 0, issues: [] } satisfies VerifyResult),
    ...overrides,
  }
  return base as EntriesService
}

describe('EntriesController wiring', () => {
  it('GET /entries forwards query params to EntriesService.list', async () => {
    const list = jest.fn().mockResolvedValue({ entries: [], page: 2 })
    const controller = new EntriesController(fakeEntriesService({ list }), fakePool())

    await controller.list('employee', 'emp-1', '2026-01-01', '2026-12-31', '2')

    expect(list).toHaveBeenCalledWith({
      entity: 'employee',
      entityId: 'emp-1',
      from: '2026-01-01',
      to: '2026-12-31',
      page: 2,
    })
  })

  it('GET /entries with no query params forwards page undefined', async () => {
    const list = jest.fn().mockResolvedValue({ entries: [], page: 1 })
    const controller = new EntriesController(fakeEntriesService({ list }), fakePool())

    await controller.list()

    expect(list).toHaveBeenCalledWith({ entity: undefined, entityId: undefined, from: undefined, to: undefined, page: undefined })
  })

  it('GET /verify delegates to EntriesService.verify and returns its result verbatim', async () => {
    const result: VerifyResult = { valid: false, entryCount: 3, issues: [{ entryId: '2', kind: 'content_mismatch', message: 'x' }] }
    const verify = jest.fn().mockResolvedValue(result)
    const controller = new EntriesController(fakeEntriesService({ verify }), fakePool())

    const out = await controller.verify()

    expect(out).toEqual(result)
  })

  it('GET /health reports db:up as overall status ok', async () => {
    const controller = new EntriesController(fakeEntriesService(), fakePool())

    const out = await controller.health()

    expect(out).toMatchObject({ status: 'ok', service: 'svc-audit', dependencies: { db: 'up' } })
  })

  it('GET /health reports db:down as overall status degraded when the pool query rejects — not a crash', async () => {
    const pool = fakePool({ query: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as Pool['query'] })
    const controller = new EntriesController(fakeEntriesService(), pool)

    const out = await controller.health()

    expect(out).toMatchObject({ status: 'degraded', dependencies: { db: 'down' } })
  })
})

describe('EntriesController — deny-by-default permission wiring (Task 9 brief API table)', () => {
  const EXPECTED: Record<string, string> = {
    list: 'audit.read',
    verify: 'audit.read',
  }

  it.each(Object.entries(EXPECTED))('%s() declares @RequirePermission(%s)', (method, permission) => {
    const proto = EntriesController.prototype as unknown as Record<string, () => unknown>
    const handler = proto[method]
    if (!handler) throw new Error(`no such handler: ${method}`)
    expect(Reflect.getMetadata(PERMISSION_METADATA_KEY, handler)).toBe(permission)
  })

  it('health() has no @RequirePermission metadata — reachable without a permission', () => {
    const proto = EntriesController.prototype as unknown as Record<string, () => unknown>
    const handler = proto['health']
    if (!handler) throw new Error('no such handler: health')
    expect(Reflect.getMetadata(PERMISSION_METADATA_KEY, handler)).toBeUndefined()
  })

  it('has no class-level @RequirePermission that could mask an unannotated method', () => {
    expect(Reflect.getMetadata(PERMISSION_METADATA_KEY, EntriesController)).toBeUndefined()
  })

  it('declares no write route (no POST/PUT/PATCH/DELETE handler exists on the controller) — entries arrive only by consuming events', () => {
    const proto = EntriesController.prototype as unknown as Record<string, unknown>
    for (const name of ['create', 'update', 'delete', 'remove', 'insert', 'post']) {
      expect(proto[name]).toBeUndefined()
    }
  })
})

describe('AppModule mounts the kernel PermissionGuard (svc-audit is reached by HR admins, auditors, and the DPO console)', () => {
  it('registers an APP_GUARD provider bound to PermissionGuard', () => {
    const providers = (Reflect.getMetadata('providers', AppModule) as unknown[] | undefined) ?? []
    const appGuardEntry = providers.find((p) => isRecord(p) && p['provide'] === APP_GUARD)
    expect(appGuardEntry).toBeDefined()
  })

  it('registers a DB_POOL provider', () => {
    const providers = (Reflect.getMetadata('providers', AppModule) as unknown[] | undefined) ?? []
    const hasDbPool = providers.some((p) => isRecord(p) && p['provide'] === DB_POOL)
    expect(hasDbPool).toBe(true)
  })
})
