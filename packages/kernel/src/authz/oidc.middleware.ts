import 'reflect-metadata'
import { Injectable, Logger } from '@nestjs/common'
import type { NestMiddleware } from '@nestjs/common'
import { createLocalJWKSet, errors as joseErrors, jwtVerify } from 'jose'
import type { FlattenedJWSInput, JSONWebKeySet, JWSHeaderParameters, JWTPayload } from 'jose'
import type { AuthenticatedRequest } from './guard'

/**
 * THE GAP this file closes (Task 13c): `PermissionGuard` (`guard.ts`) reads
 * `request.userId` and denies when it is absent — correct, and covered by
 * mutation testing — but nothing anywhere ever SET `request.userId`.
 * `OidcMiddleware` is that missing piece: it validates a bearer token
 * against Keycloak's real JWKS and, only on a fully successful verification,
 * populates `request.userId` (from `sub`) and `request.actorRole` (from
 * whatever role claim is present).
 *
 * The single governing rule, stated once so every branch below can be
 * checked against it: **on any failure this middleware leaves
 * `request.userId` unset and calls `next()` — it never throws.**
 * `PermissionGuard` already has exactly one deny path (`!request.userId`);
 * that is what makes deny-by-default testable as a single assertion. If
 * this middleware also had its own throw-on-bad-token path, there would be
 * two ways to end up denied — a missing principal, and a middleware
 * exception — and a future change could fix one path while leaving the
 * other silently broken. A malformed header, a bad signature, an expired
 * token, a wrong issuer/audience, and an unreachable JWKS endpoint are
 * therefore handled identically: log the reason at debug level (never the
 * token, never a decoded claim value that came from the token), leave
 * `userId` unset, continue.
 *
 * **Verification, not decoding.** The signature is checked against a real
 * `jose.jwtVerify` call using keys resolved from a JWKS — `jose.decodeJwt`
 * (which reads the payload without checking the signature at all) is never
 * called anywhere in this file. A decode-without-verify implementation
 * would pass every "happy path" test in `oidc.middleware.test.ts` and fail
 * exactly one: "a token with a valid payload but an invalid signature does
 * NOT populate userId" — see that test's own comment for why it is written
 * first, and the task-13c report for the paste-both-outputs demonstration.
 *
 * **Algorithm confusion.** `algorithms` (below) is an explicit allow-list
 * passed to `jwtVerify`, not inferred from the token's own `alg` header.
 * That is what stops both `alg: none` (never in the allow-list) and an
 * HS256-signed-with-the-RSA-public-key attack (the header says `HS256`,
 * which is not in the allow-list, so `jwtVerify` rejects it before ever
 * asking `resolveKey` to resolve anything — the fact that `resolveKey`
 * would only ever hand back an asymmetric `CryptoKey`, never bytes usable
 * as an HMAC secret, is defense in depth on top of that, not the primary
 * control).
 */
export interface OidcAuthenticatedRequest extends AuthenticatedRequest {
  /**
   * Set from whichever role claim is present, if any — Keycloak's
   * `realm_access.roles` (first entry), a flat `roles` array (first entry),
   * or a single `role` string claim, checked in that order. Absent if none
   * of those are present; `PermissionGuard` never reads this today, but the
   * brief asks for it to be populated when available, for whatever reads it
   * next.
   */
  actorRole?: string
  headers: Record<string, string | string[] | undefined>
}

/** The subset of Nest's `Logger` this middleware calls — narrow on purpose so a test can inject a spy without pulling in `@nestjs/common`'s `Logger` (matches the house `WarnLogger` convention in `svc-i18n`/`svc-docs`). Only `.debug` is used: a rejected token is an expected, frequent event (an expired session, a client clock skewed, a scanner probing with garbage), not a warning or an error. */
export interface DebugLogger {
  debug(message: string): void
}

/**
 * Injectable so tests never touch the network — the same shape as
 * `AuthzTransport`/`CryptoTransport` elsewhere in this kernel. The real
 * implementation (`createHttpJwksFetcher`) is what every service wires in
 * production; tests hand `OidcMiddleware` a fake that resolves from an
 * in-memory JWKS built with `jose.generateKeyPair`/`jose.exportJWK`.
 */
export interface JwksFetcher {
  fetch(jwksUri: string): Promise<JSONWebKeySet>
}

