/**
 * Every grant carries an org scope: the whole tenant (`'*'`), just the
 * caller's own record (`'self'`), or an explicit set of org-unit subtree
 * roots the caller may act within. Roadmap "Permission catalog".
 *
 * Named and exported separately from `Decision` (rather than inlined) so
 * `PermissionGuard` (`guard.ts`) and `authz/scope.ts`'s row-scoping helpers
 * can share exactly this type — see `guard.ts`'s `AuthenticatedRequest
 * .authzScope`, which is this same union attached to the request object so
 * a service's repository layer can apply it as a WHERE constraint, instead
 * of every service re-deriving the type or (worse) calling `AuthzClient
 * .decide()` a second time just to recover it (roadmap "🔴 Open security
 * gap": "svc-authz returns scopeOrgUnitIds, and nothing consumes it").
 */
export type AuthzScope = string[] | '*' | 'self'

export interface Decision {
  allowed: boolean
  scopeOrgUnitIds: AuthzScope
}

/** Transport to svc-authz (not yet built). Injectable so this client is unit-testable without HTTP. */
export interface AuthzTransport {
  post(path: string, body: unknown): Promise<unknown>
}

/**
 * Bounds how long a revoked grant can survive a missed/never-wired
 * `rules.updated`-style invalidation signal — `invalidateAll()` is the fast
 * path, this TTL is the backstop (fix round 1, IMPORTANT 1).
 */
export const DECISION_CACHE_TTL_MS = 60_000

/**
 * Simple FIFO bound: once the cache would hold more than this many distinct
 * `userId permission` entries, the oldest one is evicted before the new one
 * is stored. Without a bound, one process serving many distinct users grows
 * this cache forever (fix round 1, IMPORTANT 1).
 */
export const DECISION_CACHE_MAX_ENTRIES = 1000

/**
 * How long `decide` waits for svc-authz before treating the request as
 * unreachable. "Unreachable denies" only holds for a promise that settles
 * (a refused socket); a black-holed connection that never settles would
 * hang `PermissionGuard.canActivate` indefinitely without this
 * (fix round 1, IMPORTANT 5). Matches the house style set by
 * `db/pool.ts`'s explicit timeouts.
 */
export const AUTHZ_DECIDE_TIMEOUT_MS = 5_000

export interface AuthzClientOptions {
  /** Injectable clock for tests; defaults to `Date.now`. */
  now?: () => number
  /** Injectable per-request timeout in ms; defaults to `AUTHZ_DECIDE_TIMEOUT_MS`. */
  timeoutMs?: number
}

/** A fresh object every call — a cross-request shared constant here would let one caller's mutation corrupt every other denied decision (fix round 1, IMPORTANT 2). */
function deniedDecision(): Decision {
  return { allowed: false, scopeOrgUnitIds: [] }
}

/** Defensive copy so a caller mutating what `decide` returned cannot corrupt the cache entry (fix round 1, IMPORTANT 2). */
function cloneDecision(decision: Decision): Decision {
  return {
    allowed: decision.allowed,
    scopeOrgUnitIds: Array.isArray(decision.scopeOrgUnitIds) ? [...decision.scopeOrgUnitIds] : decision.scopeOrgUnitIds,
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function isDecision(v: unknown): v is Decision {
  if (!isRecord(v)) return false
  if (typeof v['allowed'] !== 'boolean') return false
  const scope = v['scopeOrgUnitIds']
  if (scope === '*' || scope === 'self') return true
  return Array.isArray(scope) && scope.every((id) => typeof id === 'string')
}

/** Rejects with `reason` once `ms` elapses, whichever settles first wins the race against `promise`. */
function withTimeout<T>(promise: Promise<T>, ms: number, reason: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(reason)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err as Error)
      },
    )
  })
}

interface CacheEntry {
  decision: Decision
  expiresAt: number
}

/**
 * Client for svc-authz. `decide` never rejects: an unreachable svc-authz
 * (refused socket, timeout, or a malformed response) resolves to the same
 * fail-closed decision a genuine denial would — an authz outage must never
 * be indistinguishable from "allowed" to a caller that only checks
 * `decision.allowed` (carried-forward binding note). Only a decision that
 * genuinely came back from svc-authz is cached.
 *
 * Decisions are cached per `userId permission` — not per permission alone,
 * which would leak one user's decision to another — bounded to
 * `DECISION_CACHE_MAX_ENTRIES` entries (FIFO eviction) and to
 * `DECISION_CACHE_TTL_MS` (so a revoked grant cannot survive indefinitely
 * even if `invalidateAll()` is never called), and cleared eagerly by
 * `invalidateAll()` on a `rules.updated`-style signal.
 */
export class AuthzClient {
  private readonly cache = new Map<string, CacheEntry>()
  private readonly now: () => number
  private readonly timeoutMs: number

  constructor(
    private readonly transport: AuthzTransport,
    options: AuthzClientOptions = {},
  ) {
    this.now = options.now ?? Date.now
    this.timeoutMs = options.timeoutMs ?? AUTHZ_DECIDE_TIMEOUT_MS
  }

  async decide(userId: string, permission: string): Promise<Decision> {
    // A space, not `:` — `userId`/permission strings can themselves contain
    // `:` (e.g. some ID schemes), which would let `decide('a:b','c')` and
    // `decide('a','b:c')` collide on the same cache entry (fix round 1,
    // MINOR). Permission catalog strings and userIds never contain spaces.
    const key = `${userId} ${permission}`

    const cached = this.cache.get(key)
    if (cached) {
      if (cached.expiresAt > this.now()) return cloneDecision(cached.decision)
      this.cache.delete(key) // expired — fall through and re-query
    }

    let response: unknown
    try {
      response = await withTimeout(
        this.transport.post('/decide', { userId, permission }),
        this.timeoutMs,
        `AuthzClient: svc-authz did not respond within ${this.timeoutMs}ms`,
      )
    } catch {
      return deniedDecision()
    }

    if (!isDecision(response)) return deniedDecision()

    this.store(key, response)
    return cloneDecision(response)
  }

  /** Drops every cached decision. Call this on a `rules.updated`-style signal (grant, role, or SoD-rule change). */
  invalidateAll(): void {
    this.cache.clear()
  }

  private store(key: string, decision: Decision): void {
    if (this.cache.size >= DECISION_CACHE_MAX_ENTRIES && !this.cache.has(key)) {
      // `Map` preserves insertion order, so the first key is the oldest —
      // a plain FIFO eviction, not a full LRU (no access-time bookkeeping).
      const oldestKey = this.cache.keys().next().value
      if (oldestKey !== undefined) this.cache.delete(oldestKey)
    }
    this.cache.set(key, { decision: cloneDecision(decision), expiresAt: this.now() + DECISION_CACHE_TTL_MS })
  }
}
