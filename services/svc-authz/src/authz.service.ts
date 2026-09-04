import { AuditEmitter } from '@gadong/kernel'
import type { Queryable } from '@gadong/kernel'
import { AuthzRepository } from './authz.repository'
import type { NewUserRoleGrant, UserRoleGrantRow } from './authz.repository'
import { subtreeIds } from './org-tree'

/**
 * The wire shape `packages/kernel/src/authz/client.ts`'s `isDecision`
 * validates. Not imported from there — `Decision` is a plain data shape,
 * and duplicating its two fields here keeps this service compilable and
 * testable without a runtime dependency on the kernel's authz *client*
 * (only `idempotent`/`Queryable` are used from `@gadong/kernel`). The exact
 * field names and the `'*' | 'self' | string[]` union are what matter — see
 * `decide.wire-contract.test.ts` for the proof that this actually matches.
 */
export interface Decision {
  allowed: boolean
  scopeOrgUnitIds: string[] | '*' | 'self'
}

export interface EmployeeCreatedPayload {
  id: string
  orgUnitId: string
}

/** A fresh object every call — see kernel `authz/client.ts`'s identical note: a shared constant here would let one caller's mutation corrupt every other denied decision. */
function deniedDecision(): Decision {
  return { allowed: false, scopeOrgUnitIds: [] }
}

/**
 * The decision algorithm behind `POST /decide` (Task 8 brief §3). No SQL
 * here — `AuthzRepository` owns that (matching every other service's
 * `repository`/`service` split).
 *
 * `decide` is used directly by `AuthzController.decide()`, which is itself
 * the handler `kernel/authz/client.ts`'s `AuthzClient` calls over HTTP for
 * every permission check in every one of the other 14 services. A wrong
 * answer here is either a data breach (wrongly allow) or a product-wide
 * outage (wrongly deny everything) — see `decide.wire-contract.test.ts`.
 */
export class AuthzService {
  constructor(
    private readonly repo: AuthzRepository,
    private readonly audit: AuditEmitter = new AuditEmitter(),
  ) {}

  /**
   * `POST /users/:id/roles` — "grants and revocations (who granted what to
   * whom)" (roadmap audit-coverage brief). `after` carries the role id and
   * org scope (routing metadata, not S3 subject data), never anything about
   * the grantee beyond their id, which is already `entityId`.
   */
  async grantRole(tx: Queryable, input: NewUserRoleGrant, grantedByRole = 'unknown'): Promise<UserRoleGrantRow> {
    const row = await this.repo.insertUserRole(tx, input)

    await this.audit.emit(tx, 'authz', {
      actorId: input.grantedBy,
      actorRole: grantedByRole,
      action: 'role.granted',
      entity: 'user_role_grant',
      entityId: row.id,
      after: { userId: row.userId, roleId: row.roleId, orgScopeUnitId: row.orgScopeUnitId },
    })

    return row
  }

  /**
   * `DELETE /users/:id/roles/:roleId` — the other half of "grants and
   * revocations". `deleteUserRoleGrants` can remove more than one row (a
   * user may hold the same role at several org scopes); one audit entry
   * covers the whole revocation request, with the count it actually
   * affected — a single conceptual action, not N near-duplicate entries for
   * what the caller experienced as one DELETE.
   */
  async revokeRole(tx: Queryable, userId: string, roleId: string, revokedBy: string, revokedByRole = 'unknown'): Promise<number> {
    const deleted = await this.repo.deleteUserRoleGrants(tx, userId, roleId)

    await this.audit.emit(tx, 'authz', {
      actorId: revokedBy,
      actorRole: revokedByRole,
      action: 'role.revoked',
      entity: 'user_role_grant',
      entityId: userId,
      after: { roleId, grantsRemoved: deleted },
    })

    return deleted
  }

