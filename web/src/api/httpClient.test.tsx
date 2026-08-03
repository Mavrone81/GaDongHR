import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, createApiClient } from './httpClient'
import type { AuthTokenSource } from './httpClient'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('httpClient 401 handling', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('attaches the bearer token from the token source on every request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    const tokens: AuthTokenSource = {
      getAccessToken: () => 'access-1',
      refresh: vi.fn(),
      onUnauthorized: vi.fn(),
    }
    const client = createApiClient('https://api.example', tokens)

    await client.request('/rules')

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const headers = new Headers(init.headers)
    expect(headers.get('Authorization')).toBe('Bearer access-1')
  })

  it('a 401 that a refresh cannot fix calls onUnauthorized and throws — not a silent failure or a hang', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(401, { code: 'AUZ-401', message_i18n_key: 'x', details: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const onUnauthorized = vi.fn()
    const tokens: AuthTokenSource = {
      getAccessToken: () => 'expired-token',
      refresh: vi.fn().mockResolvedValue(null), // refresh cannot recover the session
      onUnauthorized,
    }
    const client = createApiClient('https://api.example', tokens)

    await expect(client.request('/rules')).rejects.toBeInstanceOf(ApiError)
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
  })

  it('a 401 that DOES refresh successfully retries once with the new token and never calls onUnauthorized', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, { code: 'AUZ-401', message_i18n_key: 'x', details: [] }))
      .mockResolvedValueOnce(jsonResponse(200, { rules: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const onUnauthorized = vi.fn()
    const tokens: AuthTokenSource = {
      getAccessToken: () => 'expired-token',
      refresh: vi.fn().mockResolvedValue('fresh-token'),
      onUnauthorized,
    }
    const client = createApiClient('https://api.example', tokens)

    const result = await client.request<{ rules: unknown[] }>('/rules')

    expect(result).toEqual({ rules: [] })
    expect(onUnauthorized).not.toHaveBeenCalled()
    const secondCallInit = fetchMock.mock.calls[1]?.[1] as RequestInit
    expect(new Headers(secondCallInit.headers).get('Authorization')).toBe('Bearer fresh-token')
  })
})
