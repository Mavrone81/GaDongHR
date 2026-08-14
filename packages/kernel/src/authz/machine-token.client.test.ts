import { createAuthenticatedFetch, createHttpTokenTransport, MachineTokenClient } from './machine-token.client'
import type { TokenResponse, TokenTransport } from './machine-token.client'

function fakeTransport(fetchToken: jest.Mock): TokenTransport {
  return { fetchToken }
}

describe('MachineTokenClient.getToken', () => {
  it('returns the access token the transport hands back', async () => {
    const fetchToken = jest.fn().mockResolvedValue({ accessToken: 'tok-1', expiresInSec: 300 } satisfies TokenResponse)
    const client = new MachineTokenClient(fakeTransport(fetchToken), { clientId: 'svc-onboarding', clientSecret: 's3cret' })

    await expect(client.getToken()).resolves.toBe('tok-1')
    expect(fetchToken).toHaveBeenCalledWith('svc-onboarding', 's3cret')
  })

  it('caches the token and does not re-call the transport for a second call within its lifetime', async () => {
    const fetchToken = jest.fn().mockResolvedValue({ accessToken: 'tok-1', expiresInSec: 300 } satisfies TokenResponse)
    const client = new MachineTokenClient(fakeTransport(fetchToken), { clientId: 'c', clientSecret: 's' })

    await client.getToken()
    await client.getToken()

    expect(fetchToken).toHaveBeenCalledTimes(1)
  })

  it('refreshes once the cached token is within the refresh skew of its reported expiry', async () => {
    let now = 0
    const fetchToken = jest
      .fn()
      .mockResolvedValueOnce({ accessToken: 'tok-1', expiresInSec: 100 } satisfies TokenResponse)
      .mockResolvedValueOnce({ accessToken: 'tok-2', expiresInSec: 100 } satisfies TokenResponse)
    const client = new MachineTokenClient(fakeTransport(fetchToken), {
      clientId: 'c',
      clientSecret: 's',
      now: () => now,
      refreshSkewSec: 30,
    })

    await expect(client.getToken()).resolves.toBe('tok-1')

    // Still comfortably inside the 100s lifetime minus the 30s skew (stale at 70s).
    now = 60_000
    await expect(client.getToken()).resolves.toBe('tok-1')
    expect(fetchToken).toHaveBeenCalledTimes(1)

    // Past the skew-adjusted staleness point — must refresh.
    now = 71_000
    await expect(client.getToken()).resolves.toBe('tok-2')
    expect(fetchToken).toHaveBeenCalledTimes(2)
  })

  it('single-flight: concurrent callers during a refresh share one transport call, not one each', async () => {
    let resolveFetch: (value: TokenResponse) => void = () => undefined
    const fetchToken = jest.fn().mockReturnValue(
      new Promise<TokenResponse>((resolve) => {
        resolveFetch = resolve
      }),
    )
    const client = new MachineTokenClient(fakeTransport(fetchToken), { clientId: 'c', clientSecret: 's' })

    const first = client.getToken()
    const second = client.getToken()
    const third = client.getToken()

    resolveFetch({ accessToken: 'tok-1', expiresInSec: 300 })

    await expect(Promise.all([first, second, third])).resolves.toEqual(['tok-1', 'tok-1', 'tok-1'])
    expect(fetchToken).toHaveBeenCalledTimes(1)
  })

  it('fails closed: a transport rejection propagates, never resolving to a placeholder token', async () => {
    const fetchToken = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    const client = new MachineTokenClient(fakeTransport(fetchToken), { clientId: 'c', clientSecret: 's' })

    await expect(client.getToken()).rejects.toThrow('ECONNREFUSED')
  })

  it('recovers on the next call after a failed refresh — a transient outage does not poison the client forever', async () => {
    const fetchToken = jest
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce({ accessToken: 'tok-1', expiresInSec: 300 } satisfies TokenResponse)
    const client = new MachineTokenClient(fakeTransport(fetchToken), { clientId: 'c', clientSecret: 's' })

    await expect(client.getToken()).rejects.toThrow('ECONNREFUSED')
    await expect(client.getToken()).resolves.toBe('tok-1')
    expect(fetchToken).toHaveBeenCalledTimes(2)
  })

  it('treats a missing/non-positive expires_in as a short-lived token, not a non-expiring one', async () => {
    let now = 0
    const fetchToken = jest
      .fn()
      .mockResolvedValueOnce({ accessToken: 'tok-1', expiresInSec: 0 } satisfies TokenResponse)
      .mockResolvedValueOnce({ accessToken: 'tok-2', expiresInSec: 300 } satisfies TokenResponse)
    const client = new MachineTokenClient(fakeTransport(fetchToken), { clientId: 'c', clientSecret: 's', now: () => now })

    await expect(client.getToken()).resolves.toBe('tok-1')
    now = 2_000 // past the MIN_CACHED_TTL_MS floor
    await expect(client.getToken()).resolves.toBe('tok-2')
    expect(fetchToken).toHaveBeenCalledTimes(2)
  })
})

