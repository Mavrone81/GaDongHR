/**
 * Client for `svc-config`'s `/rules/:key` — the ONLY source of every
 * statutory number this service compares against (brief CONSTRAINTS: "Every
 * figure resolves from svc-config at runtime, never from code" / "No
 * multiplier or divisor hard-coded in a `.ts` file outside a test fixture").
 * Shaped exactly like `services/svc-scheduler/src/config-client.ts` (itself
 * shaped like kernel's `AuthzClient`): a small injectable `transport`
 * interface so every test runs against a fake, never real HTTP.
 *
 * Unlike `AuthzClient`, an unreachable `svc-config` does not fail closed to
 * a boolean — there is no safe placeholder number to invent here. `getRule`
 * REJECTS (throws `ConfigRuleUnavailable`) rather than returning a
 * placeholder; callers must let that propagate as a 5xx.
 */
export interface ConfigTransport {
  get(path: string): Promise<unknown>
}

export interface EffectiveRule {
  ruleKey: string
  value: unknown
  unit: string
  citation: string
  statutoryFloor: unknown
  statutoryCeiling: unknown
}

export class ConfigRuleUnavailable extends Error {
  constructor(readonly ruleKey: string, cause?: unknown) {
    super(`svc-config: rule "${ruleKey}" is unavailable${cause ? `: ${String(cause)}` : ''}`)
    this.name = 'ConfigRuleUnavailable'
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function isEffectiveRule(v: unknown): v is EffectiveRule {
  if (!isRecord(v)) return false
  return typeof v['ruleKey'] === 'string' && typeof v['unit'] === 'string' && typeof v['citation'] === 'string'
}

export class ConfigClient {
  constructor(private readonly transport: ConfigTransport) {}

  /** `GET /rules/:key` (optionally `?on=<date>`). */
  async getRule(ruleKey: string, on?: string): Promise<EffectiveRule> {
    let response: unknown
    try {
      const query = on ? `?on=${encodeURIComponent(on)}` : ''
      response = await this.transport.get(`/rules/${encodeURIComponent(ruleKey)}${query}`)
    } catch (err) {
      throw new ConfigRuleUnavailable(ruleKey, err)
    }
    if (!isEffectiveRule(response)) throw new ConfigRuleUnavailable(ruleKey)
    return response
  }

  /** Convenience for the common case: a rule whose `value` is a plain number (e.g. `hours.regular.max_per_day`, `ot.workday.multiplier`, `ot.hourly_base.divisor`). */
  async getNumber(ruleKey: string, on?: string): Promise<{ value: number; citation: string; statutoryFloor: number | null; statutoryCeiling: number | null }> {
    const rule = await this.getRule(ruleKey, on)
    if (typeof rule.value !== 'number') {
      throw new ConfigRuleUnavailable(ruleKey, `expected a numeric value, got ${JSON.stringify(rule.value)}`)
    }
    return {
      value: rule.value,
      citation: rule.citation,
      statutoryFloor: typeof rule.statutoryFloor === 'number' ? rule.statutoryFloor : null,
      statutoryCeiling: typeof rule.statutoryCeiling === 'number' ? rule.statutoryCeiling : null,
    }
  }
}
