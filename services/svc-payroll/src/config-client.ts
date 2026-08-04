import { statutoryRuleNotResolved } from './errors'

/**
 * The one seam through which every Thai statutory figure this service uses
 * reaches it. Same shape and same reasoning as
 * `services/svc-leave/src/config-client.ts`: `HttpConfigClient` calls the
 * real `svc-config` `GET /rules/:key?on=<date>`; tests inject
 * `testing/fake-config-client.ts`.
 *
 * The `on` parameter is what makes the EWF acceptance criterion possible
 * without a code change. `svc-config` stores each rule as effective-dated
 * versions; asking for `ewf.rate.employee` as of 2026-09-30 resolves to
 * nothing (the first version's `effective_from` is 2026-10-01) and asking
 * as of 2026-10-31 resolves to 0.25. The engine's behaviour therefore moves
 * with the calendar and the rule pack, not with a release.
 */
export interface StatutoryRuleView {
  ruleKey: string
  /** `config.statutory_rule.value` is `jsonb`, so this is `unknown` until a caller narrows it — see `statutory.ts`, which is the only file that does. */
  value: unknown
  /** `null` when this rule's governance class carries no legal minimum. */
  statutoryFloor: unknown
  citation: string
  effectiveFrom: string
  effectiveTo: string | null
}

export interface ConfigClient {
  /** `null` when no version of `ruleKey` is effective on `on` — a legitimate answer ("not in force yet"), not an error. The caller decides whether that is fatal. */
  getEffectiveRule(ruleKey: string, on: string): Promise<StatutoryRuleView | null>
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function parseRuleResponse(ruleKey: string, on: string, body: unknown): StatutoryRuleView {
  if (!isRecord(body)) throw statutoryRuleNotResolved(ruleKey, on)
  const citation = body['citation']
  const effectiveFrom = body['effective_from']
  const effectiveTo = body['effective_to']
  if (typeof citation !== 'string' || typeof effectiveFrom !== 'string') throw statutoryRuleNotResolved(ruleKey, on)
  return {
    ruleKey,
    value: body['value'],
    statutoryFloor: body['statutory_floor'] ?? null,
    citation,
    effectiveFrom,
    effectiveTo: effectiveTo === null || effectiveTo === undefined ? null : String(effectiveTo),
  }
}

/** Real HTTP client. `baseUrl` comes from `CONFIG_URL` in `app.module.ts`, never a hard-coded hostname. */
export class HttpConfigClient implements ConfigClient {
  constructor(private readonly baseUrl: string) {}

  async getEffectiveRule(ruleKey: string, on: string): Promise<StatutoryRuleView | null> {
    const res = await fetch(`${this.baseUrl}/rules/${encodeURIComponent(ruleKey)}?on=${encodeURIComponent(on)}`)
    if (res.status === 404) return null
    if (!res.ok) throw statutoryRuleNotResolved(ruleKey, on)
    const body: unknown = await res.json()
    return parseRuleResponse(ruleKey, on, body)
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
