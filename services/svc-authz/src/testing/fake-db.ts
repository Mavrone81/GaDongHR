import { randomUUID } from 'node:crypto'
import type { Queryable } from '@gadong/kernel'

/**
 * A tiny in-memory stand-in for Postgres, scoped to the `authz` schema — the
 * same reason and shape as `services/svc-config/src/testing/fake-db.ts`
 * (Task 7) and `@gadong/kernel`'s `outbox/testing/fake-db.ts` (Task 4):
 * there is no Postgres in this environment (Task 8 brief, carried-forward
 * binding), so the repository layer is proven against a fake instead.
 * `migrations/1754100000000_authz-schema.js` is the source of truth for the
 * real schema; a later task re-proves this suite against real Postgres.
 *
 * One constraint is enforced here because it is load-bearing for this
 * task's absolute compliance claim (Security doc §4.2: no role, ever,
 * carries `biometric.template.read`) and must be provable even without a
 * live database:
 *
 *   CHECK (permission_code <> 'biometric.template.read')  -- role_permission
 *
 * This mirrors the migration's DB-level CHECK exactly — it is the "belt";
 * `seed/roles.ts`'s `assertNoBiometricGrant` is the independent "brace".
 * See `authz.repository.test.ts` and `seed/roles.test.ts` for each failing
 * on its own when the *other* protection is removed.
 */

export class ConstraintViolation extends Error {
  constructor(readonly constraint: string) {
    super(`FakeAuthzDb: violates constraint "${constraint}"`)
  }
}

interface StoredRole {
  id: string
  code: string
  name_i18n: Record<string, unknown>
  is_system: boolean
}

interface StoredPermission {
  code: string
  description: string
}

interface StoredRolePermission {
  role_id: string
  permission_code: string
}

interface StoredUserRole {
  id: string
  user_id: string
  role_id: string
  org_scope_unit_id: string | null
  granted_by: string
  granted_at: Date
}

interface StoredOrgUnit {
  id: string
  parent_id: string | null
  name_i18n: Record<string, unknown>
  cost_center: string | null
}

interface StoredOutboxRow {
  id: string
  topic: string
  payload: unknown
  created_at: Date
  published_at: Date | null
}

const BIOMETRIC_TEMPLATE_READ = 'biometric.template.read'

export class FakeAuthzDb {
  private readonly roles = new Map<string, StoredRole>()
  private readonly permissions = new Map<string, StoredPermission>()
  private readonly rolePermissions: StoredRolePermission[] = []
  private readonly userRoles = new Map<string, StoredUserRole>()
  private readonly orgUnits = new Map<string, StoredOrgUnit>()
  private readonly outbox = new Map<string, StoredOutboxRow>()
  private readonly processedEvents = new Set<string>()

  connect(): FakeAuthzConnection {
    return new FakeAuthzConnection(this)
  }

  /** A `Queryable` that runs every statement outside a transaction (autocommit) — mirrors `FakeConfigDb.asPool()`. */
  asPool(): Queryable {
    const conn = this.connect()
    return { query: (sql: string, params?: unknown[]) => conn.query(sql, params) }
  }

  debugRoles(): StoredRole[] {
    return [...this.roles.values()]
  }
  debugPermissions(): StoredPermission[] {
    return [...this.permissions.values()]
  }
  debugRolePermissions(): StoredRolePermission[] {
    return [...this.rolePermissions]
  }
  debugUserRoles(): StoredUserRole[] {
    return [...this.userRoles.values()]
  }
  debugOrgUnits(): StoredOrgUnit[] {
    return [...this.orgUnits.values()]
  }
  debugOutboxRows(): StoredOutboxRow[] {
    return [...this.outbox.values()]
  }

  // --- internals used only by FakeAuthzConnection ---

  _findRoleByCode(code: string): StoredRole | undefined {
    return [...this.roles.values()].find((r) => r.code === code)
  }
  _upsertRole(row: StoredRole): void {
    this.roles.set(row.id, row)
  }
  _allRoles(): StoredRole[] {
    return [...this.roles.values()]
  }

