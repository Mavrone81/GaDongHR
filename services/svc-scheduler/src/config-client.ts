/**
 * Client for `svc-config`'s `/rules/:key` — the ONLY source of every
 * statutory number `GuardrailPolicy`, `HolidaysService` and `OtService`
 * compare against (brief CONSTRAINTS: "Every figure comes from svc-config
 * at runtime, never from code" / "No statutory number in a .ts file outside
 * a test fixture"). Shaped exactly like kernel's `AuthzClient`
 * (`packages/kernel/src/authz/client.ts`): a small injectable `transport`
 * interface so every test here runs against a fake, never real HTTP, and a
 * fail-... but NOT fail-open... contract for "svc-config is unreachable".
 *
 * Unlike `AuthzClient`, an unreachable `svc-config` does not fail a
 * decision closed to "false" — there is no boolean to fail closed to here,
 * only a number this service cannot invent. `getRule` therefore REJECTS
 * (throws `ConfigRuleUnavailable`) rather than returning some placeholder
 * ceiling — inventing a number here would be the exact defect this whole
 * module exists to prevent (a hard-coded ceiling standing in for the real
 * one, invisible until an inspector asks where 48 came from). Callers
 * (`GuardrailPolicy`, `HolidaysService`, `OtService`) must let that
 * rejection propagate as a 5xx, never substitute a default.
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

  /** `GET /rules/:key` (optionally `?on=<date>`), svc-config's exact `StatutoryRuleRow` shape narrowed to the fields this service needs. */
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

  /** Convenience for the common case: a rule whose `value` is a plain number (e.g. `hours.regular.max_per_day`). */
  async getNumber(ruleKey: string, on?: string): Promise<{ value: number; citation: string }> {
    const rule = await this.getRule(ruleKey, on)
    if (typeof rule.value !== 'number') {
      throw new ConfigRuleUnavailable(ruleKey, `expected a numeric value, got ${JSON.stringify(rule.value)}`)
    }
    return { value: rule.value, citation: rule.citation }
  }
}