describe('createHttpTokenTransport', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('POSTs a form-encoded client_credentials grant to the token url', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'tok-1', expires_in: 900 }),
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const transport = createHttpTokenTransport('https://issuer.test/token')
    await expect(transport.fetchToken('svc-payroll', 'sekret')).resolves.toEqual({ accessToken: 'tok-1', expiresInSec: 900 })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://issuer.test/token',
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=client_credentials&client_id=svc-payroll&client_secret=sekret',
      }),
    )
  })

  it('rejects on a non-2xx response', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }) as unknown as typeof fetch
    const transport = createHttpTokenTransport('https://issuer.test/token')
    await expect(transport.fetchToken('c', 's')).rejects.toThrow('401')
  })

  it('rejects when the response carries no access_token', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ token_type: 'bearer' }) }) as unknown as typeof fetch
    const transport = createHttpTokenTransport('https://issuer.test/token')
    await expect(transport.fetchToken('c', 's')).rejects.toThrow('no access_token')
  })
})

describe('createAuthenticatedFetch', () => {
  it('attaches a bearer token obtained from the token client to every request', async () => {
    const fetchToken = jest.fn().mockResolvedValue({ accessToken: 'tok-1', expiresInSec: 300 } satisfies TokenResponse)
    const tokenClient = new MachineTokenClient(fakeTransport(fetchToken), { clientId: 'c', clientSecret: 's' })
    const fetchImpl = jest.fn().mockResolvedValue(new Response('ok'))

    const authedFetch = createAuthenticatedFetch(tokenClient, fetchImpl as unknown as typeof fetch)
    await authedFetch('https://svc-config.internal/rules/foo')

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://svc-config.internal/rules/foo')
    expect((init.headers as Headers).get('authorization')).toBe('Bearer tok-1')
  })

  it('preserves caller-supplied method/body/headers alongside the injected credential', async () => {
    const fetchToken = jest.fn().mockResolvedValue({ accessToken: 'tok-1', expiresInSec: 300 } satisfies TokenResponse)
    const tokenClient = new MachineTokenClient(fakeTransport(fetchToken), { clientId: 'c', clientSecret: 's' })
    const fetchImpl = jest.fn().mockResolvedValue(new Response('ok'))

    const authedFetch = createAuthenticatedFetch(tokenClient, fetchImpl as unknown as typeof fetch)
    await authedFetch('https://svc-docs.internal/render', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ a: 1 }),
    })

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(init.method).toBe('POST')
    expect(init.body).toBe(JSON.stringify({ a: 1 }))
    expect((init.headers as Headers).get('content-type')).toBe('application/json')
    expect((init.headers as Headers).get('authorization')).toBe('Bearer tok-1')
  })

  it('never calls fetch at all when the token client fails closed', async () => {
    const fetchToken = jest.fn().mockRejectedValue(new Error('issuer down'))
    const tokenClient = new MachineTokenClient(fakeTransport(fetchToken), { clientId: 'c', clientSecret: 's' })
    const fetchImpl = jest.fn()

    const authedFetch = createAuthenticatedFetch(tokenClient, fetchImpl as unknown as typeof fetch)
    await expect(authedFetch('https://svc-config.internal/rules/foo')).rejects.toThrow('issuer down')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
