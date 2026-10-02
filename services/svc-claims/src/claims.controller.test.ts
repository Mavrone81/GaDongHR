import 'reflect-metadata'
import type { Pool } from 'pg'
import { HttpException } from '@nestjs/common'
import { CryptoClient, PERMISSION_METADATA_KEY, PUBLIC_METADATA_KEY } from '@gadong/kernel'
import { ClaimsController } from './claims.controller'
import type { HealthCheckPort } from './claims.controller'
import { ClaimTypesRepository } from './claim-types.repository'
import { ClaimTypesService } from './claim-types.service'
import { ApprovalBandsRepository } from './approval-bands.repository'
import { ApprovalBandsService } from './approval-bands.service'
import { ClaimsRepository } from './claims.repository'
import type { ClaimRow } from './claims.repository'
import { ClaimsService } from './claims.service'
import { FakeClaimsDb } from './testing/fake-db'
import { fakeCryptoTransport } from './testing/fake-crypto-transport'

function fakePool(overrides: Partial<Pool> = {}): Pool {
  return {
    query: jest.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
    ...overrides,
  } as unknown as Pool
}

function fakeHealthCheck(result: 'up' | 'down' = 'up'): HealthCheckPort {
  return { check: jest.fn().mockResolvedValue(result) }
}

/** Same shape as `services/svc-onboarding`'s `employee.controller.test.ts`'s `reqWith` — the minimal `AuthenticatedRequest` fake every derive-from-token test needs. `authzScope` defaults to `'self'`, the real default an ordinary `claim.submit` grant resolves to (kernel `authz.service.ts`'s "no org_scope_unit_id → 'self'"), not `'*'` — a test that defaults to `'*'` would never exercise the scope check it's supposed to prove. */
function reqWith(userId?: string, authzScope: string[] | '*' | 'self' = 'self'): { userId?: string; authzScope?: string[] | '*' | 'self' } {
  const r: { userId?: string; authzScope?: string[] | '*' | 'self' } = { authzScope }
  if (userId !== undefined) r.userId = userId
  return r
}

function makeController(pool: Pool = fakePool(), health: HealthCheckPort = fakeHealthCheck()): ClaimsController {
  const db = new FakeClaimsDb()
  db.seedDefaultApprovalBands()
  const claimTypesService = new ClaimTypesService(new ClaimTypesRepository(db.asPool()))
  const approvalBandsService = new ApprovalBandsService(new ApprovalBandsRepository(db.asPool()))
  const claimsService = new ClaimsService(
    new ClaimsRepository(db.asPool()),
    new ClaimTypesRepository(db.asPool()),
    approvalBandsService,
    new CryptoClient(fakeCryptoTransport()),
  )
  return new ClaimsController(claimTypesService, approvalBandsService, claimsService, pool, health)
}