  _findPermissionByCode(code: string): StoredPermission | undefined {
    return this.permissions.get(code)
  }
  _upsertPermission(row: StoredPermission): void {
    this.permissions.set(row.code, row)
  }

  _rolePermissionsForRole(roleId: string): StoredRolePermission[] {
    return this.rolePermissions.filter((rp) => rp.role_id === roleId)
  }
  _deleteRolePermissions(roleId: string): void {
    const remaining = this.rolePermissions.filter((rp) => rp.role_id !== roleId)
    this.rolePermissions.length = 0
    this.rolePermissions.push(...remaining)
  }
  _insertRolePermission(row: StoredRolePermission): void {
    // Belt — see file-level comment. Independent of `seed/roles.ts`'s brace.
    if (row.permission_code === BIOMETRIC_TEMPLATE_READ) {
      throw new ConstraintViolation('role_permission_no_biometric_check')
    }
    this.rolePermissions.push(row)
  }

  _insertUserRole(row: StoredUserRole): void {
    this.userRoles.set(row.id, row)
  }
  _allUserRoles(): StoredUserRole[] {
    return [...this.userRoles.values()]
  }
  _deleteUserRoles(ids: string[]): void {
    for (const id of ids) this.userRoles.delete(id)
  }

  _findOrgUnit(id: string): StoredOrgUnit | undefined {
    return this.orgUnits.get(id)
  }
  _insertOrgUnitIfAbsent(row: StoredOrgUnit): boolean {
    if (this.orgUnits.has(row.id)) return false
    this.orgUnits.set(row.id, row)
    return true
  }
  _allOrgUnits(): StoredOrgUnit[] {
    return [...this.orgUnits.values()]
  }

  _insertOutboxRow(row: StoredOutboxRow): void {
    this.outbox.set(row.id, row)
  }

  _processedEventExists(schema: string, eventId: string): boolean {
    return this.processedEvents.has(`${schema}:${eventId}`)
  }
  _insertProcessedEvent(schema: string, eventId: string): void {
    this.processedEvents.add(`${schema}:${eventId}`)
  }
}

function toRoleRow(r: StoredRole): Record<string, unknown> {
  return { id: r.id, code: r.code, name_i18n: r.name_i18n, is_system: r.is_system }
}
function toPermissionRow(p: StoredPermission): Record<string, unknown> {
  return { code: p.code, description: p.description }
}
function toOrgUnitRow(u: StoredOrgUnit): Record<string, unknown> {
  return { id: u.id, parent_id: u.parent_id, name_i18n: u.name_i18n, cost_center: u.cost_center }
}
function toUserRoleRow(g: StoredUserRole): Record<string, unknown> {
  return {
    id: g.id,
    user_id: g.user_id,
    role_id: g.role_id,
    org_scope_unit_id: g.org_scope_unit_id,
    granted_by: g.granted_by,
    granted_at: g.granted_at,
  }
}

/**
 * One session/connection. Unlike `FakeConfigConnection`, this fake applies
 * every write immediately (autocommit-style) rather than staging until
 * COMMIT — no test in this task depends on multi-statement rollback
 * atomicity against this fake (that property is proven at the kernel level
 * by `outbox/testing/fake-db.ts` and at the config level by
 * `rules.repository.test.ts`). `BEGIN`/`COMMIT`/`ROLLBACK` are still
 * accepted as no-ops so `withTransaction` can drive this fake directly, the
 * same as a real `pg.PoolClient`.
 */
export class FakeAuthzConnection implements Queryable {
  constructor(private readonly db: FakeAuthzDb) {}

  /** No-op — present so kernel's `withTransaction`/`withConnection` (which call `client.release()`) can drive this fake directly, the same as a real `pg.PoolClient`. */
  release(_err?: Error): void {
    void _err
  }

