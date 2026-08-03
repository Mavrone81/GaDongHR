import { add, clampNonNegative, compare, fromScaled, isNegative, mulFractionRound, subtract, toScaled, ZERO } from './decimal'

describe('Decimal — exact fixed-point arithmetic, no float', () => {
  it('round-trips whole numbers', () => {
    expect(fromScaled(toScaled('6'))).toBe('6')
    expect(fromScaled(toScaled('30'))).toBe('30')
    expect(fromScaled(toScaled('120'))).toBe('120')
  })

  it('represents half-days exactly', () => {
    expect(add('0.5', '0.5')).toBe('1')
    expect(add('6', '0.5')).toBe('6.5')
  })

  it('represents eighth-days (hourly leave against an 8-hour day) exactly', () => {
    expect(fromScaled(toScaled('0.125'))).toBe('0.125')
    expect(add('0.125', '0.125')).toBe('0.25')
  })

  it('add/subtract are exact across many small operations (no float drift)', () => {
    let running = ZERO
    for (let i = 0; i < 10; i++) running = add(running, '0.1')
    // A float `0.1` repeated ten times gives 0.9999999999999999 in IEEE754.
    expect(running).toBe('1')
  })

  it('subtract handles negatives', () => {
    expect(subtract('5', '8')).toBe('-3')
    expect(isNegative(subtract('5', '8'))).toBe(true)
    expect(isNegative(subtract('8', '5'))).toBe(false)
  })

  it('compare orders correctly', () => {
    expect(compare('6', '6')).toBe(0)
    expect(compare('5', '6')).toBe(-1)
    expect(compare('8', '6')).toBe(1)
  })

  it('clampNonNegative floors an over-drawn balance at zero, never returns a negative payout', () => {
    expect(clampNonNegative('-3')).toBe('0')
    expect(clampNonNegative('4')).toBe('4')
    expect(clampNonNegative('0')).toBe('0')
  })

  it('rejects malformed input rather than silently coercing', () => {
    expect(() => toScaled('not-a-number')).toThrow()
    expect(() => toScaled('1e10')).toThrow()
  })
})

describe('Decimal.mulFractionRound — pro-ration fractions, half-up rounding', () => {
  it('exact fractions (6/12 = 0.5) round-trip exactly', () => {
    expect(mulFractionRound('6', 6, 12)).toBe('3')
    expect(mulFractionRound('12', 12, 12)).toBe('12')
  })

  it('inexact fractions round half-up at the 4-decimal internal scale rather than truncating down', () => {
    // 6 * 1/12 = 0.5 exactly (sanity: exact case within an inexact family).
    expect(mulFractionRound('6', 1, 12)).toBe('0.5')
    // 30 * 1/12 = 2.5 exactly.
    expect(mulFractionRound('30', 1, 12)).toBe('2.5')
  })

  it('throws on a non-positive denominator rather than dividing by zero', () => {
    expect(() => mulFractionRound('6', 1, 0)).toThrow()
  })
})
