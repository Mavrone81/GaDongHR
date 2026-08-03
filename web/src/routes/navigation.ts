/**
 * The five screens `web/ui-coverage.json` declares. Only `/admin/statutory-rules`
 * has a real screen behind it today (task brief: "You are building the
 * shell plus `/admin/statutory-rules` only; the other four come next.").
 * The other four are wired to `ComingSoon` so role-driven nav can be
 * demonstrated across the full set without inventing four screens' worth
 * of scope — and so a permission grant for one of them is not silently
 * unreachable once its real screen lands (no manifest entry is removed).
 */
export interface NavDestination {
  path: string
  labelKey: string
  permission: string
}

export const NAV_DESTINATIONS: NavDestination[] = [
  { path: '/admin/statutory-rules', labelKey: 'shell.nav.statutoryRules', permission: 'config.rule.read' },
  { path: '/compliance/audit', labelKey: 'shell.nav.audit', permission: 'audit.read' },
  { path: '/documents', labelKey: 'shell.nav.documents', permission: 'document.read' },
  { path: '/admin/roles', labelKey: 'shell.nav.roles', permission: 'authz.role.read' },
  { path: '/notifications', labelKey: 'shell.nav.notifications', permission: 'notify.notification.read' },
]

/** The index route's redirect target — a named constant (not `NAV_DESTINATIONS[0].path`) so `noUncheckedIndexedAccess` doesn't need a non-null assertion at every call site. */
export const DEFAULT_NAV_PATH: string = NAV_DESTINATIONS[0]?.path ?? '/admin/statutory-rules'
