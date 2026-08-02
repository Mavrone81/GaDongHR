import { toBuddhistEra, formatDate, formatTHB } from './format'

describe('toBuddhistEra', () => {
  it('adds 543 to the Gregorian year (พ.ศ. = C.E. + 543)', () => {
    expect(toBuddhistEra('2026-08-02')).toBe(2569)
  })

  it('rejects a string that is not an ISO date', () => {
    expect(() => toBuddhistEra('not-a-date')).toThrow()
  })
})

describe('formatDate', () => {
  it('renders the Buddhist Era year for th locale', () => {
    expect(formatDate('2026-08-02', 'th')).toContain('2569')
    expect(formatDate('2026-08-02', 'th')).not.toContain('2026')
  })

  it('renders the Gregorian year for en locale', () => {
    expect(formatDate('2026-08-02', 'en')).toContain('2026')
    expect(formatDate('2026-08-02', 'en')).not.toContain('2569')
  })

  it('renders the Gregorian year for zh locale', () => {
    expect(formatDate('2026-08-02', 'zh')).toContain('2026')
    expect(formatDate('2026-08-02', 'zh')).not.toContain('2569')
  })
})

describe('formatTHB', () => {
  it('renders satang as baht with two decimal places and thousands separators', () => {
    expect(formatTHB(2298675n, 'th')).toBe('฿22,986.75')
  })

  it('never rounds — one satang and ninety-nine satang both survive exactly', () => {
    expect(formatTHB(1n, 'en')).toBe('฿0.01')
    expect(formatTHB(99n, 'en')).toBe('฿0.99')
    expect(formatTHB(100n, 'en')).toBe('฿1.00')
  })

  it('handles amounts far beyond Number.MAX_SAFE_INTEGER satang without precision loss', () => {
    // 9007199254740993n is MAX_SAFE_INTEGER + 2 — a value that a float-based
    // implementation cannot represent exactly. bigint must carry it exactly.
    expect(formatTHB(900719925474099300n, 'th')).toBe('฿9,007,199,254,740,993.00')
  })
})
