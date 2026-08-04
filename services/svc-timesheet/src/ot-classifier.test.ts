import { GadongError } from '@gadong/kernel'
import { classifyOt, classifyOtHours, hourlyBase } from './ot-classifier'
import type { EmploymentType, OtClassifierInput } from './ot-classifier'

const REGULAR_8H = 8 * 60

function input(overrides: Partial<OtClassifierInput> = {}): OtClassifierInput {
  return {
    workedMinutes: REGULAR_8H,
    regularThresholdMinutes: REGULAR_8H,
    isHoliday: false,
    employmentType: 'monthly',
    approvedOtMinutes: 0,
    ...overrides,
  }
}

describe('classifyOt — workday (non-holiday) branch', () => {
  it('worked exactly the regular threshold: no OT, no exception (TC-M3-001-ish)', () => {
    const result = classifyOt(input({ workedMinutes: REGULAR_8H }))
    expect(result).toEqual({ ot15xMinutes: 0, ot2xMinutes: 0, ot3xMinutes: 0, unapprovedOtMinutes: 0 })
  })

  it('2h approved workday OT worked → ot_15x = 2h, nothing unapproved (TC-M3-006)', () => {
    const result = classifyOt(
      input({ workedMinutes: REGULAR_8H + 120, approvedOtMinutes: 120 }),
    )
    expect(result.ot15xMinutes).toBe(120)
    expect(result.ot2xMinutes).toBe(0)
    expect(result.ot3xMinutes).toBe(0)
    expect(result.unapprovedOtMinutes).toBe(0)
  })

  it('worked 2h OT with NO approval → ot_15x stays 0 (never silently paid); unapproved carries the full 2h (never silently dropped) (TC-M3-008)', () => {
    const result = classifyOt(input({ workedMinutes: REGULAR_8H + 120, approvedOtMinutes: 0 }))
    expect(result.ot15xMinutes).toBe(0)
    expect(result.unapprovedOtMinutes).toBe(120)
  })

  it('worked 2h OT with PARTIAL approval (1h approved) → 1h paid at 1.5x, 1h unapproved', () => {
    const result = classifyOt(input({ workedMinutes: REGULAR_8H + 120, approvedOtMinutes: 60 }))
    expect(result.ot15xMinutes).toBe(60)
    expect(result.unapprovedOtMinutes).toBe(60)
  })

  it('over-approved (approved more than actually worked) → paid caps at what was actually worked, never negative unapproved', () => {
    const result = classifyOt(input({ workedMinutes: REGULAR_8H + 60, approvedOtMinutes: 180 }))
    expect(result.ot15xMinutes).toBe(60)
    expect(result.unapprovedOtMinutes).toBe(0)
  })

  it('worked LESS than the regular threshold (e.g. half day) → no OT of any class, no negative figures', () => {
    const result = classifyOt(input({ workedMinutes: 120 }))
    expect(result).toEqual({ ot15xMinutes: 0, ot2xMinutes: 0, ot3xMinutes: 0, unapprovedOtMinutes: 0 })
  })

  it('zero worked minutes (absence/leave day) → every bucket zero', () => {
    const result = classifyOt(input({ workedMinutes: 0 }))
    expect(result).toEqual({ ot15xMinutes: 0, ot2xMinutes: 0, ot3xMinutes: 0, unapprovedOtMinutes: 0 })
  })
})

describe('classifyOt — holiday branch, monthly (paid-holiday-entitled) staff → +1x additional, encoded as half of ot_2x (TC-M3-007 monthly half)', () => {
  it('8h worked on a holiday, no OT beyond that: ot_2x = 4h (half of 8h, so ot_2x × 2 = 1x additional), ot_15x/ot_3x = 0', () => {
    const result = classifyOt(input({ isHoliday: true, employmentType: 'monthly', workedMinutes: REGULAR_8H }))
    expect(result.ot2xMinutes).toBe(REGULAR_8H / 2)
    expect(result.ot15xMinutes).toBe(0)
    expect(result.ot3xMinutes).toBe(0)
  })

  it('8h holiday work + 2h approved holiday OT → ot_2x = 4h (+1x for the regular 8h) AND ot_3x = 2h (3x for the OT beyond) — both columns populated independently (TC-M3-007)', () => {
    const result = classifyOt(
      input({ isHoliday: true, employmentType: 'monthly', workedMinutes: REGULAR_8H + 120, approvedOtMinutes: 120 }),
    )
    expect(result.ot2xMinutes).toBe(REGULAR_8H / 2)
    expect(result.ot3xMinutes).toBe(120)
    expect(result.ot15xMinutes).toBe(0)
    expect(result.unapprovedOtMinutes).toBe(0)
  })

  it('holiday OT worked without approval is still flagged, exactly as on a workday — the approval gate applies to the OT pool regardless of holiday status', () => {
    const result = classifyOt(
      input({ isHoliday: true, employmentType: 'monthly', workedMinutes: REGULAR_8H + 120, approvedOtMinutes: 0 }),
    )
    expect(result.ot3xMinutes).toBe(0)
    expect(result.unapprovedOtMinutes).toBe(120)
    // The regular 8h holiday-work premium is still paid — LPA s.62 is not consent-gated.
    expect(result.ot2xMinutes).toBe(REGULAR_8H / 2)
  })
})

