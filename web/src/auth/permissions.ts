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
