import { useMemo } from 'react'
import { loadConfig } from '../env'
import { createApiClient } from './httpClient'
import type { ApiClient, AuthTokenSource } from './httpClient'
import { useAuth } from '../auth/AuthContext'

/**
 * Wire types mirroring `services/svc-docs/src/documents.controller.ts`'s
 * `RenderRequestBody`/`RenderResponseBody`/`DocumentResponseBody`.
 * Duplicated deliberately, not imported — same reasoning as `svcConfig.ts`'s
 * header. This is the HTTP contract, kept in sync by hand.
 */
export type DocLocale = 'th' | 'en' | 'zh'

export interface RenderDocumentInput {
  kind: string
  lang: DocLocale
  entityType: string
  entityId: string
  /** Caller-owned HTML — the only render path this client exposes. `documents.controller.ts`'s `mergeFields` path needs per-template field knowledge (`services/svc-docs/src/templates/*`) this app has no way to know generically, so it is deliberately not offered here — see `DocumentsPage.tsx`'s header. */
  html: string
}

export interface RenderDocumentResult {
  id: string
  kind: string
  entityType: string
  entityId: string
  lang: string
  sha256: string
}

export interface DocumentMeta {
  id: string
  kind: string
  entityType: string
  entityId: string
  lang: string
  sha256: string
  createdAt: string
  /** Base64-encoded PDF bytes — decoded client-side into a `Blob` for download (`DocumentsPage.tsx`). */
  contentBase64: string
}

export interface SvcDocsClient {
  render(input: RenderDocumentInput): Promise<RenderDocumentResult>
  /**
   * `purpose` is sent as an optional `?purpose=` query param — forward
   * compatible, not currently consumed: `DocumentsController.getById`
   * (as shipped today) takes no `@Query('purpose')` at all, and
   * `DocumentsService.getDocument` always records the fixed
   * `DOCUMENT_READ_PURPOSE` ('document.read') against the svc-crypto
   * decrypt regardless of what a caller sends here. Sent anyway (task
   * brief: "build the purpose UI now either way, it's the correct PDPA
   * pattern") — an unrecognised query param on this route is simply
   * ignored server-side, never rejected, so this is safe today and takes
   * effect the moment that route is extended to read it.
   */
  getDocument(id: string, purpose?: string): Promise<DocumentMeta>
}

export function createSvcDocsClient(baseUrl: string, tokens: AuthTokenSource): SvcDocsClient {
  const client: ApiClient = createApiClient(baseUrl, tokens)
  return {
    async render(input) {
      return client.request<RenderDocumentResult>('/render', { method: 'POST', body: JSON.stringify(input) })
    },
    async getDocument(id, purpose) {
      const query = purpose ? `?purpose=${encodeURIComponent(purpose)}` : ''
      return client.request<DocumentMeta>(`/documents/${encodeURIComponent(id)}${query}`)
    },
  }
}

export function useSvcDocs(): SvcDocsClient {
  const { tokenSource } = useAuth()
  const baseUrl = useMemo(() => loadConfig().svcDocsUrl, [])
  return useMemo(() => createSvcDocsClient(baseUrl, tokenSource), [baseUrl, tokenSource])
}
