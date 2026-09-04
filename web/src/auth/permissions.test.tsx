import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchPermissions } from './permissions'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/**
 * `fetchPermissions` is the client half of the fix for the defect that made
 * the entire admin UI unreachable in production: `CurrentUser.permissions`
 * was populated from a `permissions` claim that no token this realm issues
 * carries, so every `RequirePermission` route rendered `null` and every
 * gated nav destination stayed hidden — for every user, on every screen.
 *
 * The distinction these tests exist to pin is `null` vs `new Set()`. Both
 * read as "no permissions" at a glance, and they mean opposite things:
 * `null` is "we could not find out, keep what you had", `new Set()` is
 * "we asked, and this user genuinely holds none". Collapsing the two would
 * mean a momentary svc-authz blip silently strips a working session's menu
 * — the same class of silent, undiagnosable failure `svcI18n.test.tsx`
 * documents for a 200-with-an-unusable-body.
 */
describe('fetchPermissions — distinguishes "could not ask" from "asked, and none"', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns the codes as a Set for a well-shaped response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { permissions: ['config.rule.read', 'audit.read'] })))

    const out = await fetchPermissions('/api/authz', 'token')

    expect(out).toEqual(new Set(['config.rule.read', 'audit.read']))
  })

  it('returns an EMPTY SET, not null, when the server genuinely reports no grants', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { permissions: [] })))

    const out = await fetchPermissions('/api/authz', 'token')

    expect(out).toEqual(new Set())
    expect(out).not.toBeNull()
  })

  it('sends the access token as a bearer header — the endpoint derives the user id from it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { permissions: [] }))
    vi.stubGlobal('fetch', fetchMock)

    await fetchPermissions('/api/authz', 'the-access-token')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/authz/me/permissions',
      expect.objectContaining({ headers: { authorization: 'Bearer the-access-token' } }),
    )
  })

  it('does not double up the slash when the base url has a trailing one', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { permissions: [] }))
    vi.stubGlobal('fetch', fetchMock)

    await fetchPermissions('/api/authz/', 'token')

    expect(fetchMock).toHaveBeenCalledWith('/api/authz/me/permissions', expect.anything())
  })

  it('returns null on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(503, { code: 'AUZ-503' })))

    await expect(fetchPermissions('/api/authz', 'token')).resolves.toBeNull()
  })

  it('returns null when the network call rejects outright', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))

    await expect(fetchPermissions('/api/authz', 'token')).resolves.toBeNull()
  })

  it('returns null for a 200 whose body is not JSON at all', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>proxy error</html>', { status: 200 })))

    await expect(fetchPermissions('/api/authz', 'token')).resolves.toBeNull()
  })

  it('returns null for a 200 that is valid JSON but the wrong shape — the silent-failure case', async () => {
    for (const body of [{ permissions: 'config.rule.read' }, { permissions: null }, {}, [], 42, null]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, body)))
      await expect(fetchPermissions('/api/authz', 'token')).resolves.toBeNull()
    }
  })

  it('drops non-string entries rather than admitting them to the set', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, { permissions: ['audit.read', 42, null, { code: 'x' }] })))

    const out = await fetchPermissions('/api/authz', 'token')

    expect(out).toEqual(new Set(['audit.read']))
  })
})
