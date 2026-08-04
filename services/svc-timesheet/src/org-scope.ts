/**
 * M3-5 / roadmap security gap: `PermissionGuard` (kernel) answers "may this
 * user perform this action" — it never answers "on this row". `AuthzClient.
 * decide()` DOES return `scopeOrgUnitIds` (`Decision.scopeOrgUnitIds:
 * string[] | '*' | 'self'`), but nothing in the guard consumes it; it is
 * computed by `svc-authz` and then thrown away by every service that has
 * called `decide()` so far (per the coordinator's own audit).
 *
 * This module is `svc-timesheet`'s fix for exactly the case the brief calls
 * out by name: "a manager must see their team and not the whole company."
 * `TimesheetController` calls `AuthzClient.decide()` a SECOND time (the
 * first call already happened inside `PermissionGuard`, for the boolean
 * gate) to obtain the `Decision.scopeOrgUnitIds` this module needs, then
 * `ViewsService`/`ExceptionsService` apply it as a REPOSITORY-LEVEL filter
 * — `DayRecordRepository.findByEmployeesAndRange`'s `employeeIds` parameter
 * — not a post-hoc filter on an already-fetched, already-leaked result set.
 *
 * What this closes, and what it does NOT: this makes svc-timesheet's own
 * team/org views correctly row-scoped. It does NOT fix `PermissionGuard`
 * itself (out of this service's directory — `packages/kernel` — per the
 * brief's ownership boundary) and does NOT give svc-timesheet a way to avoid
 * a second `decide()` call (the guard's own decision is discarded before
 * this code ever runs); that duplicate call is cheap in practice
 * (`AuthzClient` caches per `userId permission` for `DECISION_CACHE_TTL_MS`,
 * so the second call is a cache hit in the overwhelmingly common case) but
 * it is real, avoidable cost that only a kernel-level fix (the guard
 * attaching its `Decision` to the request object) can remove. Flagged in the
 * task report as the piece this service cannot close on its own.
 */
export type OrgScope = string[] | '*' | 'self'

/** Whether `scope` permits acting on/viewing `orgUnitId` as a WHOLE UNIT (a manager's team view, an HR org-unit filter). `'self'` never does — a self-only grant has no org-unit-level view by definition. */
export function scopeAllowsOrgUnit(scope: OrgScope, orgUnitId: string): boolean {
  if (scope === '*') return true
  if (scope === 'self') return false
  return scope.includes(orgUnitId)
}

/** Whether `scope` permits `callerId` to view `targetEmployeeId` (whose own org unit is `targetOrgUnitId`, `null` if unknown — e.g. no `timesheet_employee_ref` row has synced yet, which this function treats as NOT in scope for an org-unit-based grant, fail-closed). */
export function scopeAllowsEmployee(scope: OrgScope, callerId: string, targetEmployeeId: string, targetOrgUnitId: string | null): boolean {
  if (scope === '*') return true
  if (scope === 'self') return callerId === targetEmployeeId
  return targetOrgUnitId !== null && scope.includes(targetOrgUnitId)
}

/** Resolves `scope` down to the concrete list of employee ids a caller may see, or `null` meaning "every employee" (only for `scope === '*'`) — the shape `DayRecordRepository.findByEmployeesAndRange`/`ExceptionRepository.findByStatusAndEmployees` take directly. `lookupByOrgUnits` is injected so this stays free of any repository dependency (pure composition, easy to test). */
export async function resolveScopedEmployeeIds(
  scope: OrgScope,
  callerId: string,
  lookupByOrgUnits: (orgUnitIds: string[]) => Promise<string[]>,
): Promise<string[] | null> {
  if (scope === '*') return null
  if (scope === 'self') return [callerId]
  if (scope.length === 0) return []
  return lookupByOrgUnits(scope)
}
