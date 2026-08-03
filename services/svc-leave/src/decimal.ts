/**
 * Fixed-point decimal arithmetic on numeric-string values, backed by
 * `bigint` — never `number`. `leave_balance.entitled/taken/carried_over`
 * and `leave_request.days`/`hours` are all Postgres `numeric` (see the
 * schema migrations' file-level comments); a balance is money the moment it
 * becomes a termination payout, so nothing in this service may compute a
 * balance through a JS `number`, which cannot represent 0.1 exactly and
 * accumulates rounding error across repeated add/subtract.
 *
 * `SCALE = 4` (four decimal places, i.e. values are stored internally as
 * `bigint` counts of 1/10000ths) is enough to represent every value this
 * engine ever produces exactly: half-days (0.5), eighth-days from hourly
 * leave against an 8-hour statutory workday (0.125), and month-based
 * pro-ration fractions (e.g. 6/12 = 0.5, 1/12 = 0.0833... which is NOT
 * exact at 4 decimal places and is therefore always produced through
 * `mulFractionRound`, which rounds explicitly rather than silently
 * truncating — see that function's doc).
 */

const SCALE = 4
const SCALE_FACTOR = 10n ** BigInt(SCALE)

export const ZERO = '0'

function assertFinite(input: string): void {
  if (!/^-?\d+(\.\d+)?$/.test(input.trim())) {
    throw new Error(`Decimal: not a plain decimal numeric string: ${JSON.stringify(input)}`)
  }
}

/** Parses a plain decimal string (no exponents, no thousands separators — the shape every `numeric` column round-trips as through `pg`) into a scaled `bigint`. */
export function toScaled(input: string): bigint {
  assertFinite(input)
  const trimmed = input.trim()
  const negative = trimmed.startsWith('-')
  const unsigned = negative ? trimmed.slice(1) : trimmed
  const [wholePart, fracPart = ''] = unsigned.split('.')
  const whole = wholePart === '' || wholePart === undefined ? '0' : wholePart
  const frac = (fracPart + '0'.repeat(SCALE)).slice(0, SCALE)
  const magnitude = BigInt(whole) * SCALE_FACTOR + BigInt(frac === '' ? '0' : frac)
  return negative ? -magnitude : magnitude
}

/** Renders a scaled `bigint` back to a plain decimal string, trimming trailing zero fractional digits (but never the decimal point away from a whole number's sign). */
export function fromScaled(scaled: bigint): string {
  const negative = scaled < 0n
  const magnitude = negative ? -scaled : scaled
  const whole = magnitude / SCALE_FACTOR
  const frac = magnitude % SCALE_FACTOR
  const fracStr = frac.toString().padStart(SCALE, '0').replace(/0+$/, '')
  const sign = negative && (whole !== 0n || frac !== 0n) ? '-' : ''
  return fracStr.length > 0 ? `${sign}${whole}.${fracStr}` : `${sign}${whole}`
}

export function add(a: string, b: string): string {
  return fromScaled(toScaled(a) + toScaled(b))
}

export function subtract(a: string, b: string): string {
  return fromScaled(toScaled(a) - toScaled(b))
}

export function compare(a: string, b: string): -1 | 0 | 1 {
  const diff = toScaled(a) - toScaled(b)
  if (diff < 0n) return -1
  if (diff > 0n) return 1
  return 0
}

export function isNegative(a: string): boolean {
  return toScaled(a) < 0n
}

/** `max(a, 0)` — how a payout/available-balance figure is floored: an over-drawn balance never pays out a negative amount. */
export function clampNonNegative(a: string): string {
  return compare(a, ZERO) < 0 ? ZERO : a
}

/**
 * `a * numerator / denominator`, rounded HALF-UP at the internal 4-decimal
 * scale — the one place this module performs a genuine division, because
 * pro-ration fractions (e.g. remaining-months / 12) are not always exact at
 * any finite decimal scale. Explicit, auditable rounding here (rather than
 * `bigint` truncation, which would silently round every fraction DOWN and
 * bias every pro-rated grant against the employee) is why this function
 * exists instead of a bare `toScaled(a) * BigInt(numerator) / BigInt(denominator)`.
 */
export function mulFractionRound(a: string, numerator: number, denominator: number): string {
  if (!Number.isInteger(numerator) || !Number.isInteger(denominator) || denominator <= 0) {
    throw new Error(`Decimal.mulFractionRound: numerator/denominator must be integers with denominator > 0, got ${numerator}/${denominator}`)
  }
  const scaled = toScaled(a) * BigInt(numerator)
  const den = BigInt(denominator)
  const negative = scaled < 0n
  const magnitude = negative ? -scaled : scaled
  const quotient = magnitude / den
  const remainder = magnitude % den
  // Half-up: remainder*2 >= denominator rounds away from zero.
  const rounded = remainder * 2n >= den ? quotient + 1n : quotient
  return fromScaled(negative ? -rounded : rounded)
}
