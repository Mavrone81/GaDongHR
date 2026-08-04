import { ConfigClient } from '../config-client'
import type { ConfigTransport, EffectiveRule } from '../config-client'

/** In-memory `ConfigTransport` — every statutory figure a test needs comes from here, never a literal in the code under test (brief CONSTRAINTS), and can be reconfigured mid-test to prove behaviour moves with config. */
export class FakeConfigTransport implements ConfigTransport {
  private readonly rules = new Map<string, EffectiveRule>()

  set(rule: EffectiveRule): void {
    this.rules.set(rule.ruleKey, rule)
  }

  async get(path: string): Promise<unknown> {
    const match = /^\/rules\/([^?]+)/.exec(path)
    const key = match?.[1] ? decodeURIComponent(match[1]) : undefined
    if (!key) throw new Error(`FakeConfigTransport: unparseable path ${path}`)
    const rule = this.rules.get(key)
    if (!rule) throw new Error(`FakeConfigTransport: no rule seeded for "${key}"`)
    return rule
  }
}

/** The statutory defaults `ConsolidationService`/views tests need by default — individual tests override via `transport.set(...)` to prove config-driven behaviour. */
export function defaultTimesheetConfig(): { transport: FakeConfigTransport; client: ConfigClient } {
  const transport = new FakeConfigTransport()
  transport.set({
    ruleKey: 'hours.regular.max_per_day',
    value: 8,
    unit: 'hours',
    citation: 'LPA s.23',
    statutoryFloor: null,
    statutoryCeiling: 8,
  })
  transport.set({
    ruleKey: 'ot.hourly_base.divisor',
    value: 240,
    unit: 'divisor',
    citation: 'ot.hourly_base.formula',
    statutoryFloor: null,
    statutoryCeiling: 240,
  })
  return { transport, client: new ConfigClient(transport) }
}
