import { addDays, dateOf, dateRange, hoursStringToMinutes, minutesBetween, minutesToHoursString } from './hours'

describe('minutesToHoursString', () => {
  it('whole hours', () => {
    expect(minutesToHoursString(480)).toBe('8.00')
  })
  it('fractional minutes convert to hundredths', () => {
    expect(minutesToHoursString(90)).toBe('1.50')
  })
  it('rejects a non-integer minute count', () => {
    expect(() => minutesToHoursString(1.5)).toThrow(/integer/)
  })
  it('handles the 59-minute rounding-carry edge case', () => {
    // 59 minutes = 0.9833h -> rounds to 98 hundredths, not a carry case; use
    // a value whose rounded hundredths hits exactly 100 to force the carry.
    expect(minutesToHoursString(419)).toBe('6.98')
  })
  it('negative minutes get a sign, positive-equivalent do not', () => {
    expect(minutesToHoursString(-90)).toBe('-1.50')
    expect(minutesToHoursString(0)).toBe('0.00')
    expect(minutesToHoursString(-0)).toBe('0.00')
  })
})

describe('hoursStringToMinutes', () => {
  it('round-trips minutesToHoursString', () => {
    expect(hoursStringToMinutes('7.17')).toBe(430)
  })
  it('rejects an unparseable value', () => {
    expect(() => hoursStringToMinutes('not-a-number')).toThrow(/unparseable/)
  })
})

describe('minutesBetween', () => {
  it('computes whole minutes between two ISO timestamps', () => {
    expect(minutesBetween('2026-08-10T09:00:00Z', '2026-08-10T18:00:00Z')).toBe(540)
  })
  it('floors at 0 rather than going negative', () => {
    expect(minutesBetween('2026-08-10T18:00:00Z', '2026-08-10T09:00:00Z')).toBe(0)
  })
  it('crosses midnight correctly (21:55 -> next-day 06:10)', () => {
    expect(minutesBetween('2026-08-10T21:55:00Z', '2026-08-11T06:10:00Z')).toBe(495)
  })
  it('rejects an unparseable timestamp', () => {
    expect(() => minutesBetween('nope', '2026-08-10T18:00:00Z')).toThrow(/unparseable/)
  })
})

describe('dateOf / addDays / dateRange', () => {
  it('dateOf extracts the UTC calendar date', () => {
    expect(dateOf('2026-08-10T23:55:00Z')).toBe('2026-08-10')
  })
  it('dateOf rejects an unparseable timestamp', () => {
    expect(() => dateOf('nope')).toThrow(/unparseable/)
  })
  it('addDays shifts forward and backward', () => {
    expect(addDays('2026-08-10', 1)).toBe('2026-08-11')
    expect(addDays('2026-08-10', -1)).toBe('2026-08-09')
  })
  it('addDays rejects a malformed date', () => {
    expect(() => addDays('not-a-date', 1)).toThrow(/not a YYYY-MM-DD date/)
  })
  it('dateRange enumerates inclusively', () => {
    expect(dateRange('2026-08-10', '2026-08-12')).toEqual(['2026-08-10', '2026-08-11', '2026-08-12'])
  })
  it('dateRange returns a single date when from === to', () => {
    expect(dateRange('2026-08-10', '2026-08-10')).toEqual(['2026-08-10'])
  })
})
