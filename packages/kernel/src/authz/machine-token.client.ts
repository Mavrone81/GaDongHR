/**
 * Machine identity for service-to-service calls (S2S auth task). Every
 * cross-service HTTP call this codebase makes today (`svc-onboarding` ->
 * `svc-config`, `svc-payroll` -> `svc-config`/`svc-timesheet`/`svc-docs`/
 * `svc-onboarding`, `svc-timesheet` -> `svc-config`, `svc-scheduler` ->
 * `svc-config`) sends a bare, unauthenticated `fetch` against a route
 * guarded by `PermissionGuard` (`guard.ts`) — deny-by-default means every
 * one of those calls is denied in a real deployment. `MachineTokenClient`
 * is the caller side of the fix: it authenticates this SERVICE (not a
 * human) against the same OIDC issuer `OidcMiddleware` already validates
 * user tokens against, using the standard OAuth2 client_credentials grant
 * (RFC 6749 §4.4) — exactly the flow `deploy/scripts/seed.sh`'s `seeder`
 * client and `test/e2e/harness.ts`'s persona tokens already prove works
 * end-to-end against both real Keycloak and the e2e stand-in issuer.
 *
 * A client_credentials token's `sub` claim is the SAME kind of value a
 * human token's `sub` is — Keycloak stamps a service account's own internal
 * user id there, verbatim (`seed.sh`'s own header explains this for the
 * `seeder` client). `OidcMiddleware` therefore needs no special-casing to
 * accept a machine token: it is a bearer token like any other, verified by
 * the same `jose.jwtVerify` call against the same JWKS, and `PermissionGuard`
 * denies or allows it by the SAME grant lookup (`AuthzClient.decide`) a
 * human caller goes through. There is no parallel, weaker validation path
 * here — only a new way to OBTAIN a token to present.
 *
 * Three properties the brief requires, each load-bearing:
 *
 *  - CACHING WITH EXPIRY-AWARE REFRESH: a token is reused across calls
 *    until it is within `refreshSkewSec` of its reported `expires_in` —
 *    never used past that point, so a caller never presents a token the
 *    issuer is about to (or already did) consider expired.
 *  - SINGLE-FLIGHT: concurrent callers that all observe a stale/absent
 *    cache share ONE outstanding token request (`refreshInFlight`) — the
 *    same dedupe shape `OidcMiddleware.doRefreshDeduped` already uses for
 *    JWKS refresh, for the identical reason (a burst of requests must not
 *    turn into a burst of requests AT the issuer).
 *  - FAIL CLOSED: `getToken()` REJECTS when the issuer is unreachable,
 *    returns a non-2xx, or returns a body with no usable `access_token` —
 *    it never falls back to "just make the call with no token". A caller
 *    built on `createAuthenticatedFetch` therefore either sends a real,
 *    valid bearer token or never sends the request at all; the failure
 *    surfaces as whatever error the caller already raises when the far
 *    side is unreachable (every `Http*Client` in this codebase already
 *    treats a thrown fetch as "service unavailable" — this is that same
 *    path, not a new one).
 */

/** What a real OAuth2 client_credentials token response carries, narrowed to what this client uses. Both Keycloak and the e2e stand-in issuer (`test/e2e/oidc-issuer/server.js`) return this exact shape from their token endpoints — see that file's `/token` handler. */
export interface TokenResponse {
  accessToken: string
  /** Seconds until the issuer considers this token expired. Never trusted to be present — an issuer that omits it gets `DEFAULT_EXPIRES_IN_SEC`, never treated as "does not expire". */
  expiresInSec: number
}

/** Transport to the OIDC token endpoint. Injectable so `MachineTokenClient` is unit-testable without HTTP — matches `AuthzTransport`/`ConfigTransport`'s shape elsewhere in this codebase. */
export interface TokenTransport {
  fetchToken(clientId: string, clientSecret: string): Promise<TokenResponse>
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/** Conservative fallback when an issuer's token response omits `expires_in` — short enough that a misbehaving issuer causes frequent re-auth rather than a token silently treated as long-lived. */
const DEFAULT_EXPIRES_IN_SEC = 60

/**
 * Real HTTP implementation: a standard, form-encoded OAuth2
 * client_credentials request (RFC 6749 §4.4.2) against `tokenUrl` — the
 * WIRE FORMAT every real OIDC provider (Keycloak included) expects, and
 * the shape `test/e2e/oidc-issuer/server.js`'s `/token` endpoint was
 * extended to also accept, specifically so this transport never branches
 * on which environment it is talking to. Only `tokenUrl` (and the
 * client's own id/secret) differs between deploy and e2e — never a code
 * path (brief: "the difference must be config ... never code paths").
 */
export function createHttpTokenTransport(tokenUrl: string): TokenTransport {
  return {
    async fetchToken(clientId: string, clientSecret: string): Promise<TokenResponse> {
      const res = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: clientId,
          client_secret: clientSecret,
        }).toString(),
      })
      if (!res.ok) {
        throw new Error(`machine-token: token endpoint ${tokenUrl} responded ${String(res.status)}`)
      }
      const body: unknown = await res.json()
      if (!isRecord(body) || typeof body['access_token'] !== 'string' || body['access_token'].length === 0) {
        throw new Error(`machine-token: token endpoint ${tokenUrl} returned no access_token`)
      }
      const expiresIn = body['expires_in']
      return {
        accessToken: body['access_token'],
        expiresInSec: typeof expiresIn === 'number' && expiresIn > 0 ? expiresIn : DEFAULT_EXPIRES_IN_SEC,
      }
    },
  }
}

