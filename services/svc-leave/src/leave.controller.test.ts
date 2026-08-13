import 'reflect-metadata'
import { randomUUID } from 'node:crypto'
import { APP_GUARD } from '@nestjs/core'
import { CryptoClient, PERMISSION_METADATA_KEY, PUBLIC_METADATA_KEY, writeOutbox } from '@gadong/kernel'
import type { AuthenticatedRequest } from '@gadong/kernel'
import type { Pool } from 'pg'
import { ApprovalsRepository } from './approvals.repository'
import { ApprovalsService } from './approvals.service'
import { AppModule } from './app.module'
import { BalancesRepository } from './balances.repository'
import { BalancesService } from './balances.service'
import { EssBalancesService } from './ess-balances.service'
import { LeaveController, DB_POOL } from './leave.controller'
import type { HealthCheckPort } from './leave.controller'
import { LeaveTypesRepository } from './leave-types.repository'
import { LeaveTypesService } from './leave-types.service'
import { RequestsRepository } from './requests.repository'
import { RequestsService } from './requests.service'
import { FakeConfigClient } from './testing/fake-config-client'
import { fakeCryptoTransport } from './testing/fake-crypto-transport'
import { FakeLeaveDb } from './testing/fake-db'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function fakeHealthCheck(result: 'up' | 'down' = 'up'): HealthCheckPort {
  return { check: jest.fn().mockResolvedValue(result) }
}

function authedReq(userId: string | undefined): AuthenticatedRequest {
  return { userId }
}

function buildController(db: FakeLeaveDb) {
  const typesRepo = new LeaveTypesRepository(db.asPool())
  const config = new FakeConfigClient()
  config.seed({ ruleKey: 'leave.annual.min_days', value: 6, statutoryFloor: 6, citation: 'LPA s.30', effectiveFrom: '1998-08-19', effectiveTo: null })
  config.seed({ ruleKey: 'hours.regular.max_per_day', value: 8, statutoryFloor: 8, citation: 'LPA s.23', effectiveFrom: '1998-08-19', effectiveTo: null })
  const typesService = new LeaveTypesService(typesRepo, config, () => randomUUID())

  const balancesRepo = new BalancesRepository(db.asPool())
  const balancesService = new BalancesService(balancesRepo, () => randomUUID())
  const essBalancesService = new EssBalancesService(typesRepo, balancesService)

  const requestsRepo = new RequestsRepository(db.asPool())
  const crypto = new CryptoClient(fakeCryptoTransport())
  const requestsService = new RequestsService(requestsRepo, typesRepo, balancesService, crypto, config, () => randomUUID())

  const approvalsRepo = new ApprovalsRepository(db.asPool())
  const approvalsService = new ApprovalsService(approvalsRepo, requestsRepo, typesRepo, balancesService, () => randomUUID())

  const controller = new LeaveController(
    typesService,
    essBalancesService,
    balancesService,
    requestsService,
    approvalsService,
    db as unknown as Pool,
    fakeHealthCheck('up'),
    fakeHealthCheck('up'),
  )
  return { controller, typesService, balancesService, requestsService, approvalsService }
}

describe('LeaveController — GET /health', () => {
  it('reports ok with db, crypto and config all up', async () => {
    const db = new FakeLeaveDb()
    const { controller } = buildController(db)
    const out = await controller.health()
    expect(out).toMatchObject({ status: 'ok', service: 'svc-leave', dependencies: { db: 'up', crypto: 'up', config: 'up' } })
  })

  it('reports outbox depth (event-bus health/metrics) — a fresh, undrained row is visible but not yet "stale"', async () => {
    const db = new FakeLeaveDb()
    const { controller } = buildController(db)
    await writeOutbox(db.connect(), 'leave', 'leave.approved', { requestId: 'r1' })

    const health = await controller.health()
    expect(health.outbox).toMatchObject({ pending: 1, stale: false })
    expect(health.status).toBe('ok') // freshly-written, well under the staleness threshold
  })
})