describe('classifyOt — holiday branch, daily/hourly/contract (NOT paid-holiday-entitled) staff → full 2x (TC-M3-007 daily-rate variant)', () => {
  it.each<EmploymentType>(['daily', 'hourly', 'contract'])(
    '8h worked on a holiday, employmentType=%s → ot_2x = 8h (full 2x, no entitlement discount)',
    (employmentType) => {
      const result = classifyOt(input({ isHoliday: true, employmentType, workedMinutes: REGULAR_8H }))
      expect(result.ot2xMinutes).toBe(REGULAR_8H)
      expect(result.ot15xMinutes).toBe(0)
      expect(result.ot3xMinutes).toBe(0)
    },
  )

  it('daily-rate: 8h holiday work + 2h approved holiday OT → ot_2x = 8h, ot_3x = 2h', () => {
    const result = classifyOt(
      input({ isHoliday: true, employmentType: 'daily', workedMinutes: REGULAR_8H + 120, approvedOtMinutes: 120 }),
    )
    expect(result.ot2xMinutes).toBe(REGULAR_8H)
    expect(result.ot3xMinutes).toBe(120)
  })
})

describe('classifyOt — input validation branches', () => {
  it('rejects negative workedMinutes', () => {
    expect(() => classifyOt(input({ workedMinutes: -1 }))).toThrow(/workedMinutes/)
  })

  it('rejects negative regularThresholdMinutes', () => {
    expect(() => classifyOt(input({ regularThresholdMinutes: -1 }))).toThrow(/regularThresholdMinutes/)
  })

  it('rejects negative approvedOtMinutes', () => {
    expect(() => classifyOt(input({ approvedOtMinutes: -1 }))).toThrow(/approvedOtMinutes/)
  })
})

describe('classifyOtHours — numeric-string conversion, exact fractional totals (not rounded away)', () => {
  it('converts a half-hour holiday-work bucket to an exact "4.00", not "4"', () => {
    const result = classifyOtHours(input({ isHoliday: true, employmentType: 'monthly', workedMinutes: REGULAR_8H }))
    expect(result.ot2x).toBe('4.00')
    expect(result.ot15x).toBe('0.00')
    expect(result.ot3x).toBe('0.00')
  })

  it('a genuinely fractional total (7h10m worked OT, all approved) round-trips exactly as "7.17" (7h10m = 7.1666..h, rounded to the nearest hundredth, never truncated to 7.00)', () => {
    // 7h10m = 430 minutes of OT.
    const result = classifyOtHours(input({ workedMinutes: REGULAR_8H + 430, approvedOtMinutes: 430 }))
    expect(result.ot15x).toBe('7.17')
  })

  it('unapprovedOtHours reflects the exact unapproved figure, not zero and not the paid figure', () => {
    const result = classifyOtHours(input({ workedMinutes: REGULAR_8H + 90, approvedOtMinutes: 30 }))
    expect(result.ot15x).toBe('0.50')
    expect(result.unapprovedOtHours).toBe('1.00')
  })
})

describe('hourlyBase — monthly ÷ divisor, floor-validated against a statutory divisor sourced from config (never hard-coded)', () => {
  it('default divisor (30 × 8 = 240) produces the textbook monthly ÷ 30 ÷ 8 figure', () => {
    expect(hourlyBase(24_000, 240, 240, 'LPA s.61')).toBeCloseTo(100)
  })

  it('a SMALLER custom divisor (e.g. 26 × 8 = 208) is more generous and is accepted', () => {
    expect(hourlyBase(24_000, 208, 240, 'LPA s.61')).toBeCloseTo(24_000 / 208)
  })

  it('a LARGER custom divisor (underpays relative to the statutory formula) is rejected with TSH-040, citation attached', () => {
    expect(() => hourlyBase(24_000, 248, 240, 'LPA s.61')).toThrow(GadongError)
    try {
      hourlyBase(24_000, 248, 240, 'LPA s.61')
      throw new Error('unreachable')
    } catch (err) {
      expect(err).toBeInstanceOf(GadongError)
      const gadongErr = err as GadongError
      expect(gadongErr.code).toBe('TSH-040')
      expect(gadongErr.details).toEqual([{ divisor: 248, statutoryDivisor: 240, citation: 'LPA s.61' }])
    }
  })

  it('behaviour moves with config: the SAME divisor (240) is rejected once the statutory ceiling itself is configured lower (208), proving nothing here is hard-coded', () => {
    expect(() => hourlyBase(24_000, 240, 208, 'LPA s.61')).toThrow(GadongError)
    expect(hourlyBase(24_000, 200, 208, 'LPA s.61')).toBeCloseTo(24_000 / 200)
  })
})
