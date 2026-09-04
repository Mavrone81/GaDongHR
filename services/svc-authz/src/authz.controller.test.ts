import 'reflect-metadata'
import { HttpException } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { GadongError, PERMISSION_METADATA_KEY, PermissionGuard } from '@gadong/kernel'
import type { Pool } from 'pg'
import { AuthzController, DB_POOL } from './authz.controller'
import { AppModule } from './app.module'
import type { AuthzService } from './authz.service'
import type { AuthzRepository, RoleRow } from './authz.repository'

// Nest's `@UseGuards()` writes this exact metadata key (`GUARDS_METADATA` in
// `@nestjs/common/constants`, not re-exported from the package root) —
// mirrors how `@gadong/kernel`'s own `guard.ts` documents using the same
// `Reflect`-based mechanism `Reflector` reads.
const GUARDS_METADATA_KEY = '__guards__'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function fakeRole(overrides: Partial<RoleRow> = {}): RoleRow {
  return { id: 'role-1', code: 'hr-officer', nameI18n: { en: 'HR Officer' }, isSystem: true, ...overrides }
}

function fakePool(overrides: Partial<Pool> = {}): Pool {
  const client = { query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() }
  return {
    connect: jest.fn().mockResolvedValue(client),
    query: jest.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
    ...overrides,
  } as unknown as Pool
}

type FakeAuthzService = Pick<AuthzService, 'decide' | 'grantRole' | 'revokeRole' | 'listPermissionsForUser'>
function fakeAuthzService(overrides: Partial<FakeAuthzService> = {}): AuthzService {
  const base: FakeAuthzService = {
    decide: jest.fn().mockResolvedValue({ allowed: true, scopeOrgUnitIds: 'self' }),
    listPermissionsForUser: jest.fn().mockResolvedValue([]),
    grantRole: jest.fn().mockResolvedValue({
      id: 'grant-1',
      userId: 'user-1',
      roleId: 'role-1',
      orgScopeUnitId: null,
      grantedBy: 'admin-1',
      grantedAt: '2026-01-01T00:00:00.000Z',
    }),
    revokeRole: jest.fn().mockResolvedValue(1),
    ...overrides,
  }
  return base as AuthzService
}

type FakeAuthzRepository = Pick<
  AuthzRepository,
  'listRoles' | 'listPermissionCodesForRole' | 'findRoleById' | 'insertUserRole' | 'deleteUserRoleGrants'
>
function fakeAuthzRepo(overrides: Partial<FakeAuthzRepository> = {}): AuthzRepository {
  const base: FakeAuthzRepository = {
    listRoles: jest.fn().mockResolvedValue([fakeRole()]),
    listPermissionCodesForRole: jest.fn().mockResolvedValue(['employee.read']),
    findRoleById: jest.fn().mockResolvedValue(fakeRole()),
    insertUserRole: jest.fn().mockResolvedValue({
      id: 'grant-1',
      userId: 'user-1',
      roleId: 'role-1',
      orgScopeUnitId: null,
      grantedBy: 'admin-1',
      grantedAt: '2026-01-01T00:00:00.000Z',
    }),
    deleteUserRoleGrants: jest.fn().mockResolvedValue(1),
    ...overrides,
  }
  return base as AuthzRepository
}

describe('AuthzController — POST /decide (Task 8 brief §2: no permission, service-to-service)', () => {
  it('forwards {userId, permission} to AuthzService.decide and returns its Decision verbatim', async () => {
    const decide = jest.fn().mockResolvedValue({ allowed: true, scopeOrgUnitIds: ['unit-1'] })
    const controller = new AuthzController(fakeAuthzService({ decide }), fakeAuthzRepo(), fakePool())

    const out = await controller.decide({ userId: 'user-1', permission: 'employee.read' })

    expect(decide).toHaveBeenCalledWith('user-1', 'employee.read')
    expect(out).toEqual({ allowed: true, scopeOrgUnitIds: ['unit-1'] })
  })

  it('a malformed body (missing/wrong-typed fields) resolves to denied without ever calling the service', async () => {
    const decide = jest.fn()
    const controller = new AuthzController(fakeAuthzService({ decide }), fakeAuthzRepo(), fakePool())

    const out = await controller.decide({ userId: 42, permission: 'employee.read' } as unknown as { userId: string; permission: string })

    expect(out).toEqual({ allowed: false, scopeOrgUnitIds: [] })
    expect(decide).not.toHaveBeenCalled()
  })

  it('an unexpected throw from AuthzService.decide resolves to denied — /decide itself never throws (fail closed, belt-and-suspenders over AuthzService\'s own catch)', async () => {
    const decide = jest.fn().mockRejectedValue(new Error('unexpected'))
    const controller = new AuthzController(fakeAuthzService({ decide }), fakeAuthzRepo(), fakePool())

    const out = await controller.decide({ userId: 'user-1', permission: 'employee.read' })

    expect(out).toEqual({ allowed: false, scopeOrgUnitIds: [] })
  })

  it('has no @RequirePermission metadata — guarding /decide would be circular (the guard calls /decide to decide whether the caller may call /decide)', () => {
    const proto = AuthzController.prototype as unknown as Record<string, () => unknown>
    const handler = proto['decide']
    if (!handler) throw new Error('no such handler: decide')
    expect(Reflect.getMetadata(PERMISSION_METADATA_KEY, handler)).toBeUndefined()
  })

  it('has no @UseGuards(PermissionGuard) on /decide — asserted directly, not just inferred from the missing permission', () => {
    const proto = AuthzController.prototype as unknown as Record<string, () => unknown>
    const handler = proto['decide']
    if (!handler) throw new Error('no such handler: decide')
    const guards = (Reflect.getMetadata(GUARDS_METADATA_KEY, handler) as unknown[] | undefined) ?? []
    expect(guards).not.toContain(PermissionGuard)
  })
})