/** Real HTTP JWKS fetch — same `fetch`-based shape as every other service-to-service transport in this codebase (`createHttpAuthzTransport` et al.), so no HTTP client dependency is added to the kernel. */
export function createHttpJwksFetcher(): JwksFetcher {
  return {
    async fetch(jwksUri: string): Promise<JSONWebKeySet> {
      const res = await fetch(jwksUri)
      if (!res.ok) throw new Error(`oidc: JWKS endpoint responded ${String(res.status)}`)
      return (await res.json()) as JSONWebKeySet
    },
  }
}

/** How long a fetched JWKS is trusted before the next request forces a re-fetch — bounds how long a rotated-out signing key stays accepted. */
export const OIDC_JWKS_CACHE_TTL_MS = 10 * 60 * 1000

/**
 * Floor between JWKS re-fetch attempts, applied both to "fetch failed" and
 * "fetched, but the `kid` we needed still isn't in it" — without this, a
 * client sending a token with an unknown/garbage `kid` (or simply arriving
 * while the JWKS endpoint is down) would make EVERY request trigger a new
 * network call, which is exactly the "fetch JWKS per request" behaviour the
 * brief prohibits, just reached from the failure path instead of the happy
 * path.
 */
export const OIDC_JWKS_REFRESH_DEBOUNCE_MS = 10_000

/** Bounds how many keys one JWKS response is allowed to populate the cache with — a compromised or misbehaving JWKS endpoint returning an unbounded key list must not be able to grow this process's memory without limit. Keycloak realms in practice publish a handful of keys (one active + recently-rotated-out); 50 is generous headroom, not a realistic ceiling. */
export const OIDC_JWKS_MAX_KEYS = 50

/** Keycloak's default signing algorithm for access tokens. Overridable per service via `OidcMiddlewareOptions.algorithms`, but the default is deliberately a single asymmetric algorithm, never `['none']`/`['HS256']`/"whatever the token says" — see the file header's "Algorithm confusion" note. */
const DEFAULT_ALGORITHMS = ['RS256']

/** Small allowance for clock drift between this service's container and Keycloak's, applied to `exp`/`nbf` only. */
const DEFAULT_CLOCK_TOLERANCE_SEC = 5

export interface OidcMiddlewareOptions {
  /** Expected `iss` claim — the Keycloak realm's issuer URL. From config (`OIDC_ISSUER`), never hard-coded. */
  issuer: string
  /** Expected `aud` claim (or one member of it, if the token's `aud` is an array). From config (`OIDC_AUDIENCE`). */
  audience: string
  /** Where the realm's public signing keys live. From config (`OIDC_JWKS_URI`) — deliberately not derived from `issuer` in code, so a deployment can point at a different path without a code change. */
  jwksUri: string
  /** Allow-listed `alg` values; see the file header's "Algorithm confusion" note. Defaults to `['RS256']`. */
  algorithms?: string[]
  clockToleranceSec?: number
  /** Defaults to `createHttpJwksFetcher()`; tests inject a fake. */
  jwksFetcher?: JwksFetcher
  /** Injectable clock for tests; defaults to `Date.now`. */
  now?: () => number
  jwksTtlMs?: number
  jwksRefreshDebounceMs?: number
  maxCachedKeys?: number
  /** Defaults to a real `@nestjs/common` `Logger`; tests inject a spy. */
  logger?: DebugLogger
}

