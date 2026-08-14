import type { AuthzScope } from './client'

export type { AuthzScope }

/**
 * THE GAP this module closes, kernel-wide (roadmap "🔴 Open security gap —
 * permissions are too coarse for row-level access"): `PermissionGuard`
 * (`guard.ts`) answers "may this user perform this action", never "may this
 * user perform it on *this row*". `AuthzClient.decide()` DOES return
 * `Decision.scopeOrgUnitIds` — which org-unit subtree (or `'*'`/`'self'`) a
 * grant covers — and the guard now attaches it to the request as
 * `request.authzScope` (see `guard.ts`). This module is the OTHER half of
 * the fix: the pure, dependency-free functions every service's controller
 * or repository layer applies that scope with, so the SQL WHERE-constraint
 * pattern is written once here rather than reinvented (and inevitably
 * drifting) per service.
 *
 * This is a straight generalization of `svc-timesheet`'s own
 * `src/org-scope.ts` — the one service in this codebase that had already
 * built this locally, via a second `AuthzClient.decide()` call, because the
 * guard threw the `Decision` away (see that file's own doc comment, which
 * names this exact kernel-level fix as the piece it could not close on its
 * own). `svc-timesheet`'s file is left as-is (its own tests pin its exact
 * behaviour); new consumers (`svc-docs`, `svc-onboarding`, and every future
 * service) should use THIS module instead of re-deriving it.
 *
 * **Design decision — required, not optional, parameters.** Every function
 * here takes `scope` as its first positional argument with no default. A
 * repository method that reads employee- or org-unit-scoped rows should
 * mirror this: `scope: AuthzScope` as a REQUIRED parameter, never
 * `scope?: AuthzScope`. TypeScript strict mode then makes "forgot to pass a
 * scope" a compile error, not a runtime gap — the unscoped code path is
 * unwritable, not merely discouraged. An optional parameter with an
 * `'*'`-like default would recreate exactly the bug this module exists to
 * close, just one layer down.
 */

/**
 * Whether `scope` permits acting on/viewing `orgUnitId` as a WHOLE UNIT (a
 * manager's team view, an HR org-unit filter). `'self'` never does — a
 * self-only grant has no org-unit-level view by definition.
 */
export function scopeAllowsOrgUnit(scope: AuthzScope, orgUnitId: string): boolean {
  if (scope === '*') return true
  if (scope === 'self') return false
  return scope.includes(orgUnitId)
}

/**
 * Whether `scope` permits `callerId` to view/act on `targetEmployeeId`
 * (whose own org unit is `targetOrgUnitId`, `null` if unknown — e.g. no
 * local employee read-model row has synced yet, which this function treats
 * as NOT in scope for an org-unit-based grant: fail closed, never fail
 * open on missing data).
 */
export function scopeAllowsEmployee(
  scope: AuthzScope,
  callerId: string,
  targetEmployeeId: string,
  targetOrgUnitId: string | null,
): boolean {
  if (scope === '*') return true
  if (scope === 'self') return callerId === targetEmployeeId
  return targetOrgUnitId !== null && scope.includes(targetOrgUnitId)
}

/**
 * Resolves `scope` down to the concrete list of employee ids a caller may
 * see, or `null` meaning "every employee" (only for `scope === '*'`) — the
 * shape a `findByEmployees(...)`-style repository method takes directly.
 * `lookupByOrgUnits` is injected so this stays free of any repository
 * dependency (pure composition, easy to test) — a service supplies its own
 * org-unit → employee-id lookup (typically a local, event-fed read model;
 * see `svc-timesheet`'s `employee-ref.repository.ts` for the established
 * pattern, since "No foreign keys across schemas. No cross-schema queries"
 * (roadmap "Database conventions") means a service cannot just join into
 * another service's employee table).
 */
export async function resolveScopedEmployeeIds(
  scope: AuthzScope,
  callerId: string,
  lookupByOrgUnits: (orgUnitIds: string[]) => Promise<string[]>,
): Promise<string[] | null> {
  if (scope === '*') return null
  if (scope === 'self') return [callerId]
  if (scope.length === 0) return []
  return lookupByOrgUnits(scope)
}
