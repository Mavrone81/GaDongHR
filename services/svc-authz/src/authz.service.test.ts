import { idempotent } from '@gadong/kernel'
import { AuthzRepository } from './authz.repository'
import { AuthzService } from './authz.service'
import { FakeAuthzDb } from './testing/fake-db'

/** Same three-level fixture as `org-tree.test.ts`, seeded through the repository this time (not the pure function directly). */
async function seedOrgTree(repo: AuthzRepository, conn: ReturnType<FakeAuthzDb['connect']>): Promise<void> {
  await repo.upsertOrgUnit(conn, 'company', null, {}, null)
  await repo.upsertOrgUnit(conn, 'bangkok-region', 'company', {}, null)
  await repo.upsertOrgUnit(conn, 'bangkok-hq', 'bangkok-region', {}, null)
  await repo.upsertOrgUnit(conn, 'chonburi-region', 'company', {}, null)
  await repo.upsertOrgUnit(conn, 'chonburi-office', 'chonburi-region', {}, null)
  await repo.upsertOrgUnit(conn, 'chonburi-warehouse', 'chonburi-region', {}, null)
  await repo.upsertOrgUnit(conn, 'chonburi-plant', 'chonburi-office', {}, null)
  await repo.upsertOrgUnit(conn, 'chonburi-plant-line-a', 'chonburi-plant', {}, null)
  await repo.upsertOrgUnit(conn, 'chonburi-plant-line-b', 'chonburi-plant', {}, null)
}

function setUp() {
  const db = new FakeAuthzDb()
  const conn = db.connect()
  const repo = new AuthzRepository(conn)
  const service = new AuthzService(repo)
  return { db, conn, repo, service }
}

describe('AuthzService.decide — deny by default (Task 8 brief §4, property 1)', () => {
  it('a permission code that is not in the catalog at all denies, never throws, never allows', async () => {
    const { service } = setUp()

    const decision = await service.decide('user-1', 'not.a.real.permission')

    expect(decision).toEqual({ allowed: false, scopeOrgUnitIds: [] })
  })

  it('a known permission with no grant for this user denies', async () => {
    const { conn, repo, service } = setUp()
    await repo.upsertPermission(conn, 'employee.read', 'x')

    const decision = await service.decide('user-1', 'employee.read')

    expect(decision).toEqual({ allowed: false, scopeOrgUnitIds: [] })
  })

  it('a grant for a DIFFERENT permission does not leak an allow onto the one actually asked about', async () => {
    const { conn, repo, service } = setUp()
    await repo.upsertPermission(conn, 'employee.read', 'x')
    await repo.upsertPermission(conn, 'payroll.export', 'x')
    const role = await repo.upsertRole(conn, 'payroll-officer', {}, false)
    await repo.replaceRolePermissions(conn, role.id, ['payroll.export'])
    await repo.insertUserRole(conn, { userId: 'user-1', roleId: role.id, orgScopeUnitId: null, grantedBy: 'admin' })

    const decision = await service.decide('user-1', 'employee.read')

    expect(decision).toEqual({ allowed: false, scopeOrgUnitIds: [] })
  })

  it('a genuine grant allows, with self scope when the grant carries no org_scope_unit_id', async () => {
    const { conn, repo, service } = setUp()
    await repo.upsertPermission(conn, 'employee.read', 'x')
    const role = await repo.upsertRole(conn, 'employee-ess', {}, false)
    await repo.replaceRolePermissions(conn, role.id, ['employee.read'])
    await repo.insertUserRole(conn, { userId: 'user-1', roleId: role.id, orgScopeUnitId: null, grantedBy: 'admin' })

    const decision = await service.decide('user-1', 'employee.read')

    expect(decision).toEqual({ allowed: true, scopeOrgUnitIds: 'self' })
  })

  it('an unexpected repository failure resolves to denied, never propagates (fail-closed, carried-forward binding)', async () => {
    const repo = { findPermissionByCode: jest.fn().mockRejectedValue(new Error('DB is on fire')) } as unknown as AuthzRepository
    const service = new AuthzService(repo)

    const decision = await service.decide('user-1', 'employee.read')

    expect(decision).toEqual({ allowed: false, scopeOrgUnitIds: [] })
  })
})