describe('ClaimsController — GET /health', () => {
  it('reports ok with db and crypto both up', async () => {
    const controller = makeController(fakePool(), fakeHealthCheck('up'))

    const out = await controller.health()

    expect(out).toMatchObject({
      status: 'ok',
      service: 'svc-claims',
      dependencies: { db: 'up', crypto: 'up' },
    })
  })

  it('reports degraded — not a crash — when db is down', async () => {
    const pool = fakePool({ query: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as Pool['query'] })
    const controller = makeController(pool, fakeHealthCheck('up'))

    const out = await controller.health()

    expect(out).toMatchObject({ status: 'degraded', dependencies: { db: 'down', crypto: 'up' } })
  })

  it('reports degraded — not a crash — when crypto is down', async () => {
    const controller = makeController(fakePool(), fakeHealthCheck('down'))

    const out = await controller.health()

    expect(out).toMatchObject({ status: 'degraded', dependencies: { db: 'up', crypto: 'down' } })
  })

  it('reports degraded when every dependency is down simultaneously', async () => {
    const downPool = fakePool({ query: jest.fn().mockRejectedValue(new Error('down')) as unknown as Pool['query'] })
    const controller = makeController(downPool, fakeHealthCheck('down'))

    const out = await controller.health()

    expect(out).toMatchObject({ status: 'degraded', dependencies: { db: 'down', crypto: 'down' } })
    // `outboxQuery: 'down'` too — the same rejecting pool answers the
    // event-bus outbox-depth query (event-bus task) no better than
    // `SELECT 1`, so it correctly shows up as its own down dependency
    // rather than being silently skipped.
    expect(out.dependencies).toEqual({ db: 'down', crypto: 'down', outboxQuery: 'down' })
  })

  it('reports outbox depth (event-bus health/metrics) — a fresh, undrained row is visible but not yet "stale"', async () => {
    const pool = fakePool({
      query: jest.fn().mockImplementation((sql: string) => {
        if (/count\(\*\)/i.test(sql)) return Promise.resolve({ rows: [{ pending: 2, oldest_age_seconds: 5 }] })
        return Promise.resolve({ rows: [{ '?column?': 1 }] })
      }) as unknown as Pool['query'],
    })
    const controller = makeController(pool, fakeHealthCheck('up'))

    const out = await controller.health()

    expect(out.status).toBe('ok') // pending rows well under the staleness threshold
    expect(out.outbox).toEqual({ pending: 2, oldestAgeSeconds: 5, stale: false })
  })
})

/**
 * Task 14 brief CONSTRAINTS: "Every route declares one permission except
 * `/health` (`@Public()`)." Deny-by-default is structural in
 * `PermissionGuard` (kernel) for anything that skips this — this suite
 * proves the CONTROLLER side of that contract holds for every route this
 * task adds, the same way `packages/kernel/src/authz/public-routes.audit.test.ts`
 * reconciles the declared set globally.
 */
describe('ClaimsController — every route declares exactly one permission, except /health which is @Public', () => {
  const routeHandlers: Array<{ name: keyof ClaimsController; expectedPublic: boolean; expectedPermission?: string }> = [
    { name: 'listTypes', expectedPublic: false, expectedPermission: 'claim.submit' },
    { name: 'getType', expectedPublic: false, expectedPermission: 'claim.submit' },
    { name: 'createType', expectedPublic: false, expectedPermission: 'claim.admin' },
    { name: 'updateType', expectedPublic: false, expectedPermission: 'claim.admin' },
    { name: 'listApprovalBands', expectedPublic: false, expectedPermission: 'claim.admin' },
    { name: 'replaceApprovalBands', expectedPublic: false, expectedPermission: 'claim.admin' },
    { name: 'submit', expectedPublic: false, expectedPermission: 'claim.submit' },
    { name: 'myClaims', expectedPublic: false, expectedPermission: 'claim.submit' },
    { name: 'resubmit', expectedPublic: false, expectedPermission: 'claim.submit' },
    { name: 'decideManager', expectedPublic: false, expectedPermission: 'claim.approve' },
    { name: 'decideFinance', expectedPublic: false, expectedPermission: 'claim.approve.finance' },
    { name: 'route', expectedPublic: false, expectedPermission: 'claim.approve.finance' },
    { name: 'health', expectedPublic: true },
  ]

  it.each(routeHandlers)('$name', ({ name, expectedPublic, expectedPermission }) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- reading Nest decorator metadata off the prototype method requires an untyped handler reference; contained to this one reflective test.
    const handler = (ClaimsController.prototype as any)[name] as (...args: unknown[]) => unknown
    const isPublic = (Reflect.getMetadata(PUBLIC_METADATA_KEY, handler) as boolean | undefined) ?? false
    const permission = Reflect.getMetadata(PERMISSION_METADATA_KEY, handler) as string | undefined

    expect(isPublic).toBe(expectedPublic)
    if (expectedPublic) {
      expect(permission).toBeUndefined()
    } else {
      expect(permission).toBe(expectedPermission)
    }
  })

  it('no handler carries BOTH @Public and @RequirePermission', () => {
    for (const { name } of routeHandlers) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above.
      const handler = (ClaimsController.prototype as any)[name] as (...args: unknown[]) => unknown
      const isPublic = (Reflect.getMetadata(PUBLIC_METADATA_KEY, handler) as boolean | undefined) ?? false
      const permission = Reflect.getMetadata(PERMISSION_METADATA_KEY, handler) as string | undefined
      expect(isPublic && permission !== undefined).toBe(false)
    }
  })
})

