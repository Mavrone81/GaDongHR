import { ConfigClient, ConfigRuleUnavailable } from './config-client'
import type { ConfigTransport } from './config-client'

function fakeTransport(rules: Record<string, unknown>): ConfigTransport {
  return {
    async get(path: string) {
      const match = /^\/rules\/([^?]+)/.exec(path)
      const key = match?.[1] ? decodeURIComponent(match[1]) : undefined
      if (!key || !(key in rules)) throw new Error(`404: no such rule ${String(key)}`)
      return rules[key]
    },
  }
}

describe('ConfigClient.getRule', () => {
  it('returns the effective rule for a key', async () => {
    const client = new ConfigClient(
      fakeTransport({
        'hours.regular.max_per_day': {
          ruleKey: 'hours.regular.max_per_day',
          value: 8,
          unit: 'hours',
          citation: 'LPA s.23',
          statutoryFloor: null,
          statutoryCeiling: 8,
        },
      }),
    )

    const rule = await client.getRule('hours.regular.max_per_day')
    expect(rule.value).toBe(8)
    expect(rule.citation).toBe('LPA s.23')
  })

  it('throws ConfigRuleUnavailable — never invents a number — when the transport rejects', async () => {
    const client = new ConfigClient({
      get: () => Promise.reject(new Error('ECONNREFUSED')),
    })

    await expect(client.getRule('hours.regular.max_per_day')).rejects.toThrow(ConfigRuleUnavailable)
  })

  it('throws ConfigRuleUnavailable when the response is not a recognisable effective-rule shape', async () => {
    const client = new ConfigClient({ get: () => Promise.resolve({ not: 'a rule' }) })

    await expect(client.getRule('hours.regular.max_per_day')).rejects.toThrow(ConfigRuleUnavailable)
  })

  it('passes ?on= through when given a target date', async () => {
    const get = jest.fn().mockResolvedValue({
      ruleKey: 'hours.ot.max_per_week',
      value: 36,
      unit: 'hours',
      citation: 'LPA s.26',
      statutoryFloor: null,
      statutoryCeiling: 36,
    })
    const client = new ConfigClient({ get })

    await client.getRule('hours.ot.max_per_week', '2026-08-01')

    expect(get).toHaveBeenCalledWith('/rules/hours.ot.max_per_week?on=2026-08-01')
  })
})

describe('ConfigClient.getNumber', () => {
  it('narrows a numeric-value rule', async () => {
    const client = new ConfigClient(
      fakeTransport({
        'hours.ot.max_per_week': {
          ruleKey: 'hours.ot.max_per_week',
          value: 36,
          unit: 'hours',
          citation: 'LPA s.26',
          statutoryFloor: null,
          statutoryCeiling: 36,
        },
      }),
    )

    const result = await client.getNumber('hours.ot.max_per_week')
    expect(result).toEqual({ value: 36, citation: 'LPA s.26' })
  })

  it('rejects when the rule value is not a number', async () => {
    const client = new ConfigClient(
      fakeTransport({
        'hours.regular.max_per_week': {
          ruleKey: 'hours.regular.max_per_week',
          value: { standard: 48, hazardous: 42 },
          unit: 'hours',
          citation: 'LPA s.23',
          statutoryFloor: null,
          statutoryCeiling: null,
        },
      }),
    )

    await expect(client.getNumber('hours.regular.max_per_week')).rejects.toThrow(ConfigRuleUnavailable)
  })
})
