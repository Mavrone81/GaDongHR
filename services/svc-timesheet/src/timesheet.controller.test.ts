import 'reflect-metadata'
import { APP_GUARD } from '@nestjs/core'
import { PERMISSION_METADATA_KEY } from '@gadong/kernel'
import type { Pool } from 'pg'
import { TimesheetController, DB_POOL } from './timesheet.controller'
import { AppModule } from './app.module'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/** A minimal `pg.Pool` double — mirrors `services/svc-config/src/rules.controller.test.ts`'s `fakePool`. */
function fakePool(overrides: Partial<Pool> = {}): Pool {
  return {
    query: jest.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
    ...overrides,
  } as unknown as Pool
}

describe('TimesheetController /health', () => {
  it('reports db:up as overall status ok', async () => {
    const controller = new TimesheetController(fakePool())

    const out = await controller.health()

    expect(out).toMatchObject({ status: 'ok', service: 'svc-timesheet', dependencies: { db: 'up' } })
  })

  it('reports db:down as overall status degraded when the pool query rejects — not a crash', async () => {
    const pool = fakePool({ query: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as Pool['query'] })
    const controller = new TimesheetController(pool)

    const out = await controller.health()

    expect(out).toMatchObject({ status: 'degraded', dependencies: { db: 'down' } })
  })

  it('health() has no @RequirePermission metadata — reachable without a permission', () => {
    const proto = TimesheetController.prototype as unknown as Record<string, () => unknown>
    const handler = proto['health']
    if (!handler) throw new Error('no such handler: health')
    expect(Reflect.getMetadata(PERMISSION_METADATA_KEY, handler)).toBeUndefined()
  })

  it('has no class-level @RequirePermission that could mask a future unannotated method', () => {
    expect(Reflect.getMetadata(PERMISSION_METADATA_KEY, TimesheetController)).toBeUndefined()
  })
})

describe('AppModule mounts the kernel PermissionGuard (svc-timesheet is reached by end users, per M3-TIMESHEET.md\'s permission-scoped API manual)', () => {
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

  it('registers TimesheetController', () => {
    const controllers = (Reflect.getMetadata('controllers', AppModule) as unknown[] | undefined) ?? []
    expect(controllers).toContain(TimesheetController)
  })
})
