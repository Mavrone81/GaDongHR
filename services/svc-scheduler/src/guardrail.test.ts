import { ConfigClient } from './config-client'
import type { ConfigTransport } from './config-client'
import { GuardrailPolicy, evaluateDailyTotal, evaluateWeeklyTotal, hasBlocking } from './guardrail'

function ruleResponse(ruleKey: string, value: unknown, citation: string): unknown {
  return { ruleKey, value, unit: 'hours', citation, statutoryFloor: null, statutoryCeiling: null }
}

/** A `ConfigTransport` whose `hours.regular.max_per_week` value is injected per-test — this IS the "numbers come from config" proof: the same policy code, pointed at two different transports, produces two different outcomes. */
function transportWithWeeklyCeiling(standard: number, hazardous: number): ConfigTransport {
  const rules: Record<string, unknown> = {
    'hours.regular.max_per_day': ruleResponse('hours.regular.max_per_day', 8, 'LPA s.23'),
    'hours.regular.max_per_week': ruleResponse('hours.regular.max_per_week', { standard, hazardous }, 'LPA s.23'),
    'hours.ot.max_per_week': ruleResponse('hours.ot.max_per_week', 36, 'LPA s.26 + Ministerial Reg.'),
  }
  return {
    get: (path: string) => {
      const key = /^\/rules\/([^?]+)/.exec(path)?.[1]
      const rule = key ? rules[decodeURIComponent(key)] : undefined
      if (!rule) return Promise.reject(new Error(`no such rule: ${String(key)}`))
      return Promise.resolve(rule)
    },
  }
}

describe('evaluateWeeklyTotal — pure ceiling/warn-buffer logic', () => {
  it('47.5 of a 48h ceiling warns (within the 1h buffer) but does not block', () => {
    const { conflict, total } = evaluateWeeklyTotal('SCH-010', 'scheduler.error.weekly_hours', 47.5 * 60, 48, 'LPA s.23')
    expect(conflict).not.toBeNull()
    expect(conflict?.severity).toBe('warn')
    expect(total).toEqual({ hours: '47.50', ceilingHours: '48.00', citation: 'LPA s.23' })
  })

  it('48.5 of a 48h ceiling blocks', () => {
    const { conflict } = evaluateWeeklyTotal('SCH-010', 'scheduler.error.weekly_hours', 48.5 * 60, 48, 'LPA s.23')
    expect(conflict).not.toBeNull()
    expect(conflict?.severity).toBe('block')
  })

  it('40.0 of a 48h ceiling — comfortably under — produces no conflict at all, only the running total', () => {
    const { conflict, total } = evaluateWeeklyTotal('SCH-010', 'scheduler.error.weekly_hours', 40 * 60, 48, 'LPA s.23')
    expect(conflict).toBeNull()
    expect(total.hours).toBe('40.00')
  })

  it('exactly at the ceiling (48.0 of 48) warns, not blocks — the ceiling itself is still compliant', () => {
    const { conflict } = evaluateWeeklyTotal('SCH-010', 'scheduler.error.weekly_hours', 48 * 60, 48, 'LPA s.23')
    expect(conflict?.severity).toBe('warn')
  })
})

describe('evaluateDailyTotal', () => {
  it('8.0 of an 8h daily ceiling is compliant', () => {
    expect(evaluateDailyTotal(8 * 60, 8, 'LPA s.23').conflict).toBeNull()
  })

  it('8.5 of an 8h daily ceiling blocks', () => {
    const { conflict } = evaluateDailyTotal(8.5 * 60, 8, 'LPA s.23')
    expect(conflict?.severity).toBe('block')
    expect(conflict?.code).toBe('SCH-010')
  })
})

describe('hasBlocking', () => {
  it('is true when any item is a block, false when all are warn or the report is empty', () => {
    expect(hasBlocking({ items: [] })).toBe(false)
    expect(
      hasBlocking({ items: [{ code: 'X', severity: 'warn', messageI18nKey: 'k', details: {} }] }),
    ).toBe(false)
    expect(
      hasBlocking({
        items: [
          { code: 'X', severity: 'warn', messageI18nKey: 'k', details: {} },
          { code: 'Y', severity: 'block', messageI18nKey: 'k2', details: {} },
        ],
      }),
    ).toBe(true)
  })
})

describe('GuardrailPolicy.loadCeilings — this is the "engine, not hard-coded limits" proof (brief)', () => {
  it('with the default-shaped config (48/42), 48.5h projected total blocks', async () => {
    const policy = new GuardrailPolicy(new ConfigClient(transportWithWeeklyCeiling(48, 42)))
    const ceilings = await policy.loadCeilings(false)
    expect(ceilings.weeklyHours).toBe(48)

    const { conflict } = evaluateWeeklyTotal('SCH-010', 'scheduler.error.weekly_hours', 48.5 * 60, ceilings.weeklyHours, ceilings.weeklyCitation)
    expect(conflict?.severity).toBe('block')
  })

  it('CONFIG-DRIVEN, NOT HARD-CODED: raising the same key\'s weekly ceiling to 50 in config makes the SAME 48.5h total pass with no code change', async () => {
    const policy = new GuardrailPolicy(new ConfigClient(transportWithWeeklyCeiling(50, 44)))
    const ceilings = await policy.loadCeilings(false)
    expect(ceilings.weeklyHours).toBe(50)

    const { conflict } = evaluateWeeklyTotal('SCH-010', 'scheduler.error.weekly_hours', 48.5 * 60, ceilings.weeklyHours, ceilings.weeklyCitation)
    // Same 48.5h projected total that BLOCKED against the 48h config above
    // now passes with no conflict at all (48.5 is more than 1h under the
    // new 50h ceiling) — the behaviour moved because the config value
    // moved, not because any code changed.
    expect(conflict).toBeNull()
  })

  it('picks the hazardous figure (42) instead of standard (48) when the hazardous flag is set — still entirely config-sourced', async () => {
    const policy = new GuardrailPolicy(new ConfigClient(transportWithWeeklyCeiling(48, 42)))
    const ceilings = await policy.loadCeilings(true)
    expect(ceilings.weeklyHours).toBe(42)
  })

  it('rejects a malformed compound value rather than silently falling back to a hard-coded default', async () => {
    const transport: ConfigTransport = {
      get: (path: string) => {
        if (path.startsWith('/rules/hours.regular.max_per_week')) {
          return Promise.resolve(ruleResponse('hours.regular.max_per_week', { standard: 48 }, 'LPA s.23')) // missing hazardous
        }
        if (path.startsWith('/rules/hours.regular.max_per_day')) {
          return Promise.resolve(ruleResponse('hours.regular.max_per_day', 8, 'LPA s.23'))
        }
        return Promise.resolve(ruleResponse('hours.ot.max_per_week', 36, 'LPA s.26'))
      },
    }
    const policy = new GuardrailPolicy(new ConfigClient(transport))
    await expect(policy.loadCeilings(true)).rejects.toThrow(/does not carry a numeric "hazardous"/)
  })
})
