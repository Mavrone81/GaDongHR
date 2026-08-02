/**
 * Every grant carries an org scope: the whole tenant (`'*'`), just the
 * caller's own record (`'self'`), or an explicit set of org-unit subtree
 * roots the caller may act within. Roadmap "Permission catalog".
 */
export interface Decision {
  allowed: boolean
  scopeOrgUnitIds: string[] | '*' | 'self'
}

/** Transport to svc-authz (not yet built). Injectable so this client is unit-testable without HTTP. */
export interface AuthzTransport {
  post(path: string, body: unknown): Promise<unknown>
}

const DENIED: Decision = { allowed: false, scopeOrgUnitIds: [] }

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

/**
 * Client for svc-authz. `decide` never rejects: an unreachable svc-authz, or
 * a malformed response, resolves to the same fail-closed `DENIED` decision a
 * genuine denial would — an authz outage must never be indistinguishable
 * from "allowed" to a caller that only checks `decision.allowed`
 * (carried-forward binding note). Only a decision that genuinely came back
 * from svc-authz is cached.
 *
 * Decisions are cached per `userId:permission` — not per permission alone,
 * which would leak one user's decision to another — until `invalidateAll()`
 * is called on a `rules.updated`-style signal (a grant/role change), so a
 * revoked permission does not stay silently granted for the life of the
 * process.
 */
export class AuthzClient {
  private readonly cache = new Map<string, Decision>()

  constructor(private readonly transport: AuthzTransport) {}

  async decide(userId: string, permission: string): Promise<Decision> {
    const key = `${userId}:${permission}`
    const cached = this.cache.get(key)
    if (cached) return cached

    let response: unknown
    try {
      response = await this.transport.post('/decide', { userId, permission })
    } catch {
      return DENIED
    }

    if (!isDecision(response)) return DENIED

    this.cache.set(key, response)
    return response
  }

  /** Drops every cached decision. Call this on a `rules.updated`-style signal (grant, role, or SoD-rule change). */
  invalidateAll(): void {
    this.cache.clear()
  }
}