describe('AuthzService.decide — org scoping is a subtree (Task 8 brief §4, property 3)', () => {
  it('a grant scoped to "chonburi-plant" resolves to exactly that unit and its descendants — nothing above, nothing beside', async () => {
    const { conn, repo, service } = setUp()
    await seedOrgTree(repo, conn)
    await repo.upsertPermission(conn, 'roster.read', 'x')
    const role = await repo.upsertRole(conn, 'line-manager', {}, false)
    await repo.replaceRolePermissions(conn, role.id, ['roster.read'])
    await repo.insertUserRole(conn, { userId: 'mgr-1', roleId: role.id, orgScopeUnitId: 'chonburi-plant', grantedBy: 'admin' })

    const decision = await service.decide('mgr-1', 'roster.read')

    expect(decision.allowed).toBe(true)
    expect(new Set(decision.scopeOrgUnitIds)).toEqual(
      new Set(['chonburi-plant', 'chonburi-plant-line-a', 'chonburi-plant-line-b']),
    )
  })

  it('the parent of the granted unit is excluded from the decided scope', async () => {
    const { conn, repo, service } = setUp()
    await seedOrgTree(repo, conn)
    await repo.upsertPermission(conn, 'roster.read', 'x')
    const role = await repo.upsertRole(conn, 'line-manager', {}, false)
    await repo.replaceRolePermissions(conn, role.id, ['roster.read'])
    await repo.insertUserRole(conn, { userId: 'mgr-1', roleId: role.id, orgScopeUnitId: 'chonburi-plant', grantedBy: 'admin' })

    const decision = await service.decide('mgr-1', 'roster.read')

    expect(decision.scopeOrgUnitIds).not.toContain('chonburi-office')
    expect(decision.scopeOrgUnitIds).not.toContain('chonburi-region')
    expect(decision.scopeOrgUnitIds).not.toContain('company')
  })

  it('a sibling unit is excluded from the decided scope (the "line manager sees the whole company" bug class)', async () => {
    const { conn, repo, service } = setUp()
    await seedOrgTree(repo, conn)
    await repo.upsertPermission(conn, 'roster.read', 'x')
    const role = await repo.upsertRole(conn, 'line-manager', {}, false)
    await repo.replaceRolePermissions(conn, role.id, ['roster.read'])
    await repo.insertUserRole(conn, { userId: 'mgr-1', roleId: role.id, orgScopeUnitId: 'chonburi-office', grantedBy: 'admin' })

    const decision = await service.decide('mgr-1', 'roster.read')

    expect(decision.scopeOrgUnitIds).not.toContain('chonburi-warehouse')
    expect(decision.scopeOrgUnitIds).not.toContain('bangkok-region')
    expect(decision.scopeOrgUnitIds).not.toContain('bangkok-hq')
  })

  it('a self-scoped grant plus an org-scoped grant of the same permission: the org-scoped subtree wins over self', async () => {
    const { conn, repo, service } = setUp()
    await seedOrgTree(repo, conn)
    await repo.upsertPermission(conn, 'roster.read', 'x')
    const roleA = await repo.upsertRole(conn, 'employee-ess', {}, false)
    const roleB = await repo.upsertRole(conn, 'line-manager', {}, false)
    await repo.replaceRolePermissions(conn, roleA.id, ['roster.read'])
    await repo.replaceRolePermissions(conn, roleB.id, ['roster.read'])
    await repo.insertUserRole(conn, { userId: 'user-1', roleId: roleA.id, orgScopeUnitId: null, grantedBy: 'admin' })
    await repo.insertUserRole(conn, { userId: 'user-1', roleId: roleB.id, orgScopeUnitId: 'chonburi-plant', grantedBy: 'admin' })

    const decision = await service.decide('user-1', 'roster.read')

    expect(decision.scopeOrgUnitIds).not.toBe('self')
    expect(new Set(decision.scopeOrgUnitIds)).toEqual(
      new Set(['chonburi-plant', 'chonburi-plant-line-a', 'chonburi-plant-line-b']),
    )
  })

  it('two org-scoped grants of the same permission union their subtrees, deduplicated', async () => {
    const { conn, repo, service } = setUp()
    await seedOrgTree(repo, conn)
    await repo.upsertPermission(conn, 'roster.read', 'x')
    const role = await repo.upsertRole(conn, 'line-manager', {}, false)
    await repo.replaceRolePermissions(conn, role.id, ['roster.read'])
    await repo.insertUserRole(conn, { userId: 'user-1', roleId: role.id, orgScopeUnitId: 'bangkok-region', grantedBy: 'admin' })
    await repo.insertUserRole(conn, { userId: 'user-1', roleId: role.id, orgScopeUnitId: 'chonburi-office', grantedBy: 'admin' })

    const decision = await service.decide('user-1', 'roster.read')

    expect(new Set(decision.scopeOrgUnitIds)).toEqual(
      new Set(['bangkok-region', 'bangkok-hq', 'chonburi-office', 'chonburi-plant', 'chonburi-plant-line-a', 'chonburi-plant-line-b']),
    )
  })
})

