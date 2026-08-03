import type { ReactNode } from 'react'
import { useHasPermission } from '../auth/permissions'

/**
 * Route-level mirror of `Shell.tsx`'s nav gating: renders nothing (not an
 * error page) when the caller's permissions do not reach `permission` —
 * belt-and-braces alongside the nav link already being absent, for a user
 * who navigates to the URL directly. The real, unbypassable enforcement is
 * always the resource server's own `PermissionGuard`; this only prevents
 * the UI from offering an action the server would refuse.
 */
export function RequirePermission({ permission, children }: { permission: string; children: ReactNode }): React.JSX.Element | null {
  const allowed = useHasPermission(permission)
  return allowed ? <>{children}</> : null
}
