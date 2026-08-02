import { AuthzRepository } from './authz.repository'
import { ConstraintViolation, FakeAuthzDb } from './testing/fake-db'

describe('AuthzRepository — against FakeAuthzDb (relational behaviour, Task 8 brief: no Postgres here)', () => {
  it('upsertPermission then findPermissionByCode round-trips', async () => {
    const db = new FakeAuthzDb()
    const conn = db.connect()
    const repo = new AuthzRepository(conn)

    await repo.upsertPermission(conn, 'employee.read', 'Read employee records')
    const found = await repo.findPermissionByCode('employee.read')

    expect(found).toMatchObject({ code: 'employee.read', description: 'Read employee records' })
  })

  it('findPermissionByCode returns null for a code never seeded (deny-by-default relies on this)', async () => {
    const db = new FakeAuthzDb()
    const repo = new AuthzRepository(db.connect())

    expect(await repo.findPermissionByCode('not.a.real.permission')).toBeNull()
  })

  it('upsertPermission is idempotent — a second call with a new description updates in place, not duplicates', async () => {
    const db = new FakeAuthzDb()
    const conn = db.connect()
    const repo = new AuthzRepository(conn)

    await repo.upsertPermission(conn, 'employee.read', 'first description')
    await repo.upsertPermission(conn, 'employee.read', 'second description')

    expect(db.debugPermissions()).toHaveLength(1)
    expect(await repo.findPermissionByCode('employee.read')).toMatchObject({ description: 'second description' })
  })

  it('upsertRole then findRoleByCode round-trips', async () => {
    const db = new FakeAuthzDb()
    const conn = db.connect()
    const repo = new AuthzRepository(conn)

    const role = await repo.upsertRole(conn, 'hr-officer', { en: 'HR Officer', th: 'เจ้าหน้าที่ HR' }, false)
    const found = await repo.findRoleByCode('hr-officer')

    expect(found).toMatchObject({ id: role.id, code: 'hr-officer', isSystem: false })
  })

  it('upsertRole is idempotent — same code twice yields the same row id, updated in place', async () => {
    const db = new FakeAuthzDb()
    const conn = db.connect()
    const repo = new AuthzRepository(conn)

    const first = await repo.upsertRole(conn, 'hr-officer', { en: 'HR Officer' }, false)
    const second = await repo.upsertRole(conn, 'hr-officer', { en: 'HR Officer (renamed)' }, false)

    expect(second.id).toBe(first.id)
    expect(db.debugRoles()).toHaveLength(1)
  })

  it('listRoles returns every seeded role', async () => {
    const db = new FakeAuthzDb()
    const conn = db.connect()
    const repo = new AuthzRepository(conn)

    await repo.upsertRole(conn, 'hr-officer', {}, false)
    await repo.upsertRole(conn, 'payroll-officer', {}, false)

    const roles = await repo.listRoles()
    expect(roles.map((r) => r.code).sort()).toEqual(['hr-officer', 'payroll-officer'])
  })

  it('replaceRolePermissions sets exactly the given set, replacing whatever was there before', async () => {
    const db = new FakeAuthzDb()
    const conn = db.connect()
    const repo = new AuthzRepository(conn)
    await repo.upsertPermission(conn, 'employee.read', 'x')
    await repo.upsertPermission(conn, 'employee.update', 'x')
    const role = await repo.upsertRole(conn, 'hr-officer', {}, false)

    await repo.replaceRolePermissions(conn, role.id, ['employee.read', 'employee.update'])
    expect((await repo.listPermissionCodesForRole(role.id)).sort()).toEqual(['employee.read', 'employee.update'])

    await repo.replaceRolePermissions(conn, role.id, ['employee.read'])
    expect(await repo.listPermissionCodesForRole(role.id)).toEqual(['employee.read'])
  })

  it('replaceRolePermissions called twice with the same set is idempotent (no duplicate rows, no error)', async () => {
    const db = new FakeAuthzDb()
    const conn = db.connect()
    const repo = new AuthzRepository(conn)
    await repo.upsertPermission(conn, 'employee.read', 'x')
    const role = await repo.upsertRole(conn, 'hr-officer', {}, false)

    await repo.replaceRolePermissions(conn, role.id, ['employee.read'])
    await repo.replaceRolePermissions(conn, role.id, ['employee.read'])

    expect(await repo.listPermissionCodesForRole(role.id)).toEqual(['employee.read'])
  })

  it('CHECK constraint: role_permission rejects biometric.template.read outright, independent of any application-level check (Security doc §4.2, absolute)', async () => {
    const db = new FakeAuthzDb()
    const conn = db.connect()
    const repo = new AuthzRepository(conn)
    await repo.upsertPermission(conn, 'biometric.template.read', 'x')
    const role = await repo.upsertRole(conn, 'hr-system-admin', {}, true)

    await expect(repo.replaceRolePermissions(conn, role.id, ['biometric.template.read'])).rejects.toThrow(
      ConstraintViolation,
    )
  })

  it('insertUserRole then findGrantsForUserPermission returns the org scope (null = self)', async () => {
    const db = new FakeAuthzDb()
    const conn = db.connect()
    const repo = new AuthzRepository(conn)
    await repo.upsertPermission(conn, 'employee.read', 'x')
    const role = await repo.upsertRole(conn, 'hr-officer', {}, false)
    await repo.replaceRolePermissions(conn, role.id, ['employee.read'])

    await repo.insertUserRole(conn, { userId: 'user-1', roleId: role.id, orgScopeUnitId: null, grantedBy: 'admin-1' })

    const grants = await repo.findGrantsForUserPermission('user-1', 'employee.read')
    expect(grants).toEqual([{ orgScopeUnitId: null }])
  })

  it('findGrantsForUserPermission returns nothing for a permission the user\'s role does not carry', async () => {
    const db = new FakeAuthzDb()
    const conn = db.connect()
    const repo = new AuthzRepository(conn)
    await repo.upsertPermission(conn, 'employee.read', 'x')
    await repo.upsertPermission(conn, 'payroll.export', 'x')
    const role = await repo.upsertRole(conn, 'hr-officer', {}, false)
    await repo.replaceRolePermissions(conn, role.id, ['employee.read'])
    await repo.insertUserRole(conn, { userId: 'user-1', roleId: role.id, orgScopeUnitId: null, grantedBy: 'admin-1' })

    expect(await repo.findGrantsForUserPermission('user-1', 'payroll.export')).toEqual([])
  })

  it('findGrantsForUserPermission returns nothing for a user with no grants at all', async () => {
    const db = new FakeAuthzDb()
    const repo = new AuthzRepository(db.connect())
    expect(await repo.findGrantsForUserPermission('ghost-user', 'employee.read')).toEqual([])
  })

  it('org-scoped grant round-trips the org_scope_unit_id', async () => {
    const db = new FakeAuthzDb()
    const conn = db.connect()
    const repo = new AuthzRepository(conn)
    await repo.upsertPermission(conn, 'roster.read', 'x')
    const role = await repo.upsertRole(conn, 'line-manager', {}, false)
    await repo.replaceRolePermissions(conn, role.id, ['roster.read'])

    await repo.insertUserRole(conn, {
      userId: 'user-2',
      roleId: role.id,
      orgScopeUnitId: 'chonburi-plant',
      grantedBy: 'admin-1',
    })

    expect(await repo.findGrantsForUserPermission('user-2', 'roster.read')).toEqual([
      { orgScopeUnitId: 'chonburi-plant' },
    ])
  })

  it('a user with two grants of the same permission (one self, one org-scoped) returns both rows', async () => {
    const db = new FakeAuthzDb()
    const conn = db.connect()
    const repo = new AuthzRepository(conn)
    await repo.upsertPermission(conn, 'roster.read', 'x')
    const roleA = await repo.upsertRole(conn, 'line-manager', {}, false)
    const roleB = await repo.upsertRole(conn, 'employee-ess', {}, false)
    await repo.replaceRolePermissions(conn, roleA.id, ['roster.read'])
    await repo.replaceRolePermissions(conn, roleB.id, ['roster.read'])

    await repo.insertUserRole(conn, { userId: 'user-3', roleId: roleA.id, orgScopeUnitId: 'chonburi-plant', grantedBy: 'admin' })
    await repo.insertUserRole(conn, { userId: 'user-3', roleId: roleB.id, orgScopeUnitId: null, grantedBy: 'admin' })

    const grants = await repo.findGrantsForUserPermission('user-3', 'roster.read')
    expect(grants).toHaveLength(2)
    expect(grants).toEqual(expect.arrayContaining([{ orgScopeUnitId: null }, { orgScopeUnitId: 'chonburi-plant' }]))
  })

  it('deleteUserRoleGrants removes every grant for that (user, role) pair and reports how many', async () => {
    const db = new FakeAuthzDb()
    const conn = db.connect()
    const repo = new AuthzRepository(conn)
    await repo.upsertPermission(conn, 'roster.read', 'x')
    const role = await repo.upsertRole(conn, 'line-manager', {}, false)
    await repo.replaceRolePermissions(conn, role.id, ['roster.read'])
    await repo.insertUserRole(conn, { userId: 'user-4', roleId: role.id, orgScopeUnitId: 'unit-a', grantedBy: 'admin' })
    await repo.insertUserRole(conn, { userId: 'user-4', roleId: role.id, orgScopeUnitId: 'unit-b', grantedBy: 'admin' })

    const deleted = await repo.deleteUserRoleGrants(conn, 'user-4', role.id)

    expect(deleted).toBe(2)
    expect(await repo.findGrantsForUserPermission('user-4', 'roster.read')).toEqual([])
  })

  it('deleteUserRoleGrants for a pair with no grants deletes nothing and does not throw', async () => {
    const db = new FakeAuthzDb()
    const conn = db.connect()
    const repo = new AuthzRepository(conn)
    const role = await repo.upsertRole(conn, 'line-manager', {}, false)

    expect(await repo.deleteUserRoleGrants(conn, 'nobody', role.id)).toBe(0)
  })

  it('upsertOrgUnit then findAllOrgUnits round-trips id/parentId for the org-tree walk', async () => {
    const db = new FakeAuthzDb()
    const conn = db.connect()
    const repo = new AuthzRepository(conn)

    await repo.upsertOrgUnit(conn, 'company', null, { en: 'Company' }, null)
    await repo.upsertOrgUnit(conn, 'chonburi-region', 'company', { en: 'Chonburi Region' }, 'CB-01')

    const units = await repo.findAllOrgUnits()
    expect(units).toEqual(
      expect.arrayContaining([
        { id: 'company', parentId: null },
        { id: 'chonburi-region', parentId: 'company' },
      ]),
    )
  })

  it('upsertOrgUnit is idempotent by id — inserting the same id again with different data does not create a second row and does not throw', async () => {
    const db = new FakeAuthzDb()
    const conn = db.connect()
    const repo = new AuthzRepository(conn)

    await repo.upsertOrgUnit(conn, 'company', null, { en: 'Company' }, null)
    await repo.upsertOrgUnit(conn, 'company', null, { en: 'Company (again)' }, null)

    expect(db.debugOrgUnits()).toHaveLength(1)
  })
})