describe('AuthzService.applyEmployeeCreated — maintains the org-tree read model, idempotently (Task 8 brief §6)', () => {
  it('upserts an org_unit stub for the employee\'s orgUnitId on first delivery', async () => {
    const { conn, repo, service } = setUp()

    const result = await idempotent(conn, 'authz', 'evt-1', () =>
      service.applyEmployeeCreated(conn, { id: 'emp-1', orgUnitId: 'chonburi-plant' }),
    )

    expect(result).not.toBe('duplicate')
    const units = await repo.findAllOrgUnits()
    expect(units).toContainEqual({ id: 'chonburi-plant', parentId: null })
  })

  it('triple delivery of the same eventId produces exactly one effect (XC-EVENTS)', async () => {
    const { conn, repo, service } = setUp()
    const handler = jest.fn(() => service.applyEmployeeCreated(conn, { id: 'emp-1', orgUnitId: 'chonburi-plant' }))

    for (let i = 0; i < 3; i++) {
      await idempotent(conn, 'authz', 'evt-dup', handler)
    }

    expect(handler).toHaveBeenCalledTimes(1)
    expect((await repo.findAllOrgUnits()).filter((u) => u.id === 'chonburi-plant')).toHaveLength(1)
  })

  it('never overwrites a unit that already carries real hierarchy data (only inserts if absent)', async () => {
    const { conn, repo, service } = setUp()
    await repo.upsertOrgUnit(conn, 'chonburi-plant', 'chonburi-office', { en: 'Chonburi Plant' }, 'CB-02')

    await service.applyEmployeeCreated(conn, { id: 'emp-2', orgUnitId: 'chonburi-plant' })

    const units = await repo.findAllOrgUnits()
    expect(units).toContainEqual({ id: 'chonburi-plant', parentId: 'chonburi-office' })
  })
})

describe('AuthzService.grantRole / revokeRole — audit coverage (roadmap: "grants and revocations — who granted what to whom")', () => {
  it('grantRole inserts the grant AND emits audit.role.granted with the actor, the grantee, the role and the scope', async () => {
    const { conn, repo, db, service } = setUp()
    const role = await repo.upsertRole(conn, 'hr-officer', {}, false)

    const grant = await service.grantRole(
      conn,
      { userId: 'user-1', roleId: role.id, orgScopeUnitId: 'chonburi-plant', grantedBy: 'admin-1' },
      'authz_admin',
    )

    const [audit] = db.debugOutboxRows().filter((r) => r.topic === 'audit.role.granted')
    expect(audit?.payload).toMatchObject({
      actorId: 'admin-1',
      actorRole: 'authz_admin',
      action: 'role.granted',
      entity: 'user_role_grant',
      entityId: grant.id,
      beforeHash: null,
    })
    expect((audit?.payload as Record<string, unknown>)['afterHash']).toEqual(expect.any(String))
  })

  it('grantRole defaults actorRole to "unknown" when the caller omits it', async () => {
    const { conn, repo, db, service } = setUp()
    const role = await repo.upsertRole(conn, 'hr-officer', {}, false)

    await service.grantRole(conn, { userId: 'user-1', roleId: role.id, orgScopeUnitId: null, grantedBy: 'admin-1' })

    const [audit] = db.debugOutboxRows().filter((r) => r.topic === 'audit.role.granted')
    expect(audit?.payload).toMatchObject({ actorId: 'admin-1', actorRole: 'unknown' })
  })

  it('revokeRole deletes the grant(s) AND emits exactly one audit.role.revoked entry carrying how many were removed', async () => {
    const { conn, repo, db, service } = setUp()
    const role = await repo.upsertRole(conn, 'hr-officer', {}, false)
    await service.grantRole(conn, { userId: 'user-1', roleId: role.id, orgScopeUnitId: 'chonburi-plant', grantedBy: 'admin-1' })
    await service.grantRole(conn, { userId: 'user-1', roleId: role.id, orgScopeUnitId: 'bangkok-hq', grantedBy: 'admin-1' })

    const deleted = await service.revokeRole(conn, 'user-1', role.id, 'admin-2', 'authz_admin')

    expect(deleted).toBe(2)
    const revokedRows = db.debugOutboxRows().filter((r) => r.topic === 'audit.role.revoked')
    expect(revokedRows).toHaveLength(1) // one DELETE, one audit entry — not one per row removed
    expect(revokedRows[0]?.payload).toMatchObject({
      actorId: 'admin-2',
      actorRole: 'authz_admin',
      action: 'role.revoked',
      entity: 'user_role_grant',
      entityId: 'user-1',
    })
  })

  it('revokeRole still emits an audit entry (grantsRemoved: 0) when there was nothing to revoke — the attempt itself is the auditable fact', async () => {
    const { conn, db, service } = setUp()

    const deleted = await service.revokeRole(conn, 'user-1', 'no-such-role', 'admin-2')

    expect(deleted).toBe(0)
    const [audit] = db.debugOutboxRows().filter((r) => r.topic === 'audit.role.revoked')
    expect(audit).toBeDefined()
  })
})

