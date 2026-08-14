import { useMemo } from 'react'
import { loadConfig } from '../env'
import { createApiClient } from './httpClient'
import type { ApiClient, AuthTokenSource } from './httpClient'
import { useAuth } from '../auth/AuthContext'

/**
 * Wire types mirroring `services/svc-audit/src/chain.ts`'s `StoredEntry`/
 * `ChainIssue`/`VerifyResult` and `entries.service.ts`'s `ListEntriesInput`/
 * `ListEntriesResult`. Duplicated deliberately, not imported — same reason
 * `svcConfig.ts`'s header gives: `services/svc-audit` is out of `web`'s
 * ownership, and importing server-only source into a browser bundle is not
 * an option. This is the HTTP contract, kept in sync by hand.
 *
 * NOTE ON SCOPE: `GET /entries` (`entries.repository.ts`'s `EntryFilters`)
 * only accepts `entity`/`entityId`/`from`/`to` as server-side filters — there
 * is no `actor`/`action` query param on this route. `AuditPage.tsx`'s "quick
 * filter" narrows by actor/action CLIENT-SIDE, over whatever page is already
 * loaded — see that component's header for why this is not the same thing
 * as a server-side filter, and is labelled accordingly.
 */
export interface AuditEntryRow {
  id: string
  occurredAt: string
  actorId: string
  actorRole: string
  action: string
  entity: string
  entityId: string
  purpose: string | null
  beforeHash: string | null
  afterHash: string | null
  prevEntryHash: string
  entryHash: string
}

export interface ListEntriesFilters {
  entity?: string
  entityId?: string
  from?: string
  to?: string
  page?: number
}

export interface ListEntriesResult {
  entries: AuditEntryRow[]
  page: number
}

/** `entries.repository.ts`'s `PAGE_SIZE` — duplicated so `AuditPage.tsx` can tell "this may not be the last page" (`entries.length === PAGE_SIZE`) from "this is the last page" without the server ever stating a total count (`/entries` returns none). */
export const AUDIT_PAGE_SIZE = 50

export type ChainIssueKind = 'content_mismatch' | 'chain_break'

export interface ChainIssue {
  entryId: string
  kind: ChainIssueKind
  message: string
}

export interface VerifyResult {
  valid: boolean
  entryCount: number
  issues: ChainIssue[]
}

export interface SvcAuditClient {
  listEntries(filters: ListEntriesFilters): Promise<ListEntriesResult>
  verify(): Promise<VerifyResult>
}

export function createSvcAuditClient(baseUrl: string, tokens: AuthTokenSource): SvcAuditClient {
  const client: ApiClient = createApiClient(baseUrl, tokens)
  return {
    async listEntries(filters) {
      const params = new URLSearchParams()
      if (filters.entity) params.set('entity', filters.entity)
      if (filters.entityId) params.set('entityId', filters.entityId)
      if (filters.from) params.set('from', filters.from)
      if (filters.to) params.set('to', filters.to)
      if (filters.page !== undefined) params.set('page', String(filters.page))
      const query = params.toString()
      return client.request<ListEntriesResult>(`/entries${query ? `?${query}` : ''}`)
    },
    async verify() {
      return client.request<VerifyResult>('/verify')
    },
  }
}

export function useSvcAudit(): SvcAuditClient {
  const { tokenSource } = useAuth()
  const baseUrl = useMemo(() => loadConfig().svcAuditUrl, [])
  return useMemo(() => createSvcAuditClient(baseUrl, tokenSource), [baseUrl, tokenSource])
}