export interface MachineTokenClientOptions {
  clientId: string
  clientSecret: string
  /** Injectable clock for tests; defaults to `Date.now`. */
  now?: () => number
  /** Seconds subtracted from the token's reported `expires_in` before it is considered due for refresh — bounds how close to real expiry a handed-out token is ever allowed to be. Defaults to 30s, comfortably inside Keycloak's realm default 15-minute access-token lifespan (`realm-gadonghr.json`'s `accessTokenLifespan`) and the e2e issuer's 1-hour default. */
  refreshSkewSec?: number
}

const DEFAULT_REFRESH_SKEW_SEC = 30
/** Floor on the cached lifetime after subtracting the refresh skew — protects against a very short (or misconfigured, near-zero) `expires_in` producing a negative or zero TTL that would refresh on literally every call, defeating caching entirely. */
const MIN_CACHED_TTL_MS = 1000

interface CachedToken {
  accessToken: string
  /** Already skew-adjusted — the point at which this cache entry is treated as stale, not the issuer's real expiry. */
  staleAt: number
}

/**
 * One instance per calling service (constructed once in that service's
 * `AppModule`, matching `AuthzClient`/`CryptoClient`'s own one-per-service
 * lifetime) — a single client_id/secret pair, a single cache entry. A
 * service that calls multiple downstream services presents the SAME token
 * to all of them (the token's `aud`/grants are what scope it, not a
 * per-destination token) — matching how a human's single bearer token
 * already works against every guarded route their grants allow.
 */
export class MachineTokenClient {
  private readonly now: () => number
  private readonly refreshSkewMs: number
  private cached: CachedToken | undefined
  private refreshInFlight: Promise<string> | undefined

  constructor(
    private readonly transport: TokenTransport,
    private readonly options: MachineTokenClientOptions,
  ) {
    this.now = options.now ?? Date.now
    this.refreshSkewMs = (options.refreshSkewSec ?? DEFAULT_REFRESH_SKEW_SEC) * 1000
  }

  /**
   * Resolves to a bearer token this service can present. REJECTS (never
   * resolves to a placeholder, never resolves with an expired token) if no
   * valid token can be obtained — see the file header's "FAIL CLOSED".
   */
  async getToken(): Promise<string> {
    const now = this.now()
    if (this.cached && this.cached.staleAt > now) return this.cached.accessToken

    // Single-flight: every caller that observes a stale/absent cache while
    // a refresh is already outstanding awaits that SAME promise rather than
    // starting its own request — identical shape and reasoning to
    // `OidcMiddleware.doRefreshDeduped` (kernel `authz/oidc.middleware.ts`).
    if (this.refreshInFlight) return this.refreshInFlight

    const attempt = this.refresh(now)
    this.refreshInFlight = attempt
    try {
      return await attempt
    } finally {
      // Cleared unconditionally (success or failure) — a failed attempt
      // must not poison every subsequent call forever; the very next
      // `getToken()` gets a fresh attempt, which is what makes recovery
      // from a transient issuer outage automatic rather than requiring a
      // process restart.
      this.refreshInFlight = undefined
    }
  }

  private async refresh(now: number): Promise<string> {
    const response = await this.transport.fetchToken(this.options.clientId, this.options.clientSecret)
    const ttlMs = Math.max(response.expiresInSec * 1000 - this.refreshSkewMs, MIN_CACHED_TTL_MS)
    this.cached = { accessToken: response.accessToken, staleAt: now + ttlMs }
    return response.accessToken
  }
}

/** Convenience constructor for the real HTTP path — every service's `AppModule` calls this once, matching the `new AuthzClient(createHttpAuthzTransport(...))` shape already established. */
export function createHttpMachineTokenClient(options: MachineTokenClientOptions & { tokenUrl: string }): MachineTokenClient {
  return new MachineTokenClient(createHttpTokenTransport(options.tokenUrl), options)
}

/**
 * Deliberately the exact same call signature as the global `fetch` (not a
 * narrower `(url: string) => ...`) — every existing `Http*Client` in this
 * codebase already declares its injectable fetch parameter as `typeof
 * fetch` (defaulting to the real global), so this type is assignable
 * anywhere that one is, and wiring authentication in is a one-line change:
 * swap the global `fetch` default for `createAuthenticatedFetch(...)`.
 */
export type AuthenticatedFetch = typeof fetch

/**
 * The ONE shared way a service attaches its machine identity to an outgoing
 * request (brief: "prefer one shared authenticated-fetch helper in the
 * kernel over N hand-rolled header injections"). `getToken()`'s rejection
 * propagates untouched — a token failure means this function never calls
 * `fetch` at all, so an unauthenticated request "that happens to work"
 * against an unguarded route is not a code path that exists here.
 *
 * A caller-supplied `authorization` header (there is none anywhere in this
 * codebase today, but the contract is worth stating) is deliberately
 * OVERWRITTEN, never merged — this function exists to be the single source
 * of truth for which credential goes on the wire.
 */
export function createAuthenticatedFetch(tokenClient: MachineTokenClient, fetchImpl: typeof fetch = fetch): AuthenticatedFetch {
  return (async (input: Parameters<typeof fetch>[0], init: RequestInit = {}): Promise<Response> => {
    const token = await tokenClient.getToken()
    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${token}`)
    return fetchImpl(input, { ...init, headers })
  }) as AuthenticatedFetch
}