describe('AuthzService.listPermissionsForUser — backs GET /me/permissions, the PWA nav gate', () => {
  it('returns nothing for a user holding no grants — the honest answer, not an error', async () => {
    const { conn, repo, service } = setUp()
    await repo.upsertPermission(conn, 'employee.read', 'x')

    await expect(service.listPermissionsForUser('user-1')).resolves.toEqual([])
  })

  it('returns every code the user reaches through their granted roles', async () => {
    const { conn, repo, service } = setUp()
    await repo.upsertPermission(conn, 'config.rule.read', 'x')
    await repo.upsertPermission(conn, 'audit.read', 'x')
    const role = await repo.upsertRole(conn, 'hr-system-admin', {}, true)
    await repo.replaceRolePermissions(conn, role.id, ['config.rule.read', 'audit.read'])
    await repo.insertUserRole(conn, { userId: 'user-1', roleId: role.id, orgScopeUnitId: null, grantedBy: 'admin' })

    const codes = await service.listPermissionsForUser('user-1')

    expect([...codes].sort()).toEqual(['audit.read', 'config.rule.read'])
  })

  it("never leaks another user's grants", async () => {
    const { conn, repo, service } = setUp()
    await repo.upsertPermission(conn, 'payroll.export', 'x')
    const role = await repo.upsertRole(conn, 'payroll-officer', {}, false)
    await repo.replaceRolePermissions(conn, role.id, ['payroll.export'])
    await repo.insertUserRole(conn, { userId: 'someone-else', roleId: role.id, orgScopeUnitId: null, grantedBy: 'admin' })

    await expect(service.listPermissionsForUser('user-1')).resolves.toEqual([])
  })

  it('de-duplicates a code carried by two different granted roles', async () => {
    const { conn, repo, service } = setUp()
    await repo.upsertPermission(conn, 'employee.read', 'x')
    const roleA = await repo.upsertRole(conn, 'hr-officer', {}, false)
    const roleB = await repo.upsertRole(conn, 'line-manager', {}, false)
    await repo.replaceRolePermissions(conn, roleA.id, ['employee.read'])
    await repo.replaceRolePermissions(conn, roleB.id, ['employee.read'])
    await repo.insertUserRole(conn, { userId: 'user-1', roleId: roleA.id, orgScopeUnitId: null, grantedBy: 'admin' })
    await repo.insertUserRole(conn, { userId: 'user-1', roleId: roleB.id, orgScopeUnitId: null, grantedBy: 'admin' })

    await expect(service.listPermissionsForUser('user-1')).resolves.toEqual(['employee.read'])
  })

  it('de-duplicates one role granted twice at different org scopes — user_role has no unique constraint', async () => {
    const { conn, repo, service } = setUp()
    await repo.upsertPermission(conn, 'timesheet.read', 'x')
    const role = await repo.upsertRole(conn, 'line-manager', {}, false)
    await repo.replaceRolePermissions(conn, role.id, ['timesheet.read'])
    await repo.insertUserRole(conn, { userId: 'user-1', roleId: role.id, orgScopeUnitId: 'bangkok-hq', grantedBy: 'admin' })
    await repo.insertUserRole(conn, { userId: 'user-1', roleId: role.id, orgScopeUnitId: 'chonburi-plant', grantedBy: 'admin' })

    await expect(service.listPermissionsForUser('user-1')).resolves.toEqual(['timesheet.read'])
  })

  it('is scope-blind on purpose: an org-scoped grant still reports the code, because WHICH rows are returned is PermissionGuard\'s job on each request', async () => {
    const { conn, repo, service } = setUp()
    await repo.upsertPermission(conn, 'timesheet.read', 'x')
    const role = await repo.upsertRole(conn, 'line-manager', {}, false)
    await repo.replaceRolePermissions(conn, role.id, ['timesheet.read'])
    await repo.insertUserRole(conn, { userId: 'user-1', roleId: role.id, orgScopeUnitId: 'chonburi-plant', grantedBy: 'admin' })

    await expect(service.listPermissionsForUser('user-1')).resolves.toEqual(['timesheet.read'])
  })

  it('an unexpected repository failure resolves to an empty list, never propagates — an unreadable grant table must not widen what the UI offers', async () => {
    const repo = { listPermissionCodesForUser: jest.fn().mockRejectedValue(new Error('DB is on fire')) } as unknown as AuthzRepository
    const service = new AuthzService(repo)

    await expect(service.listPermissionsForUser('user-1')).resolves.toEqual([])
  })
})
