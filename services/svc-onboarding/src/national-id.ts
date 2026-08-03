/**
 * Thai national ID (13-digit) checksum, per the Bureau of Registration
 * Administration's published algorithm — the same one every Thai
 * government/bank form validates against. This is a REAL checksum, not a
 * length check (M1-1 acceptance criterion, task brief): the first 12 digits
 * are each weighted by `(13 - index)` (0-indexed from the left), summed, and
 * the 13th digit must equal `(11 - (sum mod 11)) mod 10`.
 *
 * `ONB-001` (invalid checksum) is the caller's concern (`employee.service.ts`)
 * — this module only answers the yes/no question.
 */
export function isValidThaiNationalId(id: string): boolean {
  if (!/^\d{13}$/.test(id)) return false

  const digits = id.split('').map(Number)
  let sum = 0
  for (let i = 0; i < 12; i++) {
    // Safe: `digits` has exactly 13 elements (checked above) and `i < 12`.
    sum += digits[i]! * (13 - i)
  }
  const checkDigit = (11 - (sum % 11)) % 10
  return checkDigit === digits[12]
}
