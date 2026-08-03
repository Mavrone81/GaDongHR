import { addDays, diffDays, isDayOfWeek, isoWeekRange, nextDay } from './week'

describe('isoWeekRange', () => {
  it('a Wednesday resolves to that week\'s Monday..Sunday', () => {
    // 2026-08-05 is a Wednesday.
    expect(isoWeekRange('2026-08-05')).toEqual({ from: '2026-08-03', to: '2026-08-09' })
  })

  it('a Sunday resolves to itself as the end of its own week', () => {
    expect(isoWeekRange('2026-08-09')).toEqual({ from: '2026-08-03', to: '2026-08-09' })
  })

  it('a Monday resolves to itself as the start of its own week', () => {
    expect(isoWeekRange('2026-08-03')).toEqual({ from: '2026-08-03', to: '2026-08-09' })
  })

  it('handles a week spanning a month boundary', () => {
    // 2026-08-01 is a Saturday, week starts 2026-07-27.
    expect(isoWeekRange('2026-08-01')).toEqual({ from: '2026-07-27', to: '2026-08-02' })
  })
})

describe('isDayOfWeek / nextDay', () => {
  it('identifies a Sunday', () => {
    expect(isDayOfWeek('2026-08-09', 0)).toBe(true)
    expect(isDayOfWeek('2026-08-08', 0)).toBe(false)
  })

  it('advances one calendar day, including across a month boundary', () => {
    expect(nextDay('2026-08-09')).toBe('2026-08-10')
    expect(nextDay('2026-07-31')).toBe('2026-08-01')
  })
})

describe('addDays / diffDays', () => {
  it('shifts forward and backward across a month boundary', () => {
    expect(addDays('2026-08-01', 7)).toBe('2026-08-08')
    expect(addDays('2026-08-01', -1)).toBe('2026-07-31')
  })

  it('computes the day difference symmetrically', () => {
    expect(diffDays('2026-08-01', '2026-08-08')).toBe(7)
    expect(diffDays('2026-08-08', '2026-08-01')).toBe(-7)
    expect(diffDays('2026-08-01', '2026-08-01')).toBe(0)
  })
})