  async query(sql: string, params: unknown[] = []): Promise<{ rows: Array<Record<string, unknown>> }> {
    const s = sql.trim()

    if (/^BEGIN\b/i.test(s)) {
      return { rows: [] }
    }
    if (/^COMMIT\b/i.test(s)) {
      return { rows: [] }
    }
    if (/^ROLLBACK\b/i.test(s)) {
      return { rows: [] }
    }

    if (/^INSERT INTO\s+authz\.permission\b/i.test(s)) {
      const [code, description] = params as [string, string]
      this.db._upsertPermission({ code, description })
      const row = this.db._findPermissionByCode(code)
      if (!row) throw new Error('unreachable: just upserted')
      return { rows: [toPermissionRow(row)] }
    }

    if (/^SELECT[\s\S]*FROM\s+authz\.permission\s+WHERE\s+code\s*=\s*\$1/i.test(s)) {
      const [code] = params as [string]
      const row = this.db._findPermissionByCode(code)
      return { rows: row ? [toPermissionRow(row)] : [] }
    }

    if (/^SELECT\s+code,\s*description\s+FROM\s+authz\.permission\s*$/i.test(s)) {
      return { rows: this.db.debugPermissions().map(toPermissionRow) }
    }

    if (/^INSERT INTO\s+authz\.role\b/i.test(s)) {
      const [code, nameI18nJson, isSystem] = params as [string, string, boolean]
      const existing = this.db._findRoleByCode(code)
      const row: StoredRole = {
        id: existing?.id ?? randomUUID(),
        code,
        name_i18n: JSON.parse(nameI18nJson) as Record<string, unknown>,
        is_system: isSystem,
      }
      this.db._upsertRole(row)
      return { rows: [toRoleRow(row)] }
    }

    if (/^SELECT[\s\S]*FROM\s+authz\.role\s+WHERE\s+code\s*=\s*\$1/i.test(s)) {
      const [code] = params as [string]
      const row = this.db._findRoleByCode(code)
      return { rows: row ? [toRoleRow(row)] : [] }
    }

    if (/^SELECT[\s\S]*FROM\s+authz\.role\s+WHERE\s+id\s*=\s*\$1/i.test(s)) {
      const [id] = params as [string]
      const row = this.db._allRoles().find((r) => r.id === id)
      return { rows: row ? [toRoleRow(row)] : [] }
    }

    if (/^SELECT[\s\S]*FROM\s+authz\.role\b(?!_permission)(?!\s+WHERE)/i.test(s)) {
      return { rows: this.db._allRoles().map(toRoleRow) }
    }

    if (/^DELETE FROM\s+authz\.role_permission\s+WHERE\s+role_id\s*=\s*\$1/i.test(s)) {
      const [roleId] = params as [string]
      this.db._deleteRolePermissions(roleId)
      return { rows: [] }
    }

    if (/^INSERT INTO\s+authz\.role_permission\b/i.test(s)) {
      const [roleId, permissionCode] = params as [string, string]
      this.db._insertRolePermission({ role_id: roleId, permission_code: permissionCode })
      return { rows: [] }
    }

    if (/^SELECT\s+permission_code\s+FROM\s+authz\.role_permission\s+WHERE\s+role_id\s*=\s*\$1/i.test(s)) {
      const [roleId] = params as [string]
      return { rows: this.db._rolePermissionsForRole(roleId).map((rp) => ({ permission_code: rp.permission_code })) }
    }

    if (/^INSERT INTO\s+authz\.user_role\b/i.test(s)) {
      const [userId, roleId, orgScopeUnitId, grantedBy] = params as [string, string, string | null, string]
      const row: StoredUserRole = {
        id: randomUUID(),
        user_id: userId,
        role_id: roleId,
        org_scope_unit_id: orgScopeUnitId,
        granted_by: grantedBy,
        granted_at: new Date(),
      }
      this.db._insertUserRole(row)
      return { rows: [toUserRoleRow(row)] }
    }

    if (/^DELETE FROM\s+authz\.user_role\s+WHERE\s+user_id\s*=\s*\$1\s+AND\s+role_id\s*=\s*\$2/i.test(s)) {
      const [userId, roleId] = params as [string, string]
      const toDelete = this.db
        ._allUserRoles()
        .filter((g) => g.user_id === userId && g.role_id === roleId)
        .map((g) => g.id)
      this.db._deleteUserRoles(toDelete)
      return { rows: toDelete.map((id) => ({ id })) }
    }

    if (/^SELECT\s+ur\.org_scope_unit_id[\s\S]*FROM\s+authz\.user_role\s+ur[\s\S]*JOIN\s+authz\.role_permission\s+rp/i.test(s)) {
      const [userId, permissionCode] = params as [string, string]
      const grants = this.db
        ._allUserRoles()
        .filter((g) => g.user_id === userId)
        .filter((g) => this.db._rolePermissionsForRole(g.role_id).some((rp) => rp.permission_code === permissionCode))
      return { rows: grants.map((g) => ({ org_scope_unit_id: g.org_scope_unit_id })) }
    }

    // `listPermissionCodesForUser` — the set form of the join just above.
    // Distinguished from it by the projection (`DISTINCT rp.permission_code`
    // vs `ur.org_scope_unit_id`), not by the FROM/JOIN, which are identical
    // on purpose: the two must never disagree about what a grant carries.
    if (/^SELECT\s+DISTINCT\s+rp\.permission_code[\s\S]*FROM\s+authz\.user_role\s+ur[\s\S]*JOIN\s+authz\.role_permission\s+rp/i.test(s)) {
      const [userId] = params as [string]
      const codes = new Set<string>()
      for (const grant of this.db._allUserRoles().filter((g) => g.user_id === userId)) {
        for (const rp of this.db._rolePermissionsForRole(grant.role_id)) codes.add(rp.permission_code)
      }
      // A `Set` reproduces SQL's DISTINCT: a user holding two roles that
      // share a permission, or one role granted twice at different org
      // scopes, still yields that code exactly once.
      return { rows: [...codes].map((permission_code) => ({ permission_code })) }
    }

    if (/^INSERT INTO\s+authz\.org_unit\b/i.test(s)) {
      const [id, parentId, nameI18nJson, costCenter] = params as [string, string | null, string, string | null]
      const inserted = this.db._insertOrgUnitIfAbsent({
        id,
        parent_id: parentId,
        name_i18n: JSON.parse(nameI18nJson) as Record<string, unknown>,
        cost_center: costCenter,
      })
      // Mirrors real Postgres: `RETURNING` after `ON CONFLICT ... DO
      // NOTHING` produces no row at all when the conflict fires — the
      // repository's `upsertOrgUnit` falls back to a plain SELECT for that
      // case, exercised by the handler just below.
      if (!inserted) return { rows: [] }
      const row = this.db._findOrgUnit(id)
      if (!row) throw new Error('unreachable: just inserted')
      return { rows: [toOrgUnitRow(row)] }
    }

    if (/^SELECT\s+id,\s*parent_id,\s*name_i18n,\s*cost_center\s+FROM\s+authz\.org_unit\s+WHERE\s+id\s*=\s*\$1/i.test(s)) {
      const [id] = params as [string]
      const row = this.db._findOrgUnit(id)
      return { rows: row ? [toOrgUnitRow(row)] : [] }
    }

    if (/^SELECT\s+id,\s*parent_id\s+FROM\s+authz\.org_unit/i.test(s)) {
      return { rows: this.db._allOrgUnits().map((u) => ({ id: u.id, parent_id: u.parent_id })) }
    }

    if (/^INSERT INTO\s+\S*outbox\b/i.test(s)) {
      const [topic, payloadJson] = params as [string, string]
      const row: StoredOutboxRow = {
        id: randomUUID(),
        topic,
        payload: JSON.parse(payloadJson) as unknown,
        created_at: new Date(),
        published_at: null,
      }
      this.db._insertOutboxRow(row)
      return { rows: [{ id: row.id }] }
    }

    if (/^INSERT INTO\s+\S*processed_events\b/i.test(s)) {
      const schemaMatch = /INSERT INTO\s+(\S+)\.processed_events/i.exec(s)
      const schema = schemaMatch?.[1] ?? 'authz'
      const [eventId] = params as [string]
      if (this.db._processedEventExists(schema, eventId)) return { rows: [] }
      this.db._insertProcessedEvent(schema, eventId)
      return { rows: [{ event_id: eventId }] }
    }

    if (/^SELECT\s+1\b/i.test(s)) {
      return { rows: [{ '?column?': 1 }] }
    }

    throw new Error(`FakeAuthzDb: unrecognised query: ${s}`)
  }
}
