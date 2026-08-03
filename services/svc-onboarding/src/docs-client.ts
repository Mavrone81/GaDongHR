/** Merge-field value shape `svc-docs`'s `POST /render` expects (`services/svc-docs/src/merge-fields.ts`). Duplicated here rather than imported — `svc-docs` is a sibling service, not a shared package, and this service must not import across a service boundary (roadmap: "No cross-schema queries" extends to no cross-service source imports either). */
export type DocsMergeFieldValue = { type: 'text'; value: string } | { type: 'date'; value: string } | { type: 'money'; value: number }

export interface RenderContractRequest {
  kind: string
  lang: 'th' | 'en' | 'zh'
  entityType: 'employee'
  entityId: string
  mergeFields: Record<string, DocsMergeFieldValue>
}

export interface RenderContractResult {
  id: string
  sha256: string
}

/**
 * Port to `svc-docs`'s `POST /render` (M1-4: contract generation). Injectable
 * (matching every other service-to-service port in this file set) so tests
 * never touch the network — `testing/fake-docs-client.ts` is the fake.
 */
export interface DocsClient {
  render(req: RenderContractRequest): Promise<RenderContractResult>
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/** Real HTTP implementation: `POST {baseUrl}/render`, the exact shape `services/svc-docs/src/documents.controller.ts`'s `render` serves. Requires `document.generate` in production (service-to-service auth wiring deferred, same as `config-client.ts`). */
export function createHttpDocsClient(baseUrl: string): DocsClient {
  return {
    async render(req: RenderContractRequest): Promise<RenderContractResult> {
      const res = await fetch(`${baseUrl}/render`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(req),
      })
      if (!res.ok) throw new Error(`svc-docs: POST /render responded ${String(res.status)}`)
      const body: unknown = await res.json()
      if (!isRecord(body) || typeof body['id'] !== 'string' || typeof body['sha256'] !== 'string') {
        throw new Error('svc-docs: POST /render returned an unexpected shape')
      }
      return { id: body['id'], sha256: body['sha256'] }
    },
  }
}
