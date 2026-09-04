import { useAuth } from './AuthContext'

/**
 * Role-driven navigation (task brief): true only when the signed-in
 * user's permission set (`CurrentUser.permissions` — see `AuthContext.tsx`'s
 * header for exactly where that comes from and its known limitation)
 * contains `code`. Used to hide, not merely disable, a nav destination or
 * action the user would be 403'd on — "a user without `config.rule.approve`
 * must not see an Approve button they will be 403'd on."
 */
export function useHasPermission(code: string): boolean {
  const { currentUser } = useAuth()
  return currentUser?.permissions.has(code) ?? false
}

/**
 * Reads the signed-in caller's own permission codes from svc-authz's
 * `GET /me/permissions`. This is the `/me`-shaped endpoint
 * `AuthContext.tsx` used to describe as missing: without it the token
 * carried no `permissions` claim (this realm issues none — grants live in
 * svc-authz's DB), so every gated route and nav link rendered nothing.
 *
 * Returns `null` — not an empty set — on ANY failure: network error,
 * non-2xx, or a body that is not shaped `{permissions: string[]}`. The
 * caller keeps whatever set it already had rather than replacing it with
 * an empty one, so a blip in svc-authz cannot silently strip a working
 * session's menu. An empty set is only ever adopted when svc-authz
 * genuinely answers with one, which is the honest answer for a user
 * holding no grants.
 *
 * The distinction matters because `null` and `new Set()` would otherwise
 * both read as "no permissions" at the call site while meaning opposite
 * things — "we don't know" versus "we asked, and none".
 */
export async function fetchPermissions(authzBaseUrl: string, accessToken: string): Promise<Set<string> | null> {
  try {
    const res = await fetch(`${authzBaseUrl.replace(/\/+$/, '')}/me/permissions`, {
      headers: { authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) return null
    const body: unknown = await res.json()
    if (typeof body !== 'object' || body === null) return null
    const raw = (body as { permissions?: unknown }).permissions
    if (!Array.isArray(raw)) return null
    return new Set(raw.filter((p): p is string => typeof p === 'string'))
  } catch {
    return null
  }
}
