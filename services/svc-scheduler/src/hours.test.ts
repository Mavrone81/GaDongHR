import { hoursStringToMinutes, minutesToHoursString, paidDurationMinutes, rawSpanMinutes } from './hours'

describe('rawSpanMinutes — the midnight-crossing case', () => {
  it('computes a same-day shift normally (09:00-17:00 = 8h = 480 min)', () => {
    expect(rawSpanMinutes({ startT: '09:00', endT: '17:00', crossesMidnight: false })).toBe(480)
  })

  it('computes a night shift crossing midnight (22:00-06:00 = 8h = 480 min) — explicit boundary assertion', () => {
    // 22:00 -> 24:00 is 120 minutes, 00:00 -> 06:00 is 360 minutes: 120 + 360 = 480.
    const minutes = rawSpanMinutes({ startT: '22:00', endT: '06:00', crossesMidnight: true })
    expect(minutes).toBe(480)
    expect(minutesToHoursString(minutes)).toBe('8.00')
  })

  it('computes the exact midnight boundary itself (23:00-00:00 crossing = 1h = 60 min)', () => {
    expect(rawSpanMinutes({ startT: '23:00', endT: '00:00', crossesMidnight: true })).toBe(60)
  })

  it('computes a shift that starts exactly at midnight and crosses into the next day (00:00-00:30 crossing = 24h30m)', () => {
    // start=00:00 end=00:30, crossesMidnight true: 24*60 - 0 + 30 = 1470 minutes.
    expect(rawSpanMinutes({ startT: '00:00', endT: '00:30', crossesMidnight: true })).toBe(1470)
  })

  it('rejects a same-day shift whose end is not after its start when crossesMidnight is false — a data error, not silently treated as crossing', () => {
    expect(() => rawSpanMinutes({ startT: '17:00', endT: '09:00', crossesMidnight: false })).toThrow(
      /crossesMidnight is false/,
    )
  })
})

describe('paidDurationMinutes — breaks subtracted, floored at zero', () => {
  it('subtracts break minutes from a midnight-crossing shift', () => {
    // 22:00-06:00 (480 min) minus a 60-minute break = 420 min = 7.00h.
    const minutes = paidDurationMinutes({ startT: '22:00', endT: '06:00', crossesMidnight: true, breakMinutes: 60 })
    expect(minutes).toBe(420)
    expect(minutesToHoursString(minutes)).toBe('7.00')
  })

  it('never goes negative even if breaks exceed the raw span', () => {
    const minutes = paidDurationMinutes({ startT: '09:00', endT: '09:30', crossesMidnight: false, breakMinutes: 999 })
    expect(minutes).toBe(0)
  })
})

describe('minutesToHoursString / hoursStringToMinutes — exact round-trip, no float accumulation', () => {
  it.each([
    [480, '8.00'],
    [450, '7.50'],
    [470, '7.83'], // 470/60 = 7.8333... -> rounds to 7.83
    [0, '0.00'],
  ])('%i minutes -> %s', (minutes, expected) => {
    expect(minutesToHoursString(minutes)).toBe(expected)
  })

  it('round-trips through a numeric-string value the same way pg would return it', () => {
    expect(hoursStringToMinutes('7.50')).toBe(450)
    expect(hoursStringToMinutes(minutesToHoursString(505))).toBe(505)
  })

  it('rejects a non-integer minute count — this module never converts a partially-accumulated float', () => {
    expect(() => minutesToHoursString(7.5)).toThrow(/integer minute count/)
  })
})
