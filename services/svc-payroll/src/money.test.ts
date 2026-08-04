import {
  applyRate,
  bahtToSatang,
  clampNonNegative,
  clampToBand,
  divideRoundHalfUp,
  maxSatang,
  minSatang,
  mulDivRoundHalfUp,
  parseMultiplier,
  parsePercent,
  satangToBaht,
  sumSatang,
} from './money'

describe('money — bigint satang, never a float', () => {
  it('parses a THB decimal string exactly, with no intermediate number', () => {
    expect(bahtToSatang('17500')).toBe(1_750_000n)
    expect(bahtToSatang('1650.50')).toBe(165_050n)
    expect(bahtToSatang('0.01')).toBe(1n)
    expect(bahtToSatang('-45.25')).toBe(-4_525n)
  })

  it('round-trips through satangToBaht', () => {
    for (const value of ['0.00', '0.01', '17500.00', '1650.50', '-45.25', '999999999.99']) {
      expect(satangToBaht(bahtToSatang(value))).toBe(value)
    }
  })

  it('represents 0.1 + 0.2 exactly — the arithmetic a double gets wrong', () => {
    // 0.1 + 0.2 === 0.30000000000000004 in IEEE-754. In satang it is 30.
    expect(bahtToSatang('0.10') + bahtToSatang('0.20')).toBe(30n)
    expect(satangToBaht(bahtToSatang('0.10') + bahtToSatang('0.20'))).toBe('0.30')
  })

  it('accumulates 1,000 additions of 0.01 THB to exactly 10.00, with no drift', () => {
    let total = 0n
    for (let i = 0; i < 1000; i++) total += bahtToSatang('0.01')
    expect(satangToBaht(total)).toBe('10.00')
  })

  it('REFUSES sub-satang precision rather than truncating a money figure', () => {
    expect(() => bahtToSatang('0.005')).toThrow(/satang precision/)
  })

  it('rejects anything that is not a plain decimal — no exponents, no separators', () => {
    for (const bad of ['1e3', '1,000', 'abc', '', ' ', '1.2.3']) {
      expect(() => bahtToSatang(bad)).toThrow()
    }
  })
})

describe('money — exact rational rates', () => {
  it('parses a percentage into an exact rational, scaled by its own decimal places', () => {
    expect(parsePercent('5')).toEqual({ num: 5n, den: 100n })
    // 0.25% is 25/10000 exactly — the EWF rate, and the one most likely to
    // be mangled by a decimal approximation.
    expect(parsePercent('0.25')).toEqual({ num: 25n, den: 10_000n })
    expect(parsePercent('0.50')).toEqual({ num: 50n, den: 10_000n })
    expect(parsePercent('15')).toEqual({ num: 15n, den: 100n })
  })

  it('parses an overtime multiplier the same way, without the /100', () => {
    expect(parseMultiplier('1.5')).toEqual({ num: 15n, den: 10n })
    expect(parseMultiplier('2')).toEqual({ num: 2n, den: 1n })
    expect(parseMultiplier('3')).toEqual({ num: 3n, den: 1n })
  })

  it('applies a rate exactly: 5% of the 17,500 ceiling is 875.00, the figure the Statutory Spec names', () => {
    expect(satangToBaht(applyRate(bahtToSatang('17500'), parsePercent('5')))).toBe('875.00')
  })

  it('applies 0.25% of the same ceiling to 43.75', () => {
    expect(satangToBaht(applyRate(bahtToSatang('17500'), parsePercent('0.25')))).toBe('43.75')
  })

  it('handles a negative rate sign without losing it', () => {
    expect(parsePercent('-5')).toEqual({ num: -5n, den: 100n })
  })
})

describe('money — one rounding rule: half-up, away from zero', () => {
  it('rounds a half up rather than to even or down', () => {
    expect(mulDivRoundHalfUp(5n, 1n, 2n)).toBe(3n)
    expect(mulDivRoundHalfUp(7n, 1n, 2n)).toBe(4n)
    expect(mulDivRoundHalfUp(1n, 1n, 3n)).toBe(0n)
    expect(mulDivRoundHalfUp(2n, 1n, 3n)).toBe(1n)
  })

  it('rounds AWAY from zero for negatives, so a deduction is not quietly under-applied', () => {
    expect(mulDivRoundHalfUp(-5n, 1n, 2n)).toBe(-3n)
    expect(mulDivRoundHalfUp(-1n, 1n, 3n)).toBe(0n)
  })

  it('handles a negative denominator by moving the sign, not by silently succeeding wrongly', () => {
    expect(mulDivRoundHalfUp(10n, 1n, -2n)).toBe(-5n)
  })

  it('refuses a zero denominator', () => {
    expect(() => mulDivRoundHalfUp(1n, 1n, 0n)).toThrow(/denominator/)
  })

  it('divideRoundHalfUp spreads an annual liability across periods', () => {
    // 1,000.01 THB over 3 periods = 33,333.67 satang -> 33,334 satang.
    expect(divideRoundHalfUp(100_001n, 3n)).toBe(33_334n)
  })
})

describe('money — clamps and sums', () => {
  it('clampToBand applies the floor and the ceiling', () => {
    const floor = bahtToSatang('1650')
    const ceiling = bahtToSatang('17500')
    expect(clampToBand(bahtToSatang('1000'), floor, ceiling)).toBe(floor)
    expect(clampToBand(bahtToSatang('10000'), floor, ceiling)).toBe(bahtToSatang('10000'))
    expect(clampToBand(bahtToSatang('40000'), floor, ceiling)).toBe(ceiling)
    expect(clampToBand(ceiling, floor, ceiling)).toBe(ceiling)
  })

  it('clampToBand refuses an inverted band rather than silently reordering it — that is a config defect', () => {
    expect(() => clampToBand(0n, 100n, 10n)).toThrow(/exceeds ceiling/)
  })

  it('clampNonNegative floors at zero', () => {
    expect(clampNonNegative(-1n)).toBe(0n)
    expect(clampNonNegative(0n)).toBe(0n)
    expect(clampNonNegative(1n)).toBe(1n)
  })

  it('min/max/sum', () => {
    expect(minSatang(1n, 2n)).toBe(1n)
    expect(maxSatang(1n, 2n)).toBe(2n)
    expect(sumSatang([1n, 2n, 3n])).toBe(6n)
    expect(sumSatang([])).toBe(0n)
  })
})
