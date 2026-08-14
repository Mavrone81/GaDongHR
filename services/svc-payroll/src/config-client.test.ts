import { HttpConfigClient } from './config-client'

/**
 * Regression test for a real defect found while wiring S2S auth into this
 * exact call site (S2S auth task): `parseRuleResponse` read
 * `effective_from`/`effective_to`/`statutory_floor` (snake_case), but
 * `services/svc-config/src/rules.controller.ts`'s real response — built by
 * `RulesService`'s `EffectiveRuleView` — serialises `effectiveFrom`/
 * `effectiveTo`/`statutoryFloor` in camelCase. Every real call therefore
 * fell through to `statutoryRuleNotResolved`, indistinguishable from "no
 * such rule" — invisible until the e2e lifecycle suite reached this call
 * for the first time (previously blocked earlier in the pipeline by the
 * pre-fix 403 on `config.rule.read`). This fixture is the REAL response
 * shape (camelCase), not the wrong one the old parser expected.
 */
function fakeFetch(responses: Record<string, { status: number; body?: unknown }>): typeof fetch {
  return (async (input: string) => {
    const url = String(input)
    const match = Object.keys(responses).find((k) => url.includes(k))
    const response = match ? responses[match] : undefined
    if (!response) throw new Error(`fakeFetch: no fixture for ${url}`)
    return {
      status: response.status,
      ok: response.status >= 200 && response.status < 300,
      json: async () => response.body,
    } as Response
  }) as typeof fetch
}

describe('HttpConfigClient.getEffectiveRule', () => {
  it('parses the real (camelCase) svc-config response shape', async () => {
    const client = new HttpConfigClient(
      'http://svc-config',
      fakeFetch({
        '/rules/minwage.daily.TH-10': {
          status: 200,
          body: {
            id: 'rule-1',
            ruleKey: 'minwage.daily.TH-10',
            value: 400,
            unit: 'THB',
            statutoryFloor: null,
            statutoryCeiling: null,
            citation: 'Wage Committee notification, Bangkok',
            effectiveFrom: '2025-01-01',
            effectiveTo: null,
            governanceClass: 'STATUTORY_FIXED',
          },
        },
      }),
    )

    const rule = await client.getEffectiveRule('minwage.daily.TH-10', '2026-08-14')
    expect(rule).not.toBeNull()
    expect(rule?.value).toBe(400)
    expect(rule?.citation).toBe('Wage Committee notification, Bangkok')
    expect(rule?.effectiveFrom).toBe('2025-01-01')
    expect(rule?.effectiveTo).toBeNull()
    expect(rule?.statutoryFloor).toBeNull()
  })

  it('returns null on a real 404 (no version effective on that date) rather than throwing', async () => {
    const client = new HttpConfigClient('http://svc-config', fakeFetch({ '/rules/some.key': { status: 404 } }))
    await expect(client.getEffectiveRule('some.key', '2026-08-14')).resolves.toBeNull()
  })

  it('throws statutoryRuleNotResolved on a non-2xx, non-404 response', async () => {
    const client = new HttpConfigClient('http://svc-config', fakeFetch({ '/rules/some.key': { status: 500 } }))
    await expect(client.getEffectiveRule('some.key', '2026-08-14')).rejects.toThrow()
  })

  it('sends the request through the injected fetchImpl (S2S auth task: this is where a machine bearer token gets attached)', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({
        citation: 'c',
        effectiveFrom: '2025-01-01',
        effectiveTo: null,
        statutoryFloor: null,
        value: 1,
      }),
    })
    const client = new HttpConfigClient('http://svc-config', fetchImpl as unknown as typeof fetch)
    await client.getEffectiveRule('some.key', '2026-08-14')
    expect(fetchImpl).toHaveBeenCalledWith('http://svc-config/rules/some.key?on=2026-08-14')
  })
})