describe('AuthzController — GET /roles (Task 8 brief §2: authz.role.read)', () => {
  it('returns every role with its permission codes attached', async () => {
    const listRoles = jest.fn().mockResolvedValue([fakeRole({ id: 'role-1', code: 'hr-officer' }), fakeRole({ id: 'role-2', code: 'dpo' })])
    const listPermissionCodesForRole = jest.fn().mockResolvedValue(['dpo.console'])
    const controller = new AuthzController(fakeAuthzService(), fakeAuthzRepo({ listRoles, listPermissionCodesForRole }), fakePool())

    const out = await controller.listRoles()

    expect(out.roles).toHaveLength(2)
    expect(out.roles[0]).toMatchObject({ code: 'hr-officer', permissions: ['dpo.console'] })
  })

  it('declares @RequirePermission(authz.role.read) and @UseGuards(PermissionGuard)', () => {
    const proto = AuthzController.prototype as unknown as Record<string, () => unknown>
    const handler = proto['listRoles']
    if (!handler) throw new Error('no such handler: listRoles')
    expect(Reflect.getMetadata(PERMISSION_METADATA_KEY, handler)).toBe('authz.role.read')
    const guards = (Reflect.getMetadata(GUARDS_METADATA_KEY, handler) as unknown[] | undefined) ?? []
    expect(guards).toContain(PermissionGuard)
  })
})