/** A `pg.Pool`-shaped wrapper over `FakeClaimsDb` that supports `withTransaction` (needs `.connect()` returning something `BEGIN`/`COMMIT`-capable) — used only by this suite's end-to-end smoke test, which exercises the controller's own transaction wiring rather than calling a service directly. */
function fakeTransactionalPool(db: FakeClaimsDb): Pool {
  return {
    query: (sql: string, params?: unknown[]) => db.asPool().query(sql, params),
    connect: async () => db.connect(),
  } as unknown as Pool
}

describe('ClaimsController — end-to-end wiring smoke test', () => {
  it('creates a type, submits a claim against it, and lists it back via /my/claims', async () => {
    const db = new FakeClaimsDb()
    db.seedDefaultApprovalBands()
    const claimTypesService = new ClaimTypesService(new ClaimTypesRepository(db.asPool()))
    const approvalBandsService = new ApprovalBandsService(new ApprovalBandsRepository(db.asPool()))
    const claimsService = new ClaimsService(
      new ClaimsRepository(db.asPool()),
      new ClaimTypesRepository(db.asPool()),
      approvalBandsService,
      new CryptoClient(fakeCryptoTransport()),
    )
    const controller = new ClaimsController(
      claimTypesService,
      approvalBandsService,
      claimsService,
      fakeTransactionalPool(db),
      fakeHealthCheck(),
    )

    await controller.createType({
      code: 'travel',
      name: 'Travel',
      receiptRequired: true,
    })

    const result = await controller.submit(
      {
        claimTypeCode: 'travel',
        claimDate: '2026-08-01',
        vendor: 'BTS',
        amountThb: '500.00',
        receipts: [{ fileRef: 'storage-key-1' }],
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- fake request shape, same pattern employee.controller.test.ts uses.
      reqWith('emp-1') as any,
    )

    expect(result.claim.status).toBe('pending')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above.
    const { claims } = await controller.myClaims(reqWith('emp-1') as any, undefined)
    expect(claims).toHaveLength(1)
    expect(claims[0]?.id).toBe(result.claim.id)
  })
})

/**
 * Every route that accepts an `employeeId` resolves it through
 * `resolveEmployeeId`. PARAMETERIZED (`it.each`, not one test per route)
 * so a route added later is exercised the same way as the three here
 * once it's added to `CASES` below — a per-route test would silently
 * stop covering a route nobody's looked at since. Precisely what the
 * `it.each`/denominator pair buys, stated plainly: it catches someone
 * editing `CASES` incorrectly (removing an entry, or a count that
 * doesn't match the list); it does not, by itself, notice a new route
 * added to the controller that was never added to `CASES`. `resolveEmployeeId`
 * runs before any DB call in every one of these handlers, so a bare
 * `makeController()` (no transactional pool) is enough.
 */
describe('ClaimsController — employeeId is always derived from the session, never trusted from the request', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- fake request shape, same pattern employee.controller.test.ts uses throughout this file.
  type FakeReq = any
  type Case = { name: string; call: (controller: ClaimsController, req: FakeReq) => Promise<unknown> }

  const CASES: Case[] = [
    {
      name: 'submit',
      call: (controller, req) => controller.submit({ employeeId: 'emp-2', claimTypeCode: 'travel', claimDate: '2026-08-01', vendor: 'BTS' }, req),
    },
    { name: 'myClaims', call: (controller, req) => controller.myClaims(req, 'emp-2') },
    { name: 'resubmit', call: (controller, req) => controller.resubmit('claim-id-does-not-matter', { employeeId: 'emp-2' }, req) },
  ]

  it.each(CASES)(
    '$name: rejects an employeeId outside the caller\'s claim.submit scope with 403',
    async ({ call }) => {
      const controller = makeController()
      const req = reqWith('emp-1') // authzScope defaults to 'self' — the real default an ordinary claim.submit grant resolves to.

      let caught: unknown
      try {
        await call(controller, req)
      } catch (err) {
        caught = err
      }

      expect(caught).toBeInstanceOf(HttpException)
      expect((caught as HttpException).getStatus()).toBe(403)
      expect((caught as HttpException).getResponse()).toMatchObject({ code: 'CLM-021' })
    },
  )

  it(`denominator check — every route that accepts an employeeId is covered above: ${CASES.length} of 3 (submit, myClaims, resubmit)`, () => {
    expect(CASES.map((c) => c.name).sort()).toEqual(['myClaims', 'resubmit', 'submit'])
  })

  it('does NOT reject when employeeId matches the caller\'s own id, or is omitted entirely — self-service keeps working', async () => {
    const controller = makeController()
    const req = reqWith('emp-1')

    await expect(controller.myClaims(req, 'emp-1')).resolves.toMatchObject({ claims: [] })
    await expect(controller.myClaims(req, undefined)).resolves.toMatchObject({ claims: [] })
  })
})

