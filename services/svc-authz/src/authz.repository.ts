import type { Queryable } from '@gadong/kernel'
import type { OrgUnitNode } from './org-tree'

export interface RoleRow {
  id: string
  code: string
  nameI18n: Record<string, unknown>
  isSystem: boolean
}

export interface PermissionRow {
  code: string
  description: string
}

export interface UserRoleGrantRow {
  id: string
  userId: string
  roleId: string
  orgScopeUnitId: string | null
  grantedBy: string
  grantedAt: string
}

export interface OrgUnitRow {
  id: string
  parentId: string | null
  nameI18n: Record<string, unknown>
  costCenter: string | null
}

export interface NewUserRoleGrant {
  userId: string
  roleId: string
  orgScopeUnitId: string | null
  grantedBy: string
}

function toIsoString(v: unknown): string {
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'string') return v
  throw new Error(`AuthzRepository: unexpected timestamp value ${JSON.stringify(v)}`)
}

function mapRole(row: Record<string, unknown>): RoleRow {
  return {
    id: String(row['id']),
    code: String(row['code']),
    nameI18n: (row['name_i18n'] as Record<string, unknown>) ?? {},
    isSystem: Boolean(row['is_system']),
  }
}

function mapPermission(row: Record<string, unknown>): PermissionRow {
  return { code: String(row['code']), description: String(row['description']) }
}

function mapUserRoleGrant(row: Record<string, unknown>): UserRoleGrantRow {
  return {
    id: String(row['id']),
    userId: String(row['user_id']),
    roleId: String(row['role_id']),
    orgScopeUnitId: row['org_scope_unit_id'] === null || row['org_scope_unit_id'] === undefined ? null : String(row['org_scope_unit_id']),
    grantedBy: String(row['granted_by']),
    grantedAt: toIsoString(row['granted_at']),
  }
}

/**
 * SQL only — no business logic (deny-by-default, org-subtree resolution,
 * role-template seeding) lives here; that is `authz.service.ts`'s and
 * `seed/roles.ts`'s job (Task 8 brief file layout, matching
 * `services/svc-config`'s `repository`/`service` split).
 *
 * Read methods take a plain `Queryable`; write methods take the CALLER's
 * transaction handle `tx` (the same contract `writeOutbox`/`idempotent`
 * use), even where this task has no second write to make atomic with —
 * matching the shape every other repository in this codebase already uses,
 * so a future write (e.g. an audit-emitting grant) can be added without
 * reshaping this file.
 */
export class AuthzRepository {
  constructor(private readonly db: Queryable) {}

  async upsertPermission(tx: Queryable, code: string, description: string): Promise<PermissionRow> {
    const { rows } = await tx.query(
      `INSERT INTO authz.permission (code, description) VALUES ($1, $2)
       ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description
       RETURNING code, description`,
      [code, description],
    )
    const row = rows[0]
    if (!row) throw new Error('AuthzRepository.upsertPermission: no row returned')
    return mapPermission(row)
  }

  async findPermissionByCode(code: string): Promise<PermissionRow | null> {
    const { rows } = await this.db.query(`SELECT code, description FROM authz.permission WHERE code = $1`, [code])
    return rows.length > 0 && rows[0] ? mapPermission(rows[0]) : null
  }

  async listPermissions(): Promise<PermissionRow[]> {
    const { rows } = await this.db.query(`SELECT code, description FROM authz.permission`)
    return rows.map(mapPermission)
  }

  async upsertRole(tx: Queryable, code: string, nameI18n: Record<string, unknown>, isSystem: boolean): Promise<RoleRow> {
    const { rows } = await tx.query(
      `INSERT INTO authz.role (code, name_i18n, is_system) VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (code) DO UPDATE SET name_i18n = EXCLUDED.name_i18n, is_system = EXCLUDED.is_system
       RETURNING id, code, name_i18n, is_system`,
      [code, JSON.stringify(nameI18n), isSystem],
    )
    const row = rows[0]
    if (!row) throw new Error('AuthzRepository.upsertRole: no row returned')
    return mapRole(row)
  }

  async findRoleByCode(code: string): Promise<RoleRow | null> {
    const { rows } = await this.db.query(`SELECT id, code, name_i18n, is_system FROM authz.role WHERE code = $1`, [code])
    return rows.length > 0 && rows[0] ? mapRole(rows[0]) : null
  }

  async listRoles(): Promise<RoleRow[]> {
    const { rows } = await this.db.query(`SELECT id, code, name_i18n, is_system FROM authz.role`)
    return rows.map(mapRole)
  }

  async findRoleById(id: string): Promise<RoleRow | null> {
    const { rows } = await this.db.query(`SELECT id, code, name_i18n, is_system FROM authz.role WHERE id = $1`, [id])
    return rows.length > 0 && rows[0] ? mapRole(rows[0]) : null
  }

  /** Replaces the full permission set for `roleId` — delete-then-reinsert, so a role's assignments always exactly match `permissionCodes` (never a leftover from a previous seed). Each insert re-runs the DB's `role_permission_no_biometric_check` (the "belt" — see `testing/fake-db.ts`). */
  async replaceRolePermissions(tx: Queryable, roleId: string, permissionCodes: string[]): Promise<void> {
    await tx.query(`DELETE FROM authz.role_permission WHERE role_id = $1`, [roleId])
    for (const code of permissionCodes) {
      await tx.query(`INSERT INTO authz.role_permission (role_id, permission_code) VALUES ($1, $2)`, [roleId, code])
    }
  }