interface JwksCacheState {
  jwks: JSONWebKeySet
  fetchedAt: number
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

function firstString(v: unknown): string | undefined {
  if (isNonEmptyString(v)) return v
  if (Array.isArray(v)) {
    const first = v[0]
    return isNonEmptyString(first) ? first : undefined
  }
  return undefined
}

/**
 * Checked in this order: a flat `role` claim, a flat `roles` array (first
 * entry), then Keycloak's own `realm_access.roles` (first entry). Returns
 * `undefined` — not a default — when none is present; `use()` only assigns
 * `request.actorRole` when this returns a value, so "no role claim" and "an
 * empty string role claim" both correctly leave `actorRole` unset.
 */
function extractRole(payload: JWTPayload): string | undefined {
  const flatRole = firstString(payload['role'])
  if (flatRole) return flatRole

  const flatRoles = firstString(payload['roles'])
  if (flatRoles) return flatRoles

  const realmAccess = payload['realm_access']
  if (isRecord(realmAccess)) {
    const realmRole = firstString(realmAccess['roles'])
    if (realmRole) return realmRole
  }

  return undefined
}

/** Extracts the bearer token from a raw `Authorization` header value — case-insensitive scheme per RFC 6750, tolerant of an array (some frameworks normalize duplicate headers into `string[]`; the first value wins, matching Node's own `IncomingHttpHeaders` convention). Returns `undefined` for anything that is not exactly `Bearer <token>` — missing header, wrong scheme, empty token, extra segments. */
function extractBearerToken(headerValue: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue
  if (!isNonEmptyString(raw)) return undefined
  const match = /^Bearer\s+(\S+)$/i.exec(raw.trim())
  return match?.[1]
}

/**
 * A reason safe to log: the rejecting error's class name (`JWTExpired`,
 * `JWSSignatureVerificationFailed`, `JWKSNoMatchingKey`, ...) or jose's
 * stable `.code` when present. Deliberately never `.message` — some jose
 * claim-validation messages echo back the offending claim VALUE (e.g. a
 * wrong `aud`), which originated inside the token; logging only the error
 * class avoids ever putting token-derived content in a log line.
 */
function describeVerificationFailure(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code
    return typeof code === 'string' ? code : err.name
  }
  return 'unknown_error'
}

/**
 * Validates a bearer token against the configured issuer's JWKS and
 * populates `request.userId`/`request.actorRole` on success. See the file
 * header for the full contract — most importantly: never throws.
 *
 * Registration: this must be applied via `MiddlewareConsumer` in each
 * service's `AppModule.configure()`, ahead of `PermissionGuard` (guards run
 * after middleware in Nest's request pipeline, so this ordering is
 * automatic once both are present — there is no explicit "run before the
 * guard" wiring needed).
 */
@Injectable()
export class OidcMiddleware implements NestMiddleware<OidcAuthenticatedRequest, unknown> {
  private readonly issuer: string
  private readonly audience: string
  private readonly jwksUri: string
  private readonly algorithms: string[]
  private readonly clockToleranceSec: number
  private readonly fetcher: JwksFetcher
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly refreshDebounceMs: number
  private readonly maxCachedKeys: number
  private readonly logger: DebugLogger

  private cache: JwksCacheState | undefined
  /**
   * Set only when the most recent fetch attempt FAILED (network error,
   * non-2xx, unparseable body) — governs `ensureFreshCache`'s backoff so a
   * permanently unreachable JWKS endpoint gets one fetch attempt per
   * debounce window, not one per incoming request. Reset to `-Infinity` the
   * instant a fetch succeeds, so recovery is picked up on the very next
   * request rather than waiting out a stale backoff window.
   */
  private lastFetchFailureAt = -Infinity
  /**
   * Tracks only "unknown kid" retry attempts — deliberately a SEPARATE
   * clock from `lastFetchFailureAt`. A normal, successful cache-populating
   * fetch (e.g. at boot, or on ordinary TTL expiry) must never suppress the
   * very next "this kid isn't in what I have, try once more" retry; only a
   * recent retry FOR THAT SAME REASON should. Conflating the two clocks was
   * the bug an earlier version of this file had: the first unknown-kid
   * lookup right after a fresh successful boot fetch got silently
   * swallowed by the general debounce window, so it looked identical to
   * "still unknown after retrying" from a caller's point of view (see
   * `oidc.middleware.test.ts`'s "unknown kid triggers exactly one JWKS
   * refresh" test, which is what caught this).
   */
  private lastKidMissRefreshAt = -Infinity
  private refreshInFlight: Promise<void> | undefined

  constructor(options: OidcMiddlewareOptions) {
    this.issuer = options.issuer
    this.audience = options.audience
    this.jwksUri = options.jwksUri
    this.algorithms = options.algorithms ?? DEFAULT_ALGORITHMS
    this.clockToleranceSec = options.clockToleranceSec ?? DEFAULT_CLOCK_TOLERANCE_SEC
    this.fetcher = options.jwksFetcher ?? createHttpJwksFetcher()
    this.now = options.now ?? Date.now
    this.ttlMs = options.jwksTtlMs ?? OIDC_JWKS_CACHE_TTL_MS
    this.refreshDebounceMs = options.jwksRefreshDebounceMs ?? OIDC_JWKS_REFRESH_DEBOUNCE_MS
    this.maxCachedKeys = options.maxCachedKeys ?? OIDC_JWKS_MAX_KEYS
    this.logger = options.logger ?? new Logger('OidcMiddleware')
  }