describe('AuthzController — POST /users/:id/roles and DELETE /users/:id/roles/:roleId (authz.role.grant)', () => {
  it('POST grants a role, optionally org-scoped, via a transaction, and records who granted it', async () => {
    const grantRole = jest.fn().mockResolvedValue({
      id: 'grant-1',
      userId: 'user-1',
      roleId: 'role-1',
      orgScopeUnitId: 'chonburi-plant',
      grantedBy: 'admin-1',
      grantedAt: '2026-01-01T00:00:00.000Z',
    })
    const controller = new AuthzController(fakeAuthzService({ grantRole }), fakeAuthzRepo(), fakePool())

    const out = await controller.grantRole({ userId: 'admin-1', actorRole: 'authz_admin' } as never, 'user-1', {
      roleId: 'role-1',
      orgScopeUnitId: 'chonburi-plant',
      grantedBy: 'admin-1',
    })

    expect(grantRole).toHaveBeenCalledWith(
      expect.anything(),
      { userId: 'user-1', roleId: 'role-1', orgScopeUnitId: 'chonburi-plant', grantedBy: 'admin-1' },
      'authz_admin',
    )
    expect(out).toMatchObject({ orgScopeUnitId: 'chonburi-plant' })
  })

  it('POST with no orgScopeUnitId grants a self-scoped role', async () => {
    const grantRole = jest.fn().mockResolvedValue({
      id: 'grant-1',
      userId: 'user-1',
      roleId: 'role-1',
      orgScopeUnitId: null,
      grantedBy: 'admin-1',
      grantedAt: '2026-01-01T00:00:00.000Z',
    })
    const controller = new AuthzController(fakeAuthzService({ grantRole }), fakeAuthzRepo(), fakePool())

    await controller.grantRole({ userId: 'admin-1' } as never, 'user-1', { roleId: 'role-1', grantedBy: 'admin-1' })

    expect(grantRole).toHaveBeenCalledWith(
      expect.anything(),
      { userId: 'user-1', roleId: 'role-1', orgScopeUnitId: null, grantedBy: 'admin-1' },
      'unknown',
    )
  })

  it('POST rejects a roleId that does not exist with AUZ-404, without ever granting', async () => {
    const findRoleById = jest.fn().mockResolvedValue(null)
    const grantRole = jest.fn()
    const controller = new AuthzController(fakeAuthzService({ grantRole }), fakeAuthzRepo({ findRoleById }), fakePool())

    await expect(
      controller.grantRole({ userId: 'admin-1' } as never, 'user-1', { roleId: 'ghost-role', grantedBy: 'admin-1' }),
    ).rejects.toBeInstanceOf(HttpException)
    expect(grantRole).not.toHaveBeenCalled()
  })

  it('DELETE revokes every grant of that role for that user via a transaction, and records who revoked it', async () => {
    const revokeRole = jest.fn().mockResolvedValue(2)
    const controller = new AuthzController(fakeAuthzService({ revokeRole }), fakeAuthzRepo(), fakePool())

    const out = await controller.revokeRole({ userId: 'admin-1', actorRole: 'authz_admin' } as never, 'user-1', 'role-1')

    expect(revokeRole).toHaveBeenCalledWith(expect.anything(), 'user-1', 'role-1', 'admin-1', 'authz_admin')
    expect(out).toEqual({ deleted: 2 })
  })

  it('both declare @RequirePermission(authz.role.grant) and @UseGuards(PermissionGuard)', () => {
    const proto = AuthzController.prototype as unknown as Record<string, () => unknown>
    for (const name of ['grantRole', 'revokeRole']) {
      const handler = proto[name]
      if (!handler) throw new Error(`no such handler: ${name}`)
      expect(Reflect.getMetadata(PERMISSION_METADATA_KEY, handler)).toBe('authz.role.grant')
      const guards = (Reflect.getMetadata(GUARDS_METADATA_KEY, handler) as unknown[] | undefined) ?? []
      expect(guards).toContain(PermissionGuard)
    }
  })
})

describe('AuthzController — GET /health', () => {
  it('reports db:up as overall status ok', async () => {
    const controller = new AuthzController(fakeAuthzService(), fakeAuthzRepo(), fakePool())

    const out = await controller.health()

    expect(out).toMatchObject({ status: 'ok', service: 'svc-authz', dependencies: { db: 'up' } })
  })

  it('reports db:down as overall status degraded when the pool query rejects — not a crash', async () => {
    const pool = fakePool({ query: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as Pool['query'] })
    const controller = new AuthzController(fakeAuthzService(), fakeAuthzRepo(), pool)

    const out = await controller.health()

    expect(out).toMatchObject({ status: 'degraded', dependencies: { db: 'down' } })
  })

  it('has no @RequirePermission metadata', () => {
    const proto = AuthzController.prototype as unknown as Record<string, () => unknown>
    const handler = proto['health']
    if (!handler) throw new Error('no such handler: health')
    expect(Reflect.getMetadata(PERMISSION_METADATA_KEY, handler)).toBeUndefined()
  })
})

describe('AuthzController has no class-level @RequirePermission that could mask an unannotated method', () => {
  it('no metadata on the class itself', () => {
    expect(Reflect.getMetadata(PERMISSION_METADATA_KEY, AuthzController)).toBeUndefined()
  })
})

describe('mapping a thrown GadongError to an HttpException (matches every other controller in this codebase)', () => {
  it('POST /users/:id/roles: AUZ-404 role-not-found maps to a 404 HttpException with the envelope', async () => {
    const err = new GadongError('AUZ-404', 'authz.error.role_not_found', 404, [{ roleId: 'ghost-role' }])
    const findRoleById = jest.fn().mockResolvedValue(null)
    const controller = new AuthzController(fakeAuthzService(), fakeAuthzRepo({ findRoleById }), fakePool())

    try {
      await controller.grantRole({ userId: 'admin-1' } as never, 'user-1', { roleId: 'ghost-role', grantedBy: 'admin-1' })
      throw new Error('expected rejection')
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(HttpException)
      const httpErr = thrown as HttpException
      expect(httpErr.getStatus()).toBe(404)
      expect(httpErr.getResponse()).toMatchObject({ code: 'AUZ-404' })
    }
    void err // documents the shape being asserted against; the controller constructs its own instance
  })
})

