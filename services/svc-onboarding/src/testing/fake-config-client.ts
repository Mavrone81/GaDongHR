import type { ConfigClient } from '../config-client'

/** Deterministic stand-in for `svc-config` — proves the SSO deadline is genuinely resolved through this port (never hard-coded) by returning a value tests choose, not a baked-in `30`. */
export function fakeConfigClient(values: Record<string, number>): ConfigClient {
  return {
    async getNumericRule(ruleKey: string): Promise<number> {
      const value = values[ruleKey]
      if (value === undefined) throw new Error(`fakeConfigClient: no fixture value for rule "${ruleKey}"`)
      return Promise.resolve(value)
    },
  }
}
