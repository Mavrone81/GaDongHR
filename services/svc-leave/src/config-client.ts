import { statutoryRuleNotResolved } from './errors'

/**
 * Every statutory figure this service ever compares an entitlement against
 * — the annual-leave floor, the sick-leave floor, the maternity floor, the
 * medical-certificate trigger floor — is resolved from `svc-config` at
 * request time through this port, never written as a literal in this
 * codebase (Task brief CONSTRAINTS: "No statutory number in a `.ts` file
 * outside a test fixture", "Every figure resolves from `svc-config` at
 * runtime, never from code"). `ConfigClient` is this service's one seam for
 * that: `HttpConfigClient` calls the real `svc-config` `GET /rules/:key`
 * (the same route `services/svc-config/src/rules.controller.ts` exposes);
 * tests inject `testing/fake-config-client.ts` instead — matching how
 * `AuthzClient`/`CryptoClient` are real HTTP clients in production and
 * fakes in every test in this codebase.
 */
export interface StatutoryRuleView {
  ruleKey: string
  /** The value currently in force — usually a plain number (days), but `config.statutory_rule.value` is `jsonb` so this is `unknown` until a caller narrows it. */
  value: unknown
  /** `null` when this rule's governance class carries no legal minimum (`COMPANY_POLICY`). */
  statutoryFloor: unknown
  citation: string
  effectiveFrom: string
  effectiveTo: string | null
}

export interface ConfigClient {
  /** `null` when no version of `ruleKey` is effective on `on` (default: today) — a real gap, not an error (mirrors `RulesService.getEffective`'s 404 shape, translated to `null` at this port boundary so callers decide what a missing rule means for them). */
  getEffectiveRule(ruleKey: string, on?: string): Promise<StatutoryRuleView | null>
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function parseRuleResponse(ruleKey: string, body: unknown): StatutoryRuleView {
  if (!isRecord(body)) throw statutoryRuleNotResolved(ruleKey)
  const citation = body['citation']
  const effectiveFrom = body['effective_from']
  const effectiveTo = body['effective_to']
  if (typeof citation !== 'string' || typeof effectiveFrom !== 'string') throw statutoryRuleNotResolved(ruleKey)
  return {
    ruleKey,
    value: body['value'],
    statutoryFloor: body['statutory_floor'] ?? null,
    citation,
    effectiveFrom,
    effectiveTo: effectiveTo === null || effectiveTo === undefined ? null : String(effectiveTo),
  }
}

/** Real HTTP client against `svc-config`. `baseUrl` comes from `CONFIG_URL` (`app.module.ts`), never a hard-coded hostname — fail-closed, matching every other service-to-service client in this codebase. */
export class HttpConfigClient implements ConfigClient {
  constructor(private readonly baseUrl: string) {}

  async getEffectiveRule(ruleKey: string, on?: string): Promise<StatutoryRuleView | null> {
    const query = on !== undefined ? `?on=${encodeURIComponent(on)}` : ''
    const res = await fetch(`${this.baseUrl}/rules/${encodeURIComponent(ruleKey)}${query}`)
    if (res.status === 404) return null
    if (!res.ok) throw statutoryRuleNotResolved(ruleKey)
    const body: unknown = await res.json()
    return parseRuleResponse(ruleKey, body)
  }

  async health(): Promise<'up' | 'down'> {
    try {
      const res = await fetch(`${this.baseUrl}/health`)
      return res.ok ? 'up' : 'down'
    } catch {
      return 'down'
    }
  }
}
