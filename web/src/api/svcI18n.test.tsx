import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchBundle } from './svcI18n'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/**
 * THE gap `I18nContext.tsx`'s fallback chain did not cover: a fetch that
 * *succeeds* (200, valid JSON) with a body shape `t()` cannot use. Every
 * other test in this suite covers `fetchBundle` REJECTING (network down,
 * non-2xx, malformed JSON) — `I18nProvider` already warns and falls back
 * to `FALLBACK_BUNDLE` for all of those, and `I18nContext.test.tsx`
 * proves it. A 200 with an unusable body took neither path: `client.request`
 * only `JSON.parse`s and casts, so a still-nested bundle (`svc-i18n`'s own
 * on-disk shape — see `services/svc-i18n/bundles/en.json`), an error
 * envelope, an array, or a bare scalar all sailed straight through as if
 * they were `Record<string, string>`, with no warning ever logged — a
 * silent, undiagnosable form of the exact failure the reject-path already
 * handles loudly. `fetchBundle` must now validate the shape and reject,
 * so a garbage-but-200 response takes the SAME warned, tested,
 * fallback-producing path a network failure does.
 */
describe('fetchBundle — validates the response shape, not just the HTTP status', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('resolves normally for a valid flat string bundle', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { 'auth.login.title': 'Sign in' })))

    await expect(fetchBundle('en')).resolves.toEqual({ 'auth.login.title': 'Sign in' })
  })

  it('rejects when the 200 body is still nested (svc-i18n bundle shape), instead of silently accepting it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(200, { auth: { login: { title: 'Sign in' } }, shell: { brand: 'GaDongHR' } })),
    )

    await expect(fetchBundle('en')).rejects.toThrow(/unusable bundle shape/)
  })

  it('rejects when the 200 body is an array', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, ['Sign in', 'GaDongHR'])))

    await expect(fetchBundle('en')).rejects.toThrow(/unusable bundle shape/)
  })

  it('rejects when the 200 body has a non-string value (e.g. an error envelope shape)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { code: 'SVC-500', details: [] })))

    await expect(fetchBundle('en')).rejects.toThrow(/unusable bundle shape/)
  })

  it('rejects when the 200 body is a bare scalar', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, 'unavailable')))

    await expect(fetchBundle('en')).rejects.toThrow(/unusable bundle shape/)
  })

  it('rejects when the 200 body is null', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, null)))

    await expect(fetchBundle('en')).rejects.toThrow(/unusable bundle shape/)
  })
})
