import { HttpDocsClient } from './ports'

/**
 * Regression tests for two real defects found wiring this call site into a
 * real e2e run, past the S2S auth fix (see `HttpDocsClient`'s own doc
 * comment for the full account):
 *
 *   1. The request body svc-docs's real `POST /render` accepts is
 *      `{kind, lang, entityType, entityId, mergeFields | html}` — this
 *      client used to send `{kind, entityId, lang, html}` with no
 *      `entityType` and no way to reach the (then-nonexistent) `html`
 *      input at all.
 *   2. The response body svc-docs's real `POST /render` returns is
 *      `{id, kind, entityType, entityId, lang, sha256}` — there has never
 *      been a `fileRef` field in it. This client used to read
 *      `body.fileRef`, which is always `undefined` against the real
 *      service, so every real call failed with "svc-docs returned no
 *      fileRef for a rendered payslip" even once the request body was
 *      fixed.
 *
 * Both were invisible before now: this file had zero unit tests, and the
 * e2e suite could not reach this call until two earlier, unrelated defects
 * (the timesheet-lock period mismatch, then this file's own request-body
 * shape) were fixed first.
 */
function fakeFetch(handler: (url: string, init: RequestInit | undefined) => { status: number; body?: unknown }): typeof fetch {
  return (async (input: string, init?: RequestInit) => {
    const response = handler(String(input), init)
    return {
      status: response.status,
      ok: response.status >= 200 && response.status < 300,
      json: async () => response.body,
    } as Response
  }) as typeof fetch
}

describe('HttpDocsClient.renderPayslip', () => {
  it('POSTs {kind, entityType, entityId, lang, html} to {baseUrl}/render — the real svc-docs request shape', async () => {
    let capturedUrl = ''
    let capturedBody: unknown
    const client = new HttpDocsClient(
      'http://svc-docs',
      fakeFetch((url, init) => {
        capturedUrl = url
        capturedBody = JSON.parse(String(init?.body))
        return { status: 200, body: { id: 'doc-1', kind: 'payslip', entityType: 'payslip', entityId: 'payslip-1', lang: 'th', sha256: 'a'.repeat(64) } }
      }),
    )

    await client.renderPayslip({ payslipId: 'payslip-1', lang: 'th', html: '<article>payslip</article>' })

    expect(capturedUrl).toBe('http://svc-docs/render')
    expect(capturedBody).toEqual({
      kind: 'payslip',
      entityType: 'payslip',
      entityId: 'payslip-1',
      lang: 'th',
      html: '<article>payslip</article>',
    })
  })

  it('reads the real response shape\'s "id" (not the nonexistent "fileRef") and returns it as fileRef — the key payslip.pdf_ref stores for a later GET /documents/:id', async () => {
    const client = new HttpDocsClient(
      'http://svc-docs',
      fakeFetch(() => ({
        status: 201,
        body: { id: 'doc-real-id', kind: 'payslip', entityType: 'payslip', entityId: 'payslip-1', lang: 'th', sha256: 'a'.repeat(64) },
      })),
    )

    const result = await client.renderPayslip({ payslipId: 'payslip-1', lang: 'th', html: '<article/>' })
    expect(result).toEqual({ fileRef: 'doc-real-id' })
  })

  it('throws if svc-docs responds ok but with no "id" — never silently stores an empty pdf_ref', async () => {
    const client = new HttpDocsClient(
      'http://svc-docs',
      fakeFetch(() => ({ status: 200, body: { kind: 'payslip' } })),
    )
    await expect(client.renderPayslip({ payslipId: 'payslip-1', lang: 'th', html: '<article/>' })).rejects.toThrow(/no document id/)
  })

  it('throws on a non-2xx response, naming the payslip id in the error', async () => {
    const client = new HttpDocsClient(
      'http://svc-docs',
      fakeFetch(() => ({ status: 500, body: { message: 'Internal server error' } })),
    )
    await expect(client.renderPayslip({ payslipId: 'payslip-1', lang: 'th', html: '<article/>' })).rejects.toThrow(/500.*payslip-1/)
  })
})
