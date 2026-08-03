import { isValidThaiNationalId } from './national-id'

describe('isValidThaiNationalId — real 13-digit checksum, not a length check', () => {
  it.each(['1101700230708', '3109900764416', '1902970000199', '1001990000124', '9999999999994'])(
    'accepts a valid Thai national ID: %s',
    (id) => {
      expect(isValidThaiNationalId(id)).toBe(true)
    },
  )

  it('rejects a 13-digit string with a wrong check digit (ONB-001 territory)', () => {
    // Same first 12 digits as a known-valid ID above, check digit flipped.
    expect(isValidThaiNationalId('1101700230701')).toBe(false)
  })

  it('rejects a string that is 13 digits long but not a real ID (all zeros)', () => {
    // A pure length check would accept this; the real checksum does not
    // (0 * weight summed = 0, check digit = (11-0)%10 = 1, not 0).
    expect(isValidThaiNationalId('0000000000000')).toBe(false)
  })

  it('rejects too short (12 digits)', () => {
    expect(isValidThaiNationalId('110170023070')).toBe(false)
  })

  it('rejects too long (14 digits)', () => {
    expect(isValidThaiNationalId('11017002307080')).toBe(false)
  })

  it('rejects non-digit characters', () => {
    expect(isValidThaiNationalId('110170023070a')).toBe(false)
  })

  it('rejects an empty string', () => {
    expect(isValidThaiNationalId('')).toBe(false)
  })

  it('rejects a string with a leading/trailing space (must be exactly 13 digits, no trimming)', () => {
    expect(isValidThaiNationalId(' 1101700230708')).toBe(false)
    expect(isValidThaiNationalId('1101700230708 ')).toBe(false)
  })
})
