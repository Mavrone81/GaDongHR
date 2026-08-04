/**
 * Money in this service is `bigint` SATANG, end to end. Never `number`,
 * never a float, at any point between reading a figure from `svc-config`
 * and rendering it on a payslip.
 *
 * The reason is not stylistic. IEEE-754 doubles cannot represent 0.1
 * exactly; a payroll engine performs thousands of add/multiply/divide
 * operations per run, and the error accumulates. A one-satang drift on a
 * withholding-tax figure is a wrong PND 1 filing, and a one-satang drift on
 * a net-pay figure is an underpaid worker — both are the exact failures
 * this product exists to prevent. `no-float.test.ts` asserts, by scanning
 * source, that no float-producing construct appears anywhere in the
 * calculation path.
 *
 * TWO TYPES LIVE HERE
 *
 *  - `Satang` — an integer count of 1/100 baht, as `bigint`.
 *  - `Rate` — an EXACT rational `num/den`, never a decimal approximation.
 *    A statutory rate arrives from `svc-config` as a decimal string
 *    ("5", "0.25", "15"); `parsePercent` turns "0.25" into 25/10000 by
 *    counting the digits after the point, so the value is exact and stays
 *    exact through every multiplication.
 *
 * ROUNDING happens in exactly one function (`mulDivRoundHalfUp`) and
 * exactly one way: half-up, away from zero, at the satang. Every rate
 * application, every division by a period count, every pro-ration goes
 * through it, so there is one auditable rounding rule in the module rather
 * than one per call site. Truncation would systematically bias every
 * rounded figure downward, which for an employee deduction means
 * over-deducting and for an employer contribution means under-remitting.
 *
 * Whether Thai statute requires a coarser rounding unit than the satang for
 * SSO/EWF/withholding remittances is NOT stated in the statutory spec and
 * is listed as an open verification item in this module's report.
 */

/** An integer count of 1/100 baht. */
export type Satang = bigint

/** An exact rational. Constructed only by the parsers below — never by hand from a literal. */
export interface Rate {
  readonly num: bigint
  readonly den: bigint
}

const TEN = 10n
const HUNDRED = 100n
const TWO = 2n
const SATANG_PER_BAHT = 100n

const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/

function assertPlainDecimal(input: string, what: string): void {
  if (!DECIMAL_PATTERN.test(input.trim())) {
    throw new Error(`${what}: not a plain decimal numeric string: ${JSON.stringify(input)}`)
  }
}

/**
 * Splits a plain decimal string into its sign, integer digits and fraction
 * digits WITHOUT ever constructing a `number`. `"1234.5"` becomes
 * `{ negative: false, whole: '1234', frac: '5' }`.
 */
function splitDecimal(input: string): { negative: boolean; whole: string; frac: string } {
  const trimmed = input.trim()
  const negative = trimmed.startsWith('-')
  const unsigned = negative ? trimmed.slice(1) : trimmed
  const dot = unsigned.indexOf('.')
  if (dot === -1) return { negative, whole: unsigned, frac: '' }
  return { negative, whole: unsigned.slice(0, dot), frac: unsigned.slice(dot + 1) }
}

/**
 * A THB amount as written in configuration or on a form ("17500",
 * "1650.50") to satang. More than two fraction digits is rejected rather
 * than silently truncated: a config value of "0.005" baht is a data defect,
 * and silently reading it as 0 satang is how a rate ends up applied to the
 * wrong base with nothing to show for it.
 */
export function bahtToSatang(baht: string): Satang {
  assertPlainDecimal(baht, 'bahtToSatang')
  const { negative, whole, frac } = splitDecimal(baht)
  if (frac.length > 2) {
    throw new Error(`bahtToSatang: more than satang precision in ${JSON.stringify(baht)} — refusing to truncate a money figure`)
  }
  const padded = (frac + '00').slice(0, 2)
  const magnitude = BigInt(whole === '' ? '0' : whole) * SATANG_PER_BAHT + BigInt(padded)
  return negative ? -magnitude : magnitude
}

