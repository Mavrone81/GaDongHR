import 'reflect-metadata'
import type { Pool } from 'pg'
import { CryptoClient, PERMISSION_METADATA_KEY, PUBLIC_METADATA_KEY } from '@gadong/kernel'
import { ClaimsController } from './claims.controller'
import type { HealthCheckPort } from './claims.controller'
import { ClaimTypesRepository } from './claim-types.repository'
import { ClaimTypesService } from './claim-types.service'
import { ApprovalBandsRepository } from './approval-bands.repository'
import { ApprovalBandsService } from './approval-bands.service'
import { ClaimsRepository } from './claims.repository'
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

    const result = await controller.submit({
      employeeId: 'emp-1',
      claimTypeCode: 'travel',
      claimDate: '2026-08-01',
      vendor: 'BTS',
      amountThb: '500.00',
      receipts: [{ fileRef: 'storage-key-1' }],
    })

    expect(result.claim.status).toBe('pending')

    const { claims } = await controller.myClaims('emp-1')
    expect(claims).toHaveLength(1)
    expect(claims[0]?.id).toBe(result.claim.id)
  })
})
