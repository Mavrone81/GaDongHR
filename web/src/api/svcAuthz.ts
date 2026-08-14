import { useMemo } from 'react'
import { loadConfig } from '../env'
import { createApiClient } from './httpClient'
import type { ApiClient, AuthTokenSource } from './httpClient'
import { useAuth } from '../auth/AuthContext'

/**
 * Wire types mirroring `services/svc-authz/src/authz.repository.ts`'s
 * `RoleRow`/`UserRoleGrantRow` and `authz.controller.ts`'s
 * `RoleWithPermissions`/`GrantRoleBody`. Duplicated deliberately, not
 * imported — same reasoning as `svcConfig.ts`'s header. This is the HTTP
 * contract, kept in sync by hand.
 *
 * NOTE ON SCOPE: `svc-authz` has no route that lists CURRENT grants (who
 * holds a role today) — only `POST /users/:id/roles` (grant, returns the
 * grant just made) and `DELETE /users/:id/roles/:roleId` (revoke). There is
 * also no user directory anywhere in this service. `RolesPage.tsx`'s grant/
 * revoke panels therefore identify a person only by the raw user id the
 * caller types in — see that component's header for the full gap.
 */
export interface RoleWithPermissions {
  id: string
  code: string
  nameI18n: Record<string, string>
  isSystem: boolean
  permissions: string[]
}

export interface UserRoleGrantRow {
  id: string
  userId: string
  roleId: string
  orgScopeUnitId: string | null
  grantedBy: string
  grantedAt: string
}

export interface SvcAuthzClient {
  listRoles(): Promise<RoleWithPermissions[]>
  grantRole(userId: string, roleId: string, grantedBy: string, orgScopeUnitId?: string | null): Promise<UserRoleGrantRow>
  revokeRole(userId: string, roleId: string): Promise<{ deleted: number }>
}

export function createSvcAuthzClient(baseUrl: string, tokens: AuthTokenSource): SvcAuthzClient {
  const client: ApiClient = createApiClient(baseUrl, tokens)
  return {
    async listRoles() {
      const res = await client.request<{ roles: RoleWithPermissions[] }>('/roles')
      return res.roles
    },
    async grantRole(userId, roleId, grantedBy, orgScopeUnitId) {
      return client.request<UserRoleGrantRow>(`/users/${encodeURIComponent(userId)}/roles`, {
        method: 'POST',
        body: JSON.stringify({ roleId, grantedBy, orgScopeUnitId: orgScopeUnitId ?? null }),
      })
    },
    async revokeRole(userId, roleId) {
      return client.request<{ deleted: number }>(
        `/users/${encodeURIComponent(userId)}/roles/${encodeURIComponent(roleId)}`,
        { method: 'DELETE' },
      )
    },
  }
}

export function useSvcAuthz(): SvcAuthzClient {
  const { tokenSource } = useAuth()
  const baseUrl = useMemo(() => loadConfig().svcAuthzUrl, [])
  return useMemo(() => createSvcAuthzClient(baseUrl, tokenSource), [baseUrl, tokenSource])
}