  /**
   * Task 8 brief §4, properties 1 and 3:
   *  1. Deny by default — an unknown permission code, or a known one with no
   *     matching grant, both resolve to `{allowed:false, scopeOrgUnitIds:[]}`.
   *     Never an error a caller might mistake for "allowed" (fail-closed).
   *  3. Org scoping is a subtree — every grant with `org_scope_unit_id IS
   *     NULL` contributes the `'self'` scope; every grant with a unit set
   *     contributes that unit's full subtree (`org-tree.ts`'s pure walk:
   *     the granted unit and every descendant, nothing above, nothing
   *     beside). If the user holds ANY org-scoped grant of this permission,
   *     the deduplicated union of every org-scoped subtree is returned —
   *     it strictly widens what `'self'` alone would have granted, so
   *     `'self'` never has to be intersected away, it simply loses to the
   *     wider org-scoped result when both are present.
   *
   * Any unexpected failure anywhere in this method — a bad row shape, a
   * repository throwing, a corrupt org-tree walk — is caught here and
   * turned into the same denial, never propagated as an exception. This is
   * intentionally duplicated as an outer catch in
   * `AuthzController.decide()` (belt-and-suspenders: `/decide` itself must
   * never throw either).
   */
  async decide(userId: string, permission: string): Promise<Decision> {
    try {
      const permissionRow = await this.repo.findPermissionByCode(permission)
      if (!permissionRow) return deniedDecision()

      const grants = await this.repo.findGrantsForUserPermission(userId, permission)
      if (grants.length === 0) return deniedDecision()

      const orgScopedUnitIds = grants
        .map((g) => g.orgScopeUnitId)
        .filter((id): id is string => id !== null)

      if (orgScopedUnitIds.length === 0) {
        return { allowed: true, scopeOrgUnitIds: 'self' }
      }

      const units = await this.repo.findAllOrgUnits()
      const scope = new Set<string>()
      for (const unitId of orgScopedUnitIds) {
        for (const id of subtreeIds(unitId, units)) scope.add(id)
      }
      return { allowed: true, scopeOrgUnitIds: [...scope] }
    } catch {
      return deniedDecision()
    }
  }

  /**
   * The caller's own permission codes, backing `GET /me/permissions`.
   *
   * Exists because the PWA had no way to ask this question: `web`'s
   * `CurrentUser.permissions` was populated from a `permissions` claim
   * that no token this realm issues actually carries (grants live here,
   * not in Keycloak), so every `RequirePermission` route and every gated
   * nav link rendered nothing for every real login. That was fail-safe
   * rather than fail-open, and documented as such in `AuthContext.tsx` —
   * but it made the whole admin UI unreachable in production.
   *
   * **Not an enforcement surface.** Nothing may be granted on the
   * strength of this list: it tells a UI what to *offer*, and every
   * request that follows is still decided independently by the resource
   * server's own `PermissionGuard` → `POST /decide`. A caller who lies to
   * itself about this response gains exactly nothing.
   *
   * Fails closed to `[]` like `decide()`, and for the same reason: an
   * unreadable grant table must never widen what a UI offers. The
   * consequence of a wrong answer here is a hidden menu item, never an
   * allowed action.
   */
  async listPermissionsForUser(userId: string): Promise<string[]> {
    try {
      return await this.repo.listPermissionCodesForUser(userId)
    } catch {
      return []
    }
  }

  /**
   * Task 8 brief §6: consumes `employee.created` to maintain `authz.org_unit`
   * as a local read model — this schema owns no foreign keys into any other
   * service's schema (roadmap "Database conventions": "No foreign keys
   * across schemas. No cross-schema queries."), so a grant scoped to an org
   * unit still needs that unit's id to resolve through `org-tree.ts` even
   * though the unit itself is authored elsewhere.
   *
   * The roadmap's `employee.created` payload
   * (`{id, empCode, orgUnitId, employmentType, provinceCode, startDate,
   * status, preferredLang}`) carries only `orgUnitId` — no parent, no name.
   * This handler can therefore only guarantee the unit *exists* in this
   * read model (`AuthzRepository.upsertOrgUnit`'s insert-if-absent), not
   * place it correctly in the hierarchy or name it. A future event actually
   * describing org-unit structure (not in the roadmap's event catalog yet)
   * would be the real source for `parentId`/`nameI18n`; until then this is
   * a best-effort stub that at minimum keeps `subtreeIds` from treating a
   * genuinely-referenced unit as entirely absent.
   *
   * Caller supplies `tx` (this method opens no transaction of its own,
   * matching `writeOutbox`/`idempotent`'s contract) and is expected to wrap
   * the call in the kernel's `idempotent()` — see
   * `authz.service.test.ts`'s triple-delivery test for the one-effect
   * property this yields (XC-EVENTS). Not invoked by any running consumer
   * loop: no service in this codebase has broker-consumer wiring yet (see
   * this task's report, "deviations").
   */
  async applyEmployeeCreated(tx: Queryable, payload: EmployeeCreatedPayload): Promise<void> {
    await this.repo.upsertOrgUnit(tx, payload.orgUnitId, null, {}, null)
  }
}