/**
 * The Task 8 brief's third guard-mounting pattern: unlike `svc-config`
 * (`APP_GUARD`, every route but `/health` guarded structurally) and
 * `svc-crypto` (no guard at all — service-to-service only), `svc-authz`
 * mixes both kinds of route in one controller. `/decide` cannot be globally
 * guarded (guarding it would ask `/decide` to decide whether the caller may
 * call `/decide`), so `AppModule` does NOT register `PermissionGuard` as
 * `APP_GUARD` — `AuthzController` applies `@UseGuards(PermissionGuard)`
 * per method instead, on exactly the three admin routes.
 */
describe('AppModule does NOT mount PermissionGuard as APP_GUARD (third guard-mounting pattern — see authz.controller.ts)', () => {
  it('registers no APP_GUARD provider', () => {
    const providers = (Reflect.getMetadata('providers', AppModule) as unknown[] | undefined) ?? []
    const hasAppGuard = providers.some((p) => isRecord(p) && p['provide'] === APP_GUARD)
    expect(hasAppGuard).toBe(false)
  })

  it('still registers PermissionGuard as an ordinary provider, for the per-method @UseGuards to resolve', () => {
    const providers = (Reflect.getMetadata('providers', AppModule) as unknown[] | undefined) ?? []
    const hasGuardProvider = providers.some((p) => p === PermissionGuard || (isRecord(p) && p['provide'] === PermissionGuard))
    expect(hasGuardProvider).toBe(true)
  })

  it('registers a DB_POOL provider', () => {
    const providers = (Reflect.getMetadata('providers', AppModule) as unknown[] | undefined) ?? []
    const hasDbPool = providers.some((p) => isRecord(p) && p['provide'] === DB_POOL)
    expect(hasDbPool).toBe(true)
  })
})

describe('AuthzController — GET /me/permissions (the /me-shaped endpoint the PWA needs to gate its nav)', () => {
  function reqWith(userId: string | undefined): Parameters<AuthzController['myPermissions']>[0] {
    return { userId } as Parameters<AuthzController['myPermissions']>[0]
  }

  it("returns the caller's own permission codes", async () => {
    const listPermissionsForUser = jest.fn().mockResolvedValue(['config.rule.read', 'audit.read'])
    const controller = new AuthzController(fakeAuthzService({ listPermissionsForUser }), fakeAuthzRepo(), fakePool())

    const out = await controller.myPermissions(reqWith('user-1'))

    expect(out).toEqual({ permissions: ['config.rule.read', 'audit.read'] })
  })

  it('derives the user id from the verified token, never from anything the caller supplies — this is the whole access control', async () => {
    const listPermissionsForUser = jest.fn().mockResolvedValue([])
    const controller = new AuthzController(fakeAuthzService({ listPermissionsForUser }), fakeAuthzRepo(), fakePool())

    await controller.myPermissions(reqWith('user-from-token'))

    expect(listPermissionsForUser).toHaveBeenCalledWith('user-from-token')
    expect(listPermissionsForUser).toHaveBeenCalledTimes(1)
  })

  it('takes no id parameter at all — a handler arity of 1 (the request) is what makes enumerating another user impossible', () => {
    expect(AuthzController.prototype.myPermissions.length).toBe(1)
  })

  it('401s with AUZ-401 when there is no authenticated principal — this route is unguarded by PermissionGuard, so it must check for itself', async () => {
    const listPermissionsForUser = jest.fn().mockResolvedValue(['config.rule.read'])
    const controller = new AuthzController(fakeAuthzService({ listPermissionsForUser }), fakeAuthzRepo(), fakePool())

    await expect(controller.myPermissions(reqWith(undefined))).rejects.toBeInstanceOf(HttpException)
    await expect(controller.myPermissions(reqWith(undefined))).rejects.toMatchObject({
      response: { code: 'AUZ-401' },
    })
    expect(listPermissionsForUser).not.toHaveBeenCalled()
  })

  it('returns an empty list rather than an error for a user holding no grants — a new account legitimately has none', async () => {
    const listPermissionsForUser = jest.fn().mockResolvedValue([])
    const controller = new AuthzController(fakeAuthzService({ listPermissionsForUser }), fakeAuthzRepo(), fakePool())

    await expect(controller.myPermissions(reqWith('ungranted-user'))).resolves.toEqual({ permissions: [] })
  })

  it('has no @RequirePermission metadata — requiring a permission to discover your permissions is circular, same as /decide', () => {
    const proto = AuthzController.prototype as unknown as Record<string, () => unknown>
    const handler = proto['myPermissions']
    if (!handler) throw new Error('no such handler: myPermissions')
    expect(Reflect.getMetadata(PERMISSION_METADATA_KEY, handler)).toBeUndefined()
  })
})
