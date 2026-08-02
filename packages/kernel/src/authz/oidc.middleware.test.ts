import 'reflect-metadata'
import { exportJWK, exportSPKI, generateKeyPair, SignJWT } from 'jose'
import type { JSONWebKeySet, JWK, KeyLike } from 'jose'
import type { ExecutionContext } from '@nestjs/common'
import { GadongError } from '../errors'
import { AuthzClient } from './client'
import type { AuthzTransport, Decision } from './client'
import { PermissionGuard, RequirePermission } from './guard'
import {
  createHttpJwksFetcher,
  OidcMiddleware,
  OIDC_JWKS_CACHE_TTL_MS,
  OIDC_JWKS_REFRESH_DEBOUNCE_MS,
} from './oidc.middleware'
import type { JwksFetcher, OidcAuthenticatedRequest, OidcMiddlewareOptions } from './oidc.middleware'

const ISSUER = 'https://kc.gadonghr.test/auth/realms/gadong'
const AUDIENCE = 'gadong-services'
const JWKS_URI = `${ISSUER}/protocol/openid-connect/certs`

/** One RSA key pair plus the JWK form its public half is published as, keyed by `kid` — everything the fake JWKS endpoint and the token signer both need. */
interface SigningIdentity {
  kid: string
  privateKey: KeyLike
  publicJwk: JWK
}

async function generateIdentity(kid: string): Promise<SigningIdentity> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true })
  const jwk = await exportJWK(publicKey)
  jwk.kid = kid
  jwk.alg = 'RS256'
  jwk.use = 'sig'
  return { kid, privateKey, publicJwk: jwk }
}

function jwksOf(...identities: SigningIdentity[]): JSONWebKeySet {
  return { keys: identities.map((identity) => identity.publicJwk) }
}

const nowSec = (): number => Math.floor(Date.now() / 1000)

interface ClaimOverrides {
  sub?: string
  iss?: string
  aud?: string
  exp?: number
  nbf?: number
  iat?: number
  role?: string
  omitExp?: boolean
}

/** Builds a real, correctly RS256-signed token — the baseline every "goes wrong in one specific way" test mutates from. */
async function signToken(identity: SigningIdentity, overrides: ClaimOverrides = {}): Promise<string> {
  const claims: Record<string, unknown> = {
    sub: overrides.sub ?? 'user-1',
    iss: overrides.iss ?? ISSUER,
    aud: overrides.aud ?? AUDIENCE,
    iat: overrides.iat ?? nowSec(),
  }
  if (!overrides.omitExp) claims['exp'] = overrides.exp ?? nowSec() + 300
  if (overrides.nbf !== undefined) claims['nbf'] = overrides.nbf
  if (overrides.role !== undefined) claims['role'] = overrides.role

  return new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: identity.kid }).sign(identity.privateKey)
}

function fakeFetcher(jwks: JSONWebKeySet | (() => Promise<JSONWebKeySet>)): { fetcher: JwksFetcher; fetch: jest.Mock } {
  const fetch = jest.fn(async () => (typeof jwks === 'function' ? jwks() : jwks))
  return { fetcher: { fetch }, fetch }
}

function fakeRequest(authorization?: string | string[]): OidcAuthenticatedRequest {
  return { headers: authorization === undefined ? {} : { authorization } }
}

function buildMiddleware(overrides: Partial<OidcMiddlewareOptions> & { jwksFetcher: JwksFetcher }): OidcMiddleware {
  return new OidcMiddleware({
    issuer: ISSUER,
    audience: AUDIENCE,
    jwksUri: JWKS_URI,
    ...overrides,
  })
}

