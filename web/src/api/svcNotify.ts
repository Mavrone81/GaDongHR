import { useMemo } from 'react'
import { loadConfig } from '../env'
import { createApiClient } from './httpClient'
import type { ApiClient, AuthTokenSource } from './httpClient'
import { useAuth } from '../auth/AuthContext'

/**
 * Wire types mirroring `services/svc-notify/src/notify.repository.ts`'s
 * `NotificationRow`. Duplicated deliberately, not imported — same reasoning
 * as `svcConfig.ts`'s header. This is the HTTP contract, kept in sync by
 * hand.
 *
 * Both routes are self-scoped server-side by construction
 * (`notify.controller.ts`: the recipient is always the AUTHENTICATED
 * caller's own `req.userId`, never a request param) — this client never
 * sends a user id, matching that contract exactly.
 */
export interface NotificationRow {
  id: string
  recipientUserId: string
  kind: string
  lang: string
  subject: string
  body: string
  readAt: string | null
  createdAt: string
}

export interface SvcNotifyClient {
  list(unreadOnly?: boolean): Promise<NotificationRow[]>
  markRead(id: string): Promise<NotificationRow>
}

export function createSvcNotifyClient(baseUrl: string, tokens: AuthTokenSource): SvcNotifyClient {
  const client: ApiClient = createApiClient(baseUrl, tokens)
  return {
    async list(unreadOnly) {
      const query = unreadOnly ? '?unread=true' : ''
      const res = await client.request<{ notifications: NotificationRow[] }>(`/notifications${query}`)
      return res.notifications
    },
    async markRead(id) {
      return client.request<NotificationRow>(`/notifications/${encodeURIComponent(id)}/read`, { method: 'POST' })
    },
  }
}

export function useSvcNotify(): SvcNotifyClient {
  const { tokenSource } = useAuth()
  const baseUrl = useMemo(() => loadConfig().svcNotifyUrl, [])
  return useMemo(() => createSvcNotifyClient(baseUrl, tokenSource), [baseUrl, tokenSource])
}
