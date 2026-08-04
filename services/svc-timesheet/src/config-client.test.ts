import { ConfigClient, ConfigRuleUnavailable } from './config-client'
import type { ConfigTransport } from './config-client'

describe('ConfigClient', () => {
  it('getNumber returns value/citation/floor/ceiling for a valid numeric rule', async () => {
    const transport: ConfigTransport = {
      get: async () => ({
        ruleKey: 'hours.regular.max_per_day',
        value: 8,
        unit: 'hours',
        citation: 'LPA s.23',
        statutoryFloor: null,
        statutoryCeiling: 8,
      }),
    }
    const client = new ConfigClient(transport)
    const result = await client.getNumber('hours.regular.max_per_day')
    expect(result).toEqual({ value: 8, citation: 'LPA s.23', statutoryFloor: null, statutoryCeiling: 8 })
  })

  it('rejects when the transport throws (svc-config unreachable) — never a placeholder number', async () => {
    const transport: ConfigTransport = {
      get: async () => {
        throw new Error('ECONNREFUSED')
      },
    }
    const client = new ConfigClient(transport)
    await expect(client.getRule('hours.regular.max_per_day')).rejects.toBeInstanceOf(ConfigRuleUnavailable)
  })

  it('rejects when the response is not a well-shaped EffectiveRule', async () => {
    const transport: ConfigTransport = { get: async () => ({ nonsense: true }) }
    const client = new ConfigClient(transport)
    await expect(client.getRule('x')).rejects.toBeInstanceOf(ConfigRuleUnavailable)
  })

  it('getNumber rejects when value is not numeric', async () => {
    const transport: ConfigTransport = {
      get: async () => ({ ruleKey: 'x', value: 'not-a-number', unit: 'hours', citation: 'c' }),
    }
    const client = new ConfigClient(transport)
    await expect(client.getNumber('x')).rejects.toBeInstanceOf(ConfigRuleUnavailable)
  })

  it('getRule passes the ?on= query when a date is given', async () => {
    let capturedPath = ''
    const transport: ConfigTransport = {
      get: async (path) => {
        capturedPath = path
        return { ruleKey: 'x', value: 1, unit: 'hours', citation: 'c' }
      },
    }
    const client = new ConfigClient(transport)
    await client.getRule('x', '2026-08-01')
    expect(capturedPath).toBe('/rules/x?on=2026-08-01')
  })
})
