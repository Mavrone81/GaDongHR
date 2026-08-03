import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'
import type { DocsClient, RenderContractRequest, RenderContractResult } from '../docs-client'

/** Records every render call it receives so a test can assert what was sent to svc-docs (e.g. that no S3 field was included in mergeFields). */
export function fakeDocsClient(): DocsClient & { calls: RenderContractRequest[] } {
  const calls: RenderContractRequest[] = []
  return {
    calls,
    render(req: RenderContractRequest): Promise<RenderContractResult> {
      calls.push(req)
      const sha256 = createHash('sha256').update(JSON.stringify(req)).digest('hex')
      return Promise.resolve({ id: randomUUID(), sha256 })
    },
  }
}
