/**
 * The five screens `web/ui-coverage.json` declares. `/admin/statutory-rules`
 * shipped first; `/compliance/audit`, `/documents`, `/admin/roles` and
 * `/notifications` (the four `App.tsx` used to wire to `ComingSoon` —
 * "the other four come next") now each have a real screen behind them too
 * — see `routes/compliance/AuditPage.tsx`, `routes/documents/DocumentsPage.tsx`,
 * `routes/admin/RolesPage.tsx` and `routes/notifications/NotificationsPage.tsx`
 * for what each one's backing API actually supports, and where it falls
 * short of the destination's name. `ComingSoon` itself is now reachable
 * only via the catch-all route (`App.tsx`'s `path="*"`).
 */
export interface NavDestination {
  path: string
  labelKey: string
  permission: string
}

export const NAV_DESTINATIONS: NavDestination[] = [
  // M1 Onboarding, added when svc-onboarding was first served. It leads
  // the list because it is where a working day starts (and where UAT pack
  // U2 starts) — the four that follow are admin and compliance surfaces.
  { path: '/onboarding/employees', labelKey: 'shell.nav.employees', permission: 'employee.read' },
  { path: '/admin/statutory-rules', labelKey: 'shell.nav.statutoryRules', permission: 'config.rule.read' },
  { path: '/compliance/audit', labelKey: 'shell.nav.audit', permission: 'audit.read' },
  { path: '/documents', labelKey: 'shell.nav.documents', permission: 'document.read' },
  { path: '/admin/roles', labelKey: 'shell.nav.roles', permission: 'authz.role.read' },
  { path: '/notifications', labelKey: 'shell.nav.notifications', permission: 'notify.notification.read' },
]

/** The index route's redirect target — a named constant (not `NAV_DESTINATIONS[0].path`) so `noUncheckedIndexedAccess` doesn't need a non-null assertion at every call site. */
export const DEFAULT_NAV_PATH: string = NAV_DESTINATIONS[0]?.path ?? '/onboarding/employees'