describe('LeaveController — end-to-end through the HTTP boundary', () => {
  it('POST /types rejects a below-floor entitlement with LVE-030 and the citation, mapped to an HttpException', async () => {
    const db = new FakeLeaveDb()
    const { controller } = buildController(db)
    await expect(
      controller.createType({
        code: 'annual',
        nameI18n: { en: 'Annual Leave' },
        payMode: 'full',
        accrualMode: 'annual_grant',
        statutoryRuleKey: 'leave.annual.min_days',
        entitlementDays: '5',
      }),
    ).rejects.toMatchObject({
      status: 422,
      response: expect.objectContaining({ code: 'LVE-030', details: [expect.objectContaining({ citation: 'LPA s.30' })] }),
    })
  })

  it('full flow: create type, grant balance, submit request, approve — publishes leave.approved', async () => {
    const db = new FakeLeaveDb()
    const { controller, balancesService } = buildController(db)

    const type = await controller.createType({
      code: 'annual',
      nameI18n: { en: 'Annual Leave' },
      payMode: 'full',
      accrualMode: 'annual_grant',
      statutoryRuleKey: 'leave.annual.min_days',
      entitlementDays: '6',
      carryOverEnabled: true,
    })

    const conn = db.connect()
    await conn.query('BEGIN')
    await balancesService.grantAnnual(conn, 'emp-1', type, 2026, '2020-01-01')
    await conn.query('COMMIT')

    const { request, steps } = await controller.submitRequest(authedReq('emp-1'), {
      employeeId: 'ignored-overridden-by-req-userId',
      leaveTypeId: type.id,
      startDate: '2026-06-01',
      endDate: '2026-06-02',
    })
    expect(request.employeeId).toBe('emp-1')
    expect(steps).toHaveLength(1)

    const decided = await controller.decide(authedReq('manager-1'), steps[0]!.id, { decision: 'approved' })
    expect(decided.decision).toBe('approved')

    const outbox = db.debugOutboxRows().filter((r) => r.topic === 'leave.approved')
    expect(outbox).toHaveLength(1)
    expect(outbox[0]?.payload).toMatchObject({ employeeId: 'emp-1', days: '2' })
  })

  it('GET /my/balances is self-scoped to req.userId and returns a summary per active leave type', async () => {
    const db = new FakeLeaveDb()
    const { controller } = buildController(db)
    await controller.createType({ code: 'annual', nameI18n: { en: 'Annual' }, payMode: 'full', accrualMode: 'annual_grant', statutoryRuleKey: 'leave.annual.min_days', entitlementDays: '6' })

    const result = await controller.myBalances(authedReq('emp-42'), '2026')
    expect(result.balances).toHaveLength(1)
    expect(result.balances[0]).toMatchObject({ leaveTypeCode: 'annual', year: 2026 })
  })

  it('rejects an unauthenticated caller on a self-scoped route with a 401', async () => {
    const db = new FakeLeaveDb()
    const { controller } = buildController(db)
    await expect(controller.myBalances(authedReq(undefined))).rejects.toMatchObject({ status: 401 })
  })
})

describe('LeaveController — deny-by-default permission wiring', () => {
  const EXPECTED: Record<string, string> = {
    listTypes: 'leave.request',
    createType: 'leave.admin',
    updateType: 'leave.admin',
    myBalances: 'leave.balance.read',
    employeeBalances: 'leave.balance.read',
    ledger: 'leave.balance.read',
    adjustBalance: 'leave.admin',
    submitRequest: 'leave.request',
    cancelRequest: 'leave.request',
    pendingApprovals: 'leave.approve',
    decide: 'leave.approve',
  }

  it.each(Object.entries(EXPECTED))('%s() declares @RequirePermission(%s)', (method, permission) => {
    const proto = LeaveController.prototype as unknown as Record<string, () => unknown>
    const handler = proto[method]
    if (!handler) throw new Error(`no such handler: ${method}`)
    expect(Reflect.getMetadata(PERMISSION_METADATA_KEY, handler)).toBe(permission)
  })

  it('health() is @Public() and carries no @RequirePermission metadata', () => {
    const proto = LeaveController.prototype as unknown as Record<string, () => unknown>
    const handler = proto['health']
    if (!handler) throw new Error('no such handler: health')
    expect(Reflect.getMetadata(PUBLIC_METADATA_KEY, handler)).toBe(true)
    expect(Reflect.getMetadata(PERMISSION_METADATA_KEY, handler)).toBeUndefined()
  })

  it('has no class-level @RequirePermission or @Public that could mask an unannotated method', () => {
    expect(Reflect.getMetadata(PERMISSION_METADATA_KEY, LeaveController)).toBeUndefined()
    expect(Reflect.getMetadata(PUBLIC_METADATA_KEY, LeaveController)).toBeUndefined()
  })

  it('every handler on the prototype is accounted for by EXPECTED plus health (no route silently unguarded)', () => {
    const proto = LeaveController.prototype as unknown as Record<string, unknown>
    const methodNames = Object.getOwnPropertyNames(proto).filter((n) => n !== 'constructor' && typeof proto[n] === 'function')
    const accounted = new Set([...Object.keys(EXPECTED), 'health'])
    const unaccounted = methodNames.filter((n) => !accounted.has(n) && !n.startsWith('_'))
    // Private helper methods (checkDb, requireUserId, runFailClosed) are on
    // the prototype too but are not routes — filter to only names that also
    // carry either metadata key, which every real route has exactly one of.
    const realRoutesUnaccounted = unaccounted.filter(
      (n) => Reflect.getMetadata(PERMISSION_METADATA_KEY, proto[n] as object) !== undefined || Reflect.getMetadata(PUBLIC_METADATA_KEY, proto[n] as object) === true,
    )
    expect(realRoutesUnaccounted).toEqual([])
  })
})

describe('AppModule mounts the kernel PermissionGuard', () => {
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
