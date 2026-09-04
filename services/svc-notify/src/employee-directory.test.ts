import { HttpEmployeeDirectory, NOTIFY_EMAIL_PURPOSE } from './employee-directory'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/**
 * An employee's email is S2-class PII, which the roadmap's data
 * classification says must be "fetched by ID through the owning service's
 * audited API" — never by reaching into another service's schema, which
 * this service could not do anyway. svc-onboarding's
 * `GET /employees/:id/sensitive` makes the `purpose` mandatory and writes
 * it into the audit chain, so these tests pin the purpose travelling on
 * the wire as firmly as they pin the address coming back: a lookup that
 * silently dropped it would still work, and would quietly break the PDPA
 * property the endpoint exists to provide.
 */
describe('HttpEmployeeDirectory', () => {
  it('requests only the email field, and carries the mandatory audit purpose', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(200, { email: 'somchai@example.co.th' }))
    const directory = new HttpEmployeeDirectory('http://svc-onboarding:3000', fetchImpl as unknown as typeof fetch)

    await directory.lookupEmail('emp-1')

    const url = String((fetchImpl.mock.calls[0] as unknown[])[0])
    expect(url).toContain('/employees/emp-1/sensitive')
    expect(url).toContain('fields=email')
    expect(url).toContain(`purpose=${encodeURIComponent(NOTIFY_EMAIL_PURPOSE)}`)
  })

  it('returns the address from a well-shaped response', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(200, { email: 'somchai@example.co.th' }))
    const directory = new HttpEmployeeDirectory('http://svc-onboarding:3000', fetchImpl as unknown as typeof fetch)

    await expect(directory.lookupEmail('emp-1')).resolves.toBe('somchai@example.co.th')
  })

  it('url-encodes the employee id rather than interpolating it raw', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(200, { email: 'x@example.co.th' }))
    const directory = new HttpEmployeeDirectory('http://svc-onboarding:3000', fetchImpl as unknown as typeof fetch)

    await directory.lookupEmail('emp/../admin')

    expect(String((fetchImpl.mock.calls[0] as unknown[])[0])).toContain('emp%2F..%2Fadmin')
  })

  it('does not double up the slash when the base url has a trailing one', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(200, { email: 'x@example.co.th' }))
    const directory = new HttpEmployeeDirectory('http://svc-onboarding:3000/', fetchImpl as unknown as typeof fetch)

    await directory.lookupEmail('emp-1')

    expect(String((fetchImpl.mock.calls[0] as unknown[])[0])).toContain('3000/employees/emp-1/sensitive')
  })

  it('treats a 404 as "no address", not an outage — the recipient may be a system account or a PDPA-erased record', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(new Response('', { status: 404 }))
    const directory = new HttpEmployeeDirectory('http://svc-onboarding:3000', fetchImpl as unknown as typeof fetch)

    await expect(directory.lookupEmail('emp-gone')).resolves.toBeNull()
  })

  it.each([[{ email: null }], [{ email: '' }], [{ email: '   ' }], [{ email: 42 }], [{}], [[]], [null]])(
    'returns null for a 200 whose body carries no usable address (%p) rather than passing it to SMTP',
    async (body) => {
      const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(200, body))
      const directory = new HttpEmployeeDirectory('http://svc-onboarding:3000', fetchImpl as unknown as typeof fetch)

      await expect(directory.lookupEmail('emp-1')).resolves.toBeNull()
    },
  )

  it.each([401, 403, 500, 503])('throws on HTTP %i, so the caller can record an outage distinctly from a missing address', async (status) => {
    const fetchImpl = jest.fn().mockResolvedValue(new Response('', { status }))
    const directory = new HttpEmployeeDirectory('http://svc-onboarding:3000', fetchImpl as unknown as typeof fetch)

    await expect(directory.lookupEmail('emp-1')).rejects.toThrow(String(status))
  })
})