/** Inverse of `bahtToSatang` — a plain decimal string with exactly two fraction digits. Rendering only. */
export function satangToBaht(satang: Satang): string {
  const negative = satang < 0n
  const magnitude = negative ? -satang : satang
  const whole = magnitude / SATANG_PER_BAHT
  const rest = magnitude % SATANG_PER_BAHT
  return `${negative ? '-' : ''}${whole.toString()}.${rest.toString().padStart(2, '0')}`
}

/**
 * A percentage as written in the statutory config ("5", "0.25", "15") to an
 * EXACT rational. `"0.25"` has two fraction digits, so it becomes
 * 25 / (100 × 10²) = 25/10000 — exactly 0.25%, with no decimal
 * approximation anywhere.
 */
export function parsePercent(percent: string): Rate {
  assertPlainDecimal(percent, 'parsePercent')
  const { negative, whole, frac } = splitDecimal(percent)
  const digits = BigInt((whole === '' ? '0' : whole) + frac)
  const den = HUNDRED * TEN ** BigInt(frac.length)
  return { num: negative ? -digits : digits, den }
}

/**
 * A bare multiplier as written in the statutory config ("1.5", "2", "3" —
 * the LPA s.61/s.62/s.63 overtime multipliers) to an exact rational.
 * Same construction as `parsePercent` without the /100.
 */
export function parseMultiplier(multiplier: string): Rate {
  assertPlainDecimal(multiplier, 'parseMultiplier')
  const { negative, whole, frac } = splitDecimal(multiplier)
  const digits = BigInt((whole === '' ? '0' : whole) + frac)
  const den = TEN ** BigInt(frac.length)
  return { num: negative ? -digits : digits, den }
}

/**
 * `value * num / den`, rounded HALF-UP away from zero. THE one rounding
 * rule in this module — see the file header for why there is exactly one.
 */
export function mulDivRoundHalfUp(value: bigint, num: bigint, den: bigint): bigint {
  if (den === 0n) throw new Error('mulDivRoundHalfUp: denominator must not be zero')
  const negativeDen = den < 0n
  const d = negativeDen ? -den : den
  const scaled = negativeDen ? -(value * num) : value * num
  const negative = scaled < 0n
  const magnitude = negative ? -scaled : scaled
  const quotient = magnitude / d
  const remainder = magnitude % d
  const rounded = remainder * TWO >= d ? quotient + 1n : quotient
  return negative ? -rounded : rounded
}

/** Applies an exact `Rate` to a satang amount, rounded half-up to the satang. */
export function applyRate(amount: Satang, rate: Rate): Satang {
  return mulDivRoundHalfUp(amount, rate.num, rate.den)
}

/** `amount / divisor`, rounded half-up — used for per-period apportionment (annual tax ÷ remaining periods) and the OT hourly base. */
export function divideRoundHalfUp(amount: Satang, divisor: bigint): Satang {
  return mulDivRoundHalfUp(amount, 1n, divisor)
}

export function minSatang(a: Satang, b: Satang): Satang {
  return a < b ? a : b
}

export function maxSatang(a: Satang, b: Satang): Satang {
  return a > b ? a : b
}

/** `max(amount, 0)` — a statutory deduction never pays money back to the employee. */
export function clampNonNegative(amount: Satang): Satang {
  return amount < 0n ? 0n : amount
}

/** Clamps into `[floor, ceiling]`. Both bounds come from config; neither is ever a literal here. */
export function clampToBand(amount: Satang, floor: Satang, ceiling: Satang): Satang {
  if (floor > ceiling) {
    throw new Error(`clampToBand: floor ${floor.toString()} exceeds ceiling ${ceiling.toString()} — a statutory config defect, not a value to silently reorder`)
  }
  return minSatang(maxSatang(amount, floor), ceiling)
}

export function sumSatang(values: readonly Satang[]): Satang {
  let total = 0n
  for (const v of values) total += v
  return total
}
