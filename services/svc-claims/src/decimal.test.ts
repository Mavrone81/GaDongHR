import { addDecimal, compareDecimal, isNegative, multiplyDecimal, parseDecimal, roundMoney } from './decimal'

describe('decimal.ts — no float ever touches a monetary value (Task 14 brief TESTS)', () => {
  it('addDecimal("0.1", "0.2") is exactly "0.3" — the classic float counter-example', () => {
    expect(addDecimal('0.1', '0.2')).toBe('0.3')
    // Demonstrates WHY this module exists: plain JS `Number` arithmetic
    // gets this wrong.
    expect(0.1 + 0.2).not.toBe(0.3)
  })

  it('addDecimal handles differing scales by promoting to the larger one', () => {
    expect(addDecimal('1999', '0.50')).toBe('1999.50')
  })

  it('addDecimal handles negative operands', () => {
    expect(addDecimal('-5.25', '10')).toBe('4.75')
    expect(addDecimal('5', '-10')).toBe('-5')
  })

  it('multiplyDecimal computes mileage exactly: 12.5 km x 4.25 THB/km = 53.125', () => {
    expect(multiplyDecimal('12.5', '4.25')).toBe('53.125')
  })

  it('multiplyDecimal of two whole numbers has no decimal point', () => {
    expect(multiplyDecimal('10', '4')).toBe('40')
  })

  it('roundMoney rounds half-up to 2dp by default', () => {
    expect(roundMoney('53.125')).toBe('53.13')
    expect(roundMoney('53.124')).toBe('53.12')
    expect(roundMoney('53.005')).toBe('53.01')
  })

  it('roundMoney is a no-op (padded) when already at or below the target scale', () => {
    expect(roundMoney('100')).toBe('100.00')
    expect(roundMoney('100.5')).toBe('100.50')
  })

  it('compareDecimal orders correctly across differing scales and signs', () => {
    expect(compareDecimal('1999.00', '2000')).toBe(-1)
    expect(compareDecimal('2000', '2000.00')).toBe(0)
    expect(compareDecimal('2000.01', '2000')).toBe(1)
    expect(compareDecimal('-1', '0')).toBe(-1)
  })

  it('isNegative reports sign correctly, and "-0" is not negative', () => {
    expect(isNegative('-5')).toBe(true)
    expect(isNegative('5')).toBe(false)
    expect(isNegative('-0.00')).toBe(false)
  })

  it('parseDecimal rejects non-decimal input rather than silently coercing to 0', () => {
    expect(() => parseDecimal('not-a-number')).toThrow()
    expect(() => parseDecimal('')).toThrow()
    expect(() => parseDecimal('1.2.3')).toThrow()
  })
})
