import 'reflect-metadata'
import { HttpException } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { GadongError, PERMISSION_METADATA_KEY } from '@gadong/kernel'
import type { Pool } from 'pg'
import { RulesController, DB_POOL } from './rules.controller'
import { AppModule } from './app.module'
import type { RulesService } from './rules.service'
import type { PacksService } from './packs.service'
import type { StatutoryRuleRow } from './rules.repository'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function fakeRow(overrides: Partial<StatutoryRuleRow> = {}): StatutoryRuleRow {
  return {
    id: 'rule-1',
    ruleKey: 'leave.annual.min_days',
    value: 6,
    unit: 'days',
    statutoryFloor: 6,
    statutoryCeiling: null,
    citation: 'LPA s.30',
    effectiveFrom: '1998-08-19',
    effectiveTo: null,
    governanceClass: 'STATUTORY_FLOOR',
    status: 'active',
    proposedBy: null,
    approvedBy: null,
    reason: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

/** A minimal `pg.Pool` double: `connect()` returns a client whose `query`/`release` are harmless no-ops, sufficient because the faked services below never actually issue SQL through the `tx` they're handed. */
function fakePool(overrides: Partial<Pool> = {}): Pool {
  const client = { query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() }
  return {
    connect: jest.fn().mockResolvedValue(client),
    query: jest.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
    ...overrides,
  } as unknown as Pool
}

type FakeRulesService = Pick<RulesService, 'getEffective' | 'listCurrent' | 'propose' | 'approve'>
function fakeRulesService(overrides: Partial<FakeRulesService> = {}): RulesService {
  const base: FakeRulesService = {
    getEffective: jest.fn().mockResolvedValue(fakeRow()),
    listCurrent: jest.fn().mockResolvedValue([fakeRow()]),
    propose: jest.fn().mockResolvedValue(fakeRow({ status: 'draft' })),
    approve: jest.fn().mockResolvedValue(fakeRow({ status: 'active' })),
    ...overrides,
  }
  return base as RulesService
}

type FakePacksService = Pick<PacksService, 'importPack'>
function fakePacksService(overrides: Partial<FakePacksService> = {}): PacksService {
  const base: FakePacksService = {
    importPack: jest.fn().mockResolvedValue({ packId: 'TH-STATUTORY-v1', version: 1, status: 'imported', ruleCount: 1 }),
    ...overrides,
  }
  return base as PacksService
}

describe('RulesController wiring', () => {
  it('GET /rules/:key forwards key and the "on" query param', async () => {
    const getEffective = jest.fn().mockResolvedValue(fakeRow())
    const controller = new RulesController(fakeRulesService({ getEffective }), fakePacksService(), fakePool())

    const out = await controller.getOne('leave.annual.min_days', '2026-06-01')

    expect(getEffective).toHaveBeenCalledWith('leave.annual.min_days', '2026-06-01')
    expect(out).toMatchObject({ ruleKey: 'leave.annual.min_days' })
  })

  it('GET /rules/:key with no "on" forwards undefined (service defaults to today)', async () => {
    const getEffective = jest.fn().mockResolvedValue(fakeRow())
    const controller = new RulesController(fakeRulesService({ getEffective }), fakePacksService(), fakePool())

    await controller.getOne('leave.annual.min_days')

    expect(getEffective).toHaveBeenCalledWith('leave.annual.min_days', undefined)
  })

  it('GET /rules forwards prefix and wraps the result as { rules }', async () => {
    const listCurrent = jest.fn().mockResolvedValue([fakeRow(), fakeRow({ ruleKey: 'leave.sick.paid_days' })])
    const controller = new RulesController(fakeRulesService({ listCurrent }), fakePacksService(), fakePool())

    const out = await controller.list('leave.')

    expect(listCurrent).toHaveBeenCalledWith('leave.')
    expect(out.rules).toHaveLength(2)
  })

  it('GET /rules with no prefix passes an empty string', async () => {
    const listCurrent = jest.fn().mockResolvedValue([])
    const controller = new RulesController(fakeRulesService({ listCurrent }), fakePacksService(), fakePool())

    await controller.list()

    expect(listCurrent).toHaveBeenCalledWith('')
  })

  it('POST /rules opens a transaction and forwards the body to RulesService.propose', async () => {
    const propose = jest.fn().mockResolvedValue(fakeRow({ status: 'draft' }))
    const controller = new RulesController(fakeRulesService({ propose }), fakePacksService(), fakePool())
    const body = {
      ruleKey: 'leave.annual.min_days',
      value: 8,
      unit: 'days',
      statutoryFloor: 6,
      citation: 'LPA s.30',
      effectiveFrom: '2027-01-01',
      governanceClass: 'STATUTORY_FLOOR' as const,
      reason: 'policy',
      proposedBy: 'hr-admin-1',
    }

    const out = await controller.propose(body)

    expect(propose).toHaveBeenCalledWith(expect.anything(), body)
    expect(out).toMatchObject({ status: 'draft' })
  })

  it('POST /rules/:id/approve forwards id and approvedBy', async () => {
    const approve = jest.fn().mockResolvedValue(fakeRow({ status: 'active', approvedBy: 'compliance-1' }))
    const controller = new RulesController(fakeRulesService({ approve }), fakePacksService(), fakePool())

    const out = await controller.approve('rule-1', { approvedBy: 'compliance-1' })

    expect(approve).toHaveBeenCalledWith(expect.anything(), 'rule-1', 'compliance-1')
    expect(out).toMatchObject({ status: 'active', approvedBy: 'compliance-1' })
  })

  it('POST /packs/import forwards the signed pack body', async () => {
    const importPack = jest.fn().mockResolvedValue({ packId: 'TH-STATUTORY-v1', version: 1, status: 'imported', ruleCount: 40 })
    const controller = new RulesController(fakeRulesService(), fakePacksService({ importPack }), fakePool())
    const pack = { pack_id: 'TH-STATUTORY-v1', version: 1, signature: 'sig', records: [] }

    const out = await controller.importPack(pack)

    expect(importPack).toHaveBeenCalledWith(expect.anything(), pack)
    expect(out).toMatchObject({ status: 'imported', ruleCount: 40 })
  })

  it('GET /health reports db:up as overall status ok', async () => {
    const controller = new RulesController(fakeRulesService(), fakePacksService(), fakePool())

    const out = await controller.health()

    expect(out).toMatchObject({ status: 'ok', service: 'svc-config', dependencies: { db: 'up' } })
  })

  it('GET /health reports db:down as overall status degraded when the pool query rejects — not a crash', async () => {
    const pool = fakePool({ query: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as Pool['query'] })
    const controller = new RulesController(fakeRulesService(), fakePacksService(), pool)

    const out = await controller.health()

    expect(out).toMatchObject({ status: 'degraded', dependencies: { db: 'down' } })
  })

  it('maps a thrown GadongError (e.g. CFG-422) to an HttpException carrying the error envelope, code, and citation', async () => {
    const err = new GadongError('CFG-422', 'config.error.below_statutory_floor', 422, [
      { ruleKey: 'leave.annual.min_days', value: 4, statutoryFloor: 6, citation: 'LPA s.30' },
    ])
    const propose = jest.fn().mockRejectedValue(err)
    const controller = new RulesController(fakeRulesService({ propose }), fakePacksService(), fakePool())

    try {
      await controller.propose({
        ruleKey: 'leave.annual.min_days',
        value: 4,
        unit: 'days',
        statutoryFloor: 6,
        citation: 'LPA s.30',
        effectiveFrom: '2027-01-01',
        governanceClass: 'STATUTORY_FLOOR',
        reason: 'x',
        proposedBy: 'hr-admin-1',
      })
      throw new Error('expected rejection')
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(HttpException)
      const httpErr = thrown as HttpException
      expect(httpErr.getStatus()).toBe(422)
      expect(httpErr.getResponse()).toMatchObject({
        code: 'CFG-422',
        details: [expect.objectContaining({ citation: 'LPA s.30' })],
      })
    }
  })
})

describe('RulesController — deny-by-default permission wiring (Task 7 brief §2 table)', () => {
  const EXPECTED: Record<string, string> = {
    getOne: 'config.rule.read',
    list: 'config.rule.read',
    propose: 'config.rule.propose',
    approve: 'config.rule.approve',
    importPack: 'config.pack.import',
  }

  it.each(Object.entries(EXPECTED))('%s() declares @RequirePermission(%s)', (method, permission) => {
    const proto = RulesController.prototype as unknown as Record<string, () => unknown>
    const handler = proto[method]
    if (!handler) throw new Error(`no such handler: ${method}`)
    expect(Reflect.getMetadata(PERMISSION_METADATA_KEY, handler)).toBe(permission)
  })

  it('health() has no @RequirePermission metadata — reachable without a permission, per the brief', () => {
    const proto = RulesController.prototype as unknown as Record<string, () => unknown>
    const handler = proto['health']
    if (!handler) throw new Error('no such handler: health')
    expect(Reflect.getMetadata(PERMISSION_METADATA_KEY, handler)).toBeUndefined()
  })

  it('has no class-level @RequirePermission that could mask an unannotated method', () => {
    expect(Reflect.getMetadata(PERMISSION_METADATA_KEY, RulesController)).toBeUndefined()
  })
})

describe('AppModule mounts the kernel PermissionGuard (unlike svc-crypto — svc-config is reached by end users)', () => {
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