  async use(req: OidcAuthenticatedRequest, _res: unknown, next: () => void): Promise<void> {
    const token = extractBearerToken(req.headers['authorization'])
    if (!token) {
      this.logger.debug('oidc: no bearer token present')
      next()
      return
    }

    try {
      const { payload } = await jwtVerify(token, this.resolveKey, {
        issuer: this.issuer,
        audience: this.audience,
        algorithms: this.algorithms,
        clockTolerance: this.clockToleranceSec,
        // `nbf`/`exp` are validated whenever present regardless of this list
        // (jose's default behaviour); listing them here additionally makes
        // their ABSENCE a rejection too — a token with no `exp` must not be
        // treated as non-expiring. `nbf` is deliberately left off this list
        // for the opposite reason: plenty of legitimate issuers omit it, and
        // "verify nbf" (the brief's wording) means "enforce it when given",
        // not "require every token to carry it".
        requiredClaims: ['exp', 'iss', 'aud', 'sub'],
      })

      const sub = payload.sub
      if (!isNonEmptyString(sub)) {
        this.logger.debug('oidc: token verified but sub claim missing or empty')
        next()
        return
      }

      req.userId = sub
      const role = extractRole(payload)
      if (role) req.actorRole = role
    } catch (err) {
      this.logger.debug(`oidc: bearer token rejected (${describeVerificationFailure(err)})`)
    }

    next()
  }

  /**
   * `jose.jwtVerify`'s key-resolution callback. Delegates the actual
   * header→key match (respecting `kid`/`alg`/`use`) to `jose.createLocalJWKSet`
   * against whatever is currently cached — this function's own job is only
   * cache freshness: fetch if there is nothing cached yet or the TTL has
   * elapsed, and fetch exactly once more (never in a loop) if the cached
   * JWKS doesn't contain the `kid` the token asked for.
   */
  private resolveKey = async (protectedHeader: JWSHeaderParameters, token: FlattenedJWSInput) => {
    await this.ensureFreshCache().catch(() => undefined) // failure handled uniformly by the "!this.cache" check below
    if (!this.cache) throw new Error('oidc: JWKS unavailable')

    try {
      return await createLocalJWKSet(this.cache.jwks)(protectedHeader, token)
    } catch (err) {
      if (!(err instanceof joseErrors.JWKSNoMatchingKey)) throw err

      // Unknown kid: maybe a key rotated in since our last fetch — but only
      // retry if the LAST unknown-kid retry (not the last fetch for any
      // reason) was long enough ago. That is what makes a burst of requests
      // all carrying the same still-unknown kid cost at most one extra
      // network call, not one per request.
      const now = this.now()
      if (now - this.lastKidMissRefreshAt >= this.refreshDebounceMs) {
        this.lastKidMissRefreshAt = now
        await this.doRefreshDeduped(now).catch(() => undefined)
      }
      if (!this.cache) throw err
      return await createLocalJWKSet(this.cache.jwks)(protectedHeader, token)
    }
  }

  private async ensureFreshCache(): Promise<void> {
    const now = this.now()
    if (this.cache && now - this.cache.fetchedAt < this.ttlMs) return
    // A fetch attempt that failed recently is not retried on every single
    // request — that would just be "fetch JWKS per request" reached via the
    // failure path instead of the happy path. `doRefreshDeduped` itself
    // still dedupes concurrent callers regardless of this check.
    if (now - this.lastFetchFailureAt < this.refreshDebounceMs) return
    await this.doRefreshDeduped(now)
  }