describe('OidcMiddleware', () => {
  // Written first, per the task-13c brief: this is THE bypass an
  // implementation that decodes a token instead of verifying it would pass
  // every other test and fail only this one. See task-13c-report.md for a
  // paste of this exact test failing against a decode-only stand-in.
  it('does NOT populate userId for a token with a valid payload but an invalid signature', async () => {
    const identity = await generateIdentity('k1')
    const { fetcher } = fakeFetcher(jwksOf(identity))
    const middleware = buildMiddleware({ jwksFetcher: fetcher })

    const valid = await signToken(identity)
    const [header, payload, signature] = valid.split('.')
    // Flip the signature's last two base64url characters — header and
    // payload (a genuinely valid claim set, signed by the real key) are
    // untouched, only the signature bytes are corrupted.
    const tail = (signature ?? '').slice(-2)
    const flippedTail = tail === 'AA' ? 'BB' : 'AA'
    const tampered = `${header}.${payload}.${(signature ?? '').slice(0, -2)}${flippedTail}`

    const req = fakeRequest(`Bearer ${tampered}`)
    await new Promise<void>((resolve) => {
      void middleware.use(req, {}, resolve)
    })

    expect(req.userId).toBeUndefined()
  })

  it('populates userId from sub for a validly signed token', async () => {
    const identity = await generateIdentity('k1')
    const { fetcher } = fakeFetcher(jwksOf(identity))
    const middleware = buildMiddleware({ jwksFetcher: fetcher })

    const token = await signToken(identity, { sub: 'user-42' })
    const req = fakeRequest(`Bearer ${token}`)
    await new Promise<void>((resolve) => void middleware.use(req, {}, resolve))

    expect(req.userId).toBe('user-42')
  })

  it('populates actorRole from a flat role claim when present', async () => {
    const identity = await generateIdentity('k1')
    const { fetcher } = fakeFetcher(jwksOf(identity))
    const middleware = buildMiddleware({ jwksFetcher: fetcher })

    const token = await signToken(identity, { role: 'hr_admin' })
    const req = fakeRequest(`Bearer ${token}`)
    await new Promise<void>((resolve) => void middleware.use(req, {}, resolve))

    expect(req.userId).toBe('user-1')
    expect(req.actorRole).toBe('hr_admin')
  })

  it('rejects alg: none outright — never populates userId', async () => {
    const identity = await generateIdentity('k1')
    const { fetcher, fetch } = fakeFetcher(jwksOf(identity))
    const middleware = buildMiddleware({ jwksFetcher: fetcher })

    const header = Buffer.from(JSON.stringify({ alg: 'none', kid: identity.kid })).toString('base64url')
    const payload = Buffer.from(
      JSON.stringify({ sub: 'user-1', iss: ISSUER, aud: AUDIENCE, exp: nowSec() + 300 }),
    ).toString('base64url')
    const noneToken = `${header}.${payload}.`

    const req = fakeRequest(`Bearer ${noneToken}`)
    await new Promise<void>((resolve) => void middleware.use(req, {}, resolve))

    expect(req.userId).toBeUndefined()
    // The alg allow-list check rejects the header before any key lookup —
    // confirms this isn't accidentally "denied because the JWKS was empty".
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects an algorithm-confusion attempt (HS256 signed with the RSA public key)', async () => {
    const identity = await generateIdentity('k1')
    const { fetcher } = fakeFetcher(jwksOf(identity))
    const middleware = buildMiddleware({ jwksFetcher: fetcher })

    const publicKeyPem = await exportSPKI(await importPublicKeyFromJwk(identity))
    const secret = new TextEncoder().encode(publicKeyPem)
    const confused = await new SignJWT({ sub: 'attacker', iss: ISSUER, aud: AUDIENCE, exp: nowSec() + 300 })
      .setProtectedHeader({ alg: 'HS256', kid: identity.kid })
      .sign(secret)

    const req = fakeRequest(`Bearer ${confused}`)
    await new Promise<void>((resolve) => void middleware.use(req, {}, resolve))

    expect(req.userId).toBeUndefined()
  })

  it('leaves userId unset for an expired token', async () => {
    const identity = await generateIdentity('k1')
    const { fetcher } = fakeFetcher(jwksOf(identity))
    const middleware = buildMiddleware({ jwksFetcher: fetcher })

    const token = await signToken(identity, { exp: nowSec() - 60 })
    const req = fakeRequest(`Bearer ${token}`)
    await new Promise<void>((resolve) => void middleware.use(req, {}, resolve))

    expect(req.userId).toBeUndefined()
  })

  it('leaves userId unset for a not-yet-valid token (nbf in the future)', async () => {
    const identity = await generateIdentity('k1')
    const { fetcher } = fakeFetcher(jwksOf(identity))
    const middleware = buildMiddleware({ jwksFetcher: fetcher })

    const token = await signToken(identity, { nbf: nowSec() + 3600 })
    const req = fakeRequest(`Bearer ${token}`)
    await new Promise<void>((resolve) => void middleware.use(req, {}, resolve))

    expect(req.userId).toBeUndefined()
  })

  it('leaves userId unset for the wrong issuer', async () => {
    const identity = await generateIdentity('k1')
    const { fetcher } = fakeFetcher(jwksOf(identity))
    const middleware = buildMiddleware({ jwksFetcher: fetcher })

    const token = await signToken(identity, { iss: 'https://not-our-realm.example/auth/realms/other' })
    const req = fakeRequest(`Bearer ${token}`)
    await new Promise<void>((resolve) => void middleware.use(req, {}, resolve))

    expect(req.userId).toBeUndefined()
  })

  it('leaves userId unset for the wrong audience', async () => {
    const identity = await generateIdentity('k1')
    const { fetcher } = fakeFetcher(jwksOf(identity))
    const middleware = buildMiddleware({ jwksFetcher: fetcher })

    const token = await signToken(identity, { aud: 'some-other-service' })
    const req = fakeRequest(`Bearer ${token}`)
    await new Promise<void>((resolve) => void middleware.use(req, {}, resolve))

    expect(req.userId).toBeUndefined()
  })

  it('leaves userId unset for a token with no exp claim at all', async () => {
    const identity = await generateIdentity('k1')
    const { fetcher } = fakeFetcher(jwksOf(identity))
    const middleware = buildMiddleware({ jwksFetcher: fetcher })

    const token = await signToken(identity, { omitExp: true })
    const req = fakeRequest(`Bearer ${token}`)
    await new Promise<void>((resolve) => void middleware.use(req, {}, resolve))

    expect(req.userId).toBeUndefined()
  })

  it('leaves userId unset and does not throw when the Authorization header is missing', async () => {
    const { fetcher } = fakeFetcher({ keys: [] })
    const middleware = buildMiddleware({ jwksFetcher: fetcher })

    const req = fakeRequest(undefined)
    await expect(
      new Promise<void>((resolve) => void middleware.use(req, {}, resolve)),
    ).resolves.toBeUndefined()

    expect(req.userId).toBeUndefined()
  })

  it.each([['not-a-bearer-token'], ['Basic dXNlcjpwYXNz'], ['Bearer'], ['Bearer ']])(
    'leaves userId unset and does not throw for a malformed Authorization header: %j',
    async (headerValue) => {
      const { fetcher } = fakeFetcher({ keys: [] })
      const middleware = buildMiddleware({ jwksFetcher: fetcher })

      const req = fakeRequest(headerValue)
      await expect(
        new Promise<void>((resolve) => void middleware.use(req, {}, resolve)),
      ).resolves.toBeUndefined()

      expect(req.userId).toBeUndefined()
    },
  )

  it('leaves userId unset and does not throw when the JWKS endpoint is unreachable', async () => {
    const identity = await generateIdentity('k1')
    const fetch = jest.fn(async () => Promise.reject(new Error('ECONNREFUSED')))
    const middleware = buildMiddleware({ jwksFetcher: { fetch } })

    const token = await signToken(identity)
    const req = fakeRequest(`Bearer ${token}`)
    await expect(
      new Promise<void>((resolve) => void middleware.use(req, {}, resolve)),
    ).resolves.toBeUndefined()

    expect(req.userId).toBeUndefined()
  })

  it('does not fetch the JWKS once per request when the cache is still fresh', async () => {
    const identity = await generateIdentity('k1')
    const { fetcher, fetch } = fakeFetcher(jwksOf(identity))
    const middleware = buildMiddleware({ jwksFetcher: fetcher })
    const token = await signToken(identity)

    for (let i = 0; i < 5; i++) {
      const req = fakeRequest(`Bearer ${token}`)
      // Sequential by design: proves repeated requests share one cached JWKS fetch.
      await new Promise<void>((resolve) => void middleware.use(req, {}, resolve))
      expect(req.userId).toBe('user-1')
    }

    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('an unknown kid triggers exactly one JWKS refresh, not one per request', async () => {
    const identity = await generateIdentity('k1')
    const otherIdentity = await generateIdentity('k2') // never added to the served JWKS — always "unknown"
    const { fetcher, fetch } = fakeFetcher(jwksOf(identity))
    const middleware = buildMiddleware({ jwksFetcher: fetcher })

    // Populate the cache first, same as a real boot would via an earlier
    // legitimate request — isolates "unknown kid" refresh behaviour from
    // "first ever request" cold-cache behaviour.
    const warmup = await signToken(identity)
    await new Promise<void>((resolve) => void middleware.use(fakeRequest(`Bearer ${warmup}`), {}, resolve))
    expect(fetch).toHaveBeenCalledTimes(1)

    const unknownKidToken = await signToken(otherIdentity)
    for (let i = 0; i < 4; i++) {
      const req = fakeRequest(`Bearer ${unknownKidToken}`)
      // Sequential by design: proves the debounce holds across repeated calls, not just concurrent ones.
      await new Promise<void>((resolve) => void middleware.use(req, {}, resolve))
      expect(req.userId).toBeUndefined()
    }

    // One extra fetch for the unknown-kid retry, not four.
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('refreshes the JWKS again once the TTL has elapsed', async () => {
    const identity = await generateIdentity('k1')
    const { fetcher, fetch } = fakeFetcher(jwksOf(identity))
    let clock = 1_000_000
    const middleware = buildMiddleware({ jwksFetcher: fetcher, now: () => clock })
    const token = await signToken(identity)

    await new Promise<void>((resolve) => void middleware.use(fakeRequest(`Bearer ${token}`), {}, resolve))
    expect(fetch).toHaveBeenCalledTimes(1)

    clock += OIDC_JWKS_CACHE_TTL_MS + 1
    await new Promise<void>((resolve) => void middleware.use(fakeRequest(`Bearer ${token}`), {}, resolve))
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('exports the documented default TTL and refresh-debounce constants', () => {
    expect(OIDC_JWKS_CACHE_TTL_MS).toBe(10 * 60 * 1000)
    expect(OIDC_JWKS_REFRESH_DEBOUNCE_MS).toBe(10_000)
  })

  it('createHttpJwksFetcher is exported for production wiring (not exercised over the network here)', () => {
    expect(typeof createHttpJwksFetcher().fetch).toBe('function')
  })

  it('never logs the token, or any substring of it, at any verification outcome', async () => {
    const identity = await generateIdentity('k1')
    const { fetcher } = fakeFetcher(jwksOf(identity))
    const debug = jest.fn()
    const middleware = buildMiddleware({ jwksFetcher: fetcher, logger: { debug } })

    const validToken = await signToken(identity)
    const expiredToken = await signToken(identity, { exp: nowSec() - 60 })
    const wrongAudToken = await signToken(identity, { aud: 'someone-else' })

    for (const bearer of [`Bearer ${validToken}`, `Bearer ${expiredToken}`, `Bearer ${wrongAudToken}`, 'not-bearer', undefined]) {
      const req = fakeRequest(bearer)
      // Small fixed set, sequential is clearer here than Promise.all.
      await new Promise<void>((resolve) => void middleware.use(req, {}, resolve))
    }

    const loggedTokens = [validToken, expiredToken, wrongAudToken]
    for (const call of debug.mock.calls) {
      const message = String(call[0])
      for (const token of loggedTokens) {
        expect(message).not.toContain(token)
        // Also guard against just the signature segment leaking, not only the whole compact token.
        const signaturePart = token.split('.')[2]
        if (signaturePart) expect(message).not.toContain(signaturePart)
      }
    }
    expect(debug).toHaveBeenCalled() // sanity: the spy really was wired in, not just vacuously true
  })
})

describe('OidcMiddleware end-to-end through the real PermissionGuard', () => {
  function fakeContext(handler: () => void, controllerClass: new () => unknown, request: unknown): ExecutionContext {
    const notImplemented = () => {
      throw new Error('not implemented in fakeContext')
    }
    return {
      getHandler: () => handler,
      getClass: () => controllerClass,
      switchToHttp: () => ({ getRequest: () => request, getResponse: notImplemented, getNext: notImplemented }),
      switchToRpc: notImplemented,
      switchToWs: notImplemented,
      getArgs: notImplemented,
      getArgByIndex: notImplemented,
      getType: notImplemented,
    } as unknown as ExecutionContext
  }

  class FakeController {
    @RequirePermission('employee.read')
    annotated(): void {
      /* no-op */
    }
  }

  function guardWith(decision: Decision): { guard: PermissionGuard; post: jest.Mock } {
    const post = jest.fn(() => Promise.resolve(decision))
    const transport: AuthzTransport = { post }
    return { guard: new PermissionGuard(new AuthzClient(transport)), post }
  }

  it('a valid token plus a granted permission allows the request', async () => {
    const identity = await generateIdentity('k1')
    const { fetcher } = fakeFetcher(jwksOf(identity))
    const middleware = buildMiddleware({ jwksFetcher: fetcher })
    const { guard } = guardWith({ allowed: true, scopeOrgUnitIds: '*' })

    const token = await signToken(identity, { sub: 'user-1' })
    const req = fakeRequest(`Bearer ${token}`)
    await new Promise<void>((resolve) => void middleware.use(req, {}, resolve))

    const controller = new FakeController()
    const context = fakeContext(controller.annotated, FakeController, req)
    await expect(guard.canActivate(context)).resolves.toBe(true)
  })

  it('a valid token without the grant denies the request (AUZ-403)', async () => {
    const identity = await generateIdentity('k1')
    const { fetcher } = fakeFetcher(jwksOf(identity))
    const middleware = buildMiddleware({ jwksFetcher: fetcher })
    const { guard } = guardWith({ allowed: false, scopeOrgUnitIds: [] })

    const token = await signToken(identity, { sub: 'user-1' })
    const req = fakeRequest(`Bearer ${token}`)
    await new Promise<void>((resolve) => void middleware.use(req, {}, resolve))

    const controller = new FakeController()
    const context = fakeContext(controller.annotated, FakeController, req)
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(GadongError)
    await expect(guard.canActivate(context)).rejects.toMatchObject({ code: 'AUZ-403' })
  })

  it('no token at all denies the request, and svc-authz is never even asked', async () => {
    const identity = await generateIdentity('k1')
    const { fetcher } = fakeFetcher(jwksOf(identity))
    const middleware = buildMiddleware({ jwksFetcher: fetcher })
    const { guard, post } = guardWith({ allowed: true, scopeOrgUnitIds: '*' })

    const req = fakeRequest(undefined) // no Authorization header at all
    await new Promise<void>((resolve) => void middleware.use(req, {}, resolve))
    expect(req.userId).toBeUndefined()

    const controller = new FakeController()
    const context = fakeContext(controller.annotated, FakeController, req)
    await expect(guard.canActivate(context)).rejects.toMatchObject({ code: 'AUZ-403' })
    expect(post).not.toHaveBeenCalled()
  })
})

/** Test-only helper: re-imports a JWK-form public key back into a `KeyLike`, so the algorithm-confusion test can export it as SPKI PEM the same way an attacker reading the JWKS endpoint's public output could. */
async function importPublicKeyFromJwk(identity: SigningIdentity): Promise<KeyLike> {
  const { importJWK } = await import('jose')
  const key = await importJWK(identity.publicJwk, 'RS256')
  if (key instanceof Uint8Array) throw new Error('expected an asymmetric key, not raw bytes')
  return key
}
