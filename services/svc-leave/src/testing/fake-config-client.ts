import type { ConfigClient, StatutoryRuleView } from '../config-client'

/**
 * In-memory stand-in for `svc-config` (Task brief CONSTRAINTS: "no Postgres
 * here — test against a fake as `services/svc-config` does"; the same
 * reasoning extends to the service-to-service call this module makes to
 * resolve statutory floors). Tests seed rules directly, and — this is the
 * point of the whole exercise — can MUTATE a seeded rule's floor/value
 * mid-test and re-assert: "prove [config-drivenness] by changing a config
 * value and asserting behaviour moves with it, rather than asserting a
 * constant" (Task brief TESTS).
 */
export class FakeConfigClient implements ConfigClient {
  private readonly rules = new Map<string, StatutoryRuleView>()

  seed(rule: StatutoryRuleView): void {
    this.rules.set(rule.ruleKey, rule)
  }

  /** Replaces a previously-seeded rule's floor and/or value in place — the mutation the config-driven tests exercise. */
  amend(ruleKey: string, patch: Partial<Pick<StatutoryRuleView, 'value' | 'statutoryFloor' | 'citation'>>): void {
    const existing = this.rules.get(ruleKey)
    if (!existing) throw new Error(`FakeConfigClient.amend: no seeded rule for "${ruleKey}"`)
    this.rules.set(ruleKey, { ...existing, ...patch })
  }

  async getEffectiveRule(ruleKey: string): Promise<StatutoryRuleView | null> {
    return this.rules.get(ruleKey) ?? null
  }
}
