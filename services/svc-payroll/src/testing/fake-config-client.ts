import { resolveEffective } from '@gadong/kernel'
import type { ConfigClient, StatutoryRuleView } from '../config-client'

/**
 * In-memory stand-in for `svc-config` — and, unlike `svc-leave`'s
 * equivalent, a genuinely EFFECTIVE-DATED one, because that is the
 * behaviour M7's central acceptance criterion turns on.
 *
 * Multiple versions of one rule key are seeded with their own
 * `effectiveFrom`/`effectiveTo`, and resolution goes through the kernel's
 * `resolveEffective` — the same function `svc-config` itself uses, with the
 * same inclusive-bounds semantics. So "a September 2026 run applies no EWF
 * and an October 2026 run applies 0.25%" is exercised here exactly as it
 * would be against the real service: the rule simply has no version in
 * force on 2026-09-30, and one from 2026-10-01.
 *
 * `amend` replaces a version in place. That is the mechanism behind "every
 * figure from config": a test changes a rate and asserts the computed net
 * MOVES, rather than asserting a constant that would pass just as happily
 * against a hard-coded engine.
 */
export class FakeConfigClient implements ConfigClient {
  private readonly rules = new Map<string, StatutoryRuleView[]>()
  /** Every (key, date) pair asked for — lets a test assert that the engine resolved as of the period end, not "now". */
  readonly requests: Array<{ ruleKey: string; on: string }> = []

  seed(rule: StatutoryRuleView): void {
    const versions = this.rules.get(rule.ruleKey) ?? []
    versions.push(rule)
    this.rules.set(rule.ruleKey, versions)
  }

  seedMany(rules: readonly StatutoryRuleView[]): void {
    for (const rule of rules) this.seed(rule)
  }

  /** Replaces the value of the version effective on `on` — the config change a test then asserts moved the payslip. */
  amend(ruleKey: string, on: string, value: unknown): void {
    const versions = this.rules.get(ruleKey)
    if (versions === undefined) throw new Error(`FakeConfigClient.amend: no seeded rule for ${JSON.stringify(ruleKey)}`)
    const match = resolveEffective(versions, on)
    if (match === null) throw new Error(`FakeConfigClient.amend: no version of ${ruleKey} effective on ${on}`)
    match.value = value
  }

  /** Removes every version of a key — used to prove a REQUIRED rule failing the run with PAY-503 rather than defaulting. */
  remove(ruleKey: string): void {
    this.rules.delete(ruleKey)
  }

  async getEffectiveRule(ruleKey: string, on: string): Promise<StatutoryRuleView | null> {
    this.requests.push({ ruleKey, on })
    const versions = this.rules.get(ruleKey)
    if (versions === undefined) return null
    return resolveEffective(versions, on)
  }
}