  async listPermissionCodesForRole(roleId: string): Promise<string[]> {
    const { rows } = await this.db.query(`SELECT permission_code FROM authz.role_permission WHERE role_id = $1`, [roleId])
    return rows.map((r) => String(r['permission_code']))
  }

  async insertUserRole(tx: Queryable, input: NewUserRoleGrant): Promise<UserRoleGrantRow> {
    const { rows } = await tx.query(
      `INSERT INTO authz.user_role (user_id, role_id, org_scope_unit_id, granted_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id, user_id, role_id, org_scope_unit_id, granted_by, granted_at`,
      [input.userId, input.roleId, input.orgScopeUnitId, input.grantedBy],
    )
    const row = rows[0]
    if (!row) throw new Error('AuthzRepository.insertUserRole: no row returned')
    return mapUserRoleGrant(row)
  }

  /** Deletes every grant for this exact (user, role) pair — `DELETE /users/:id/roles/:roleId` revokes the role outright, regardless of how many org-scoped grants of it the user held. Returns the number of rows removed (0 if none matched — not an error, matching `RulesRepository.approve`'s no-op-on-miss shape). */
  async deleteUserRoleGrants(tx: Queryable, userId: string, roleId: string): Promise<number> {
    const { rows } = await tx.query(`DELETE FROM authz.user_role WHERE user_id = $1 AND role_id = $2`, [userId, roleId])
    return rows.length
  }

  /**
   * Every currently-held grant of `permission` for `userId`, as just the org
   * scope (`null` = self) — the raw material `AuthzService.decide` reduces
   * to a `Decision`. A `JOIN` against `role_permission`, not two round
   * trips, so "does this user's role carry this permission" and "what grants
   * does this user hold" can never observe two different points in time.
   */
  async findGrantsForUserPermission(userId: string, permission: string): Promise<Array<{ orgScopeUnitId: string | null }>> {
    const { rows } = await this.db.query(
      `SELECT ur.org_scope_unit_id
         FROM authz.user_role ur
         JOIN authz.role_permission rp ON rp.role_id = ur.role_id
        WHERE ur.user_id = $1 AND rp.permission_code = $2`,
      [userId, permission],
    )
    return rows.map((r) => ({
      orgScopeUnitId: r['org_scope_unit_id'] === null || r['org_scope_unit_id'] === undefined ? null : String(r['org_scope_unit_id']),
    }))
  }

  /** Every org unit as just `{id, parentId}` — the pure shape `org-tree.ts`'s `subtreeIds` walks. Never filtered: the whole tree is small (one tenant's org chart) and the walk itself is what decides scope, not this query. */
  async findAllOrgUnits(): Promise<OrgUnitNode[]> {
    const { rows } = await this.db.query(`SELECT id, parent_id FROM authz.org_unit`)
    return rows.map((r) => ({
      id: String(r['id']),
      parentId: r['parent_id'] === null || r['parent_id'] === undefined ? null : String(r['parent_id']),
    }))
  }

  /** Insert-if-absent by id (`ON CONFLICT (id) DO NOTHING`) — used by `AuthzService.applyEmployeeCreated` to maintain the org-tree read model from `employee.created`, whose payload carries only `orgUnitId` (no parent, no name; see that method's doc comment). Never overwrites a unit a real org-structure admin path might later populate with a name/parent. */
  async upsertOrgUnit(tx: Queryable, id: string, parentId: string | null, nameI18n: Record<string, unknown>, costCenter: string | null): Promise<OrgUnitRow> {
    const { rows } = await tx.query(
      `INSERT INTO authz.org_unit (id, parent_id, name_i18n, cost_center) VALUES ($1, $2, $3::jsonb, $4)
       ON CONFLICT (id) DO NOTHING
       RETURNING id, parent_id, name_i18n, cost_center`,
      [id, parentId, JSON.stringify(nameI18n), costCenter],
    )
    if (rows[0]) {
      const row = rows[0]
      return { id: String(row['id']), parentId: row['parent_id'] === null ? null : String(row['parent_id']), nameI18n: (row['name_i18n'] as Record<string, unknown>) ?? {}, costCenter: row['cost_center'] === null || row['cost_center'] === undefined ? null : String(row['cost_center']) }
    }
    // DO NOTHING hit (already existed) — RETURNING produced no row; fetch what's actually there.
    const { rows: existingRows } = await tx.query(`SELECT id, parent_id, name_i18n, cost_center FROM authz.org_unit WHERE id = $1`, [id])
    const existing = existingRows[0]
    if (!existing) throw new Error('AuthzRepository.upsertOrgUnit: row vanished after ON CONFLICT DO NOTHING')
    return { id: String(existing['id']), parentId: existing['parent_id'] === null ? null : String(existing['parent_id']), nameI18n: (existing['name_i18n'] as Record<string, unknown>) ?? {}, costCenter: existing['cost_center'] === null || existing['cost_center'] === undefined ? null : String(existing['cost_center']) }
  }
}
