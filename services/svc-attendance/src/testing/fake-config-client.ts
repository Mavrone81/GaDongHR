import type { ConfigClient } from '../config-client'

/** A `ConfigClient` backed by an in-memory map — no network, deterministic. `unset(key)`'d or never-`set` keys throw, matching the real client's "no silent default" contract. */
export class FakeConfigClient implements ConfigClient {
  private readonly rules = new Map<string, number>()

  set(ruleKey: string, value: number): void {
    this.rules.set(ruleKey, value)
  }

  async getNumericRule(ruleKey: string): Promise<number> {
    const value = this.rules.get(ruleKey)
    if (value === undefined) throw new Error(`FakeConfigClient: no effective rule for "${ruleKey}"`)
    return value
  }
}