/**
 * `DecisionBody` has no `approverId` field — TypeScript types are
 * compile-time only, so this suite verifies the runtime behaviour
 * directly rather than relying on the type alone: `claimsService.decide`
 * is spied on (no real DB logic runs), and the fourth argument it's
 * called with is always `req.userId`, independent of any extra field a
 * caller's JSON body happens to carry.
 */
describe('ClaimsController — approverId is always derived from the session, never trusted from the request', () => {
  function makeControllerWithTransactionalPool(): ClaimsController {
    return makeController(fakeTransactionalPool(new FakeClaimsDb()))
  }

  it('decideManager always passes the authenticated caller\'s id as approverId to ClaimsService.decide', async () => {
    const controller = makeControllerWithTransactionalPool()
    const decideSpy = jest.spyOn(ClaimsService.prototype, 'decide').mockResolvedValue({} as unknown as ClaimRow)
    const req = reqWith('manager-1')
    // `as unknown as ...`, not a real `DecisionBody` literal — the type no
    // longer declares `approverId`; this constructs a plain object with an
    // extra field to verify the runtime behaviour independent of the type.
    const bodyWithExtraField = { decision: 'approved', approverId: 'other-id' } as unknown as { decision: 'approved'; comment?: string }

    await controller.decideManager('claim-1', bodyWithExtraField, req)

    expect(decideSpy).toHaveBeenCalledWith(expect.anything(), 'claim-1', 'manager', 'manager-1', 'approved', null)
    decideSpy.mockRestore()
  })

  it('decideFinance always passes the authenticated caller\'s id as approverId to ClaimsService.decide', async () => {
    const controller = makeControllerWithTransactionalPool()
    const decideSpy = jest.spyOn(ClaimsService.prototype, 'decide').mockResolvedValue({} as unknown as ClaimRow)
    const req = reqWith('finance-1')
    const bodyWithExtraField = { decision: 'rejected', comment: 'bad vendor', approverId: 'other-id' } as unknown as {
      decision: 'rejected'
      comment?: string
    }

    await controller.decideFinance('claim-1', bodyWithExtraField, req)

    expect(decideSpy).toHaveBeenCalledWith(expect.anything(), 'claim-1', 'finance', 'finance-1', 'rejected', 'bad vendor')
    decideSpy.mockRestore()
  })
})