  /**
   * The single place a JWKS fetch is ever triggered from. Callers
   * (`ensureFreshCache`'s TTL/backoff path, and `resolveKey`'s unknown-kid
   * path) are each responsible for their own debounce decision before
   * calling this — this method's only job is deduplicating CONCURRENT
   * callers that decided to refresh at the same time, so a burst of
   * simultaneous requests triggers one fetch, not one per request in
   * flight.
   */
  private async doRefreshDeduped(now: number): Promise<void> {
    if (this.refreshInFlight) {
      await this.refreshInFlight
      return
    }

    // `attempt` — and NOT some derived `.finally()`/`.then()` promise built
    // from it — is exactly what gets assigned to `this.refreshInFlight` AND
    // exactly what gets awaited immediately below, in the same tick. Both
    // matter: a derived promise is a distinct object with its own
    // independent unhandled-rejection tracking, so if `this.refreshInFlight`
    // held that derived promise instead of `attempt` itself, an unreachable
    // JWKS could reject it without this function's own `try`/`finally` ever
    // being the thing that "handles" it — Node would (correctly) report
    // that as an unhandled rejection, observed as it bleeding into whatever
    // test or request happened to be running when the microtask fired.
    const attempt = this.performRefresh(now)
    this.refreshInFlight = attempt
    try {
      await attempt
    } finally {
      this.refreshInFlight = undefined
    }
  }

  private async performRefresh(now: number): Promise<void> {
    try {
      await this.doRefresh(now)
      this.lastFetchFailureAt = -Infinity // recovered — don't let a stale backoff window block the next legitimate refresh
    } catch (err) {
      this.lastFetchFailureAt = now
      throw err
    }
  }

  private async doRefresh(now: number): Promise<void> {
    const jwks = await this.fetcher.fetch(this.jwksUri)
    const bounded: JSONWebKeySet = { keys: jwks.keys.slice(0, this.maxCachedKeys) }
    this.cache = { jwks: bounded, fetchedAt: now }
  }
}

/** The shape Nest's `MiddlewareConsumer.apply()` expects from a "functional middleware" — see `createOidcMiddlewareHandler`'s doc for why every service must register this, never the `OidcMiddleware` class itself. */
export type OidcMiddlewareHandler = (req: OidcAuthenticatedRequest, res: unknown, next: () => void) => Promise<void>

/**
 * Root cause of the Task 16d incident (six services crash-looping with
 * `UnknownDependenciesException [Error]: Nest can't resolve dependencies of
 * the OidcMiddleware (?)`), confirmed by reading the installed
 * `@nestjs/core@11.1.28` source rather than guessing:
 *
 * `MiddlewareConsumer.apply(OidcMiddleware)` (see `@nestjs/core`'s
 * `middleware/builder.js`) hands the class itself to
 * `MiddlewareContainer.insertConfig` (`middleware/container.js`), which
 * builds a BRAND NEW `InstanceWrapper` from that metatype — `token:
 * OidcMiddleware, metatype: OidcMiddleware` — with no `inject`/factory
 * metadata at all. It never looks at the module's own `providers` array, so
 * the `{ provide: OidcMiddleware, useFactory: createOidcMiddleware }`
 * binding every affected `app.module.ts` registered was never consulted for
 * middleware resolution — it only satisfies `OidcMiddleware` being injected
 * as an ordinary constructor dependency elsewhere, which nothing here does.
 * `Injector.loadMiddleware` (`injector/injector.js`) then resolves that
 * wrapper's constructor dependencies from its class's design-time metadata
 * — a single plain options object with no injectable type — and Nest can't
 * resolve an argument it has no provider for, hence the exception.
 *
 * The fix is NestJS's own documented escape hatch: "functional middleware"
 * — a plain function handed to `consumer.apply()` instead of a class. Nest
 * recognises this (`middleware/utils.js`'s `isMiddlewareClass` returns
 * `false` for it) and wraps it in a throwaway class with a NO-ARGUMENT
 * constructor, so `Injector` never needs to resolve anything for it — the
 * container is sidestepped entirely, which is exactly right for a
 * dependency that is runtime configuration (`OIDC_ISSUER`/`OIDC_AUDIENCE`/
 * `OIDC_JWKS_URI`), not a service the container should own the lifecycle
 * of.
 *
 * `createOidcMiddlewareHandler` builds one `OidcMiddleware` instance up
 * front from `options` (read from environment variables by each service's
 * own `createOidcMiddleware()`, never hard-coded here) and returns its
 * bound `use` method. Every security property of `OidcMiddleware.use` is
 * unchanged — same instance, same method, just invoked without ever passing
 * through Nest's DI container.
 */
export function createOidcMiddlewareHandler(options: OidcMiddlewareOptions): OidcMiddlewareHandler {
  const middleware = new OidcMiddleware(options)
  return (req, res, next) => middleware.use(req, res, next)
}
