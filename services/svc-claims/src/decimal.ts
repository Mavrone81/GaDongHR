/**
 * Fixed-point decimal arithmetic over STRINGS — the one module in this
 * service allowed to touch a monetary/amount value's digits directly.
 * Every other file that combines, compares, or rounds `amount_thb`,
 * `vat_amount`, `mileage_km` or a `mileage_rate` goes through here. Nothing
 * here ever calls `Number(...)`/`parseFloat(...)` on a decimal string —
 * every operation is BigInt-based, so a float rounding error (Task 14
 * brief: "this figure becomes a reimbursement line ... a rounding error is
 * a payroll error and a wrong SSO filing") cannot creep in. See
 * `decimal.test.ts` for the demonstration that this matters (`0.1 + 0.2`
 * under `Number` is not `0.3`; under `addDecimal` it is, exactly).
 */

interface ParsedDecimal {
  negative: boolean
  /** Unsigned digits with the decimal point removed, e.g. "1999.50" (scale 2) -> 199950n. */
  digits: bigint
  scale: number
}

const DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/

/** Parses a plain decimal string (no exponent notation — Postgres `numeric` never emits one for values in this service's range) into its unsigned-digits/scale form. Throws on anything that is not a valid decimal literal, including empty string and `NaN`-shaped input — a malformed amount must fail loudly, never silently coerce to 0. */
export function parseDecimal(input: string): ParsedDecimal {
  const trimmed = input.trim()
  if (!DECIMAL_PATTERN.test(trimmed)) {
    throw new Error(`decimal.ts: not a valid decimal string: ${JSON.stringify(input)}`)
  }
  const negative = trimmed.startsWith('-')
  const unsigned = negative ? trimmed.slice(1) : trimmed
  const dotIndex = unsigned.indexOf('.')
  const intPart = dotIndex === -1 ? unsigned : unsigned.slice(0, dotIndex)
  const fracPart = dotIndex === -1 ? '' : unsigned.slice(dotIndex + 1)
  const digits = BigInt((intPart.length > 0 ? intPart : '0') + fracPart)
  // "-0" / "-0.00" is not a negative value.
  return { negative: negative && digits !== 0n, digits, scale: fracPart.length }
}

function rescale(d: ParsedDecimal, scale: number): bigint {
  if (scale < d.scale) throw new Error(`decimal.ts: rescale would drop precision (${d.scale} -> ${scale})`)
  return d.digits * 10n ** BigInt(scale - d.scale)
}

function signedValue(d: ParsedDecimal, scale: number): bigint {
  return (d.negative ? -1n : 1n) * rescale(d, scale)
}

function formatSigned(value: bigint, scale: number): string {
  const negative = value < 0n
  const abs = negative ? -value : value
  const digits = abs.toString().padStart(scale + 1, '0')
  const intPart = digits.slice(0, digits.length - scale) || '0'
  const fracPart = scale > 0 ? digits.slice(digits.length - scale) : ''
  const body = fracPart.length > 0 ? `${intPart}.${fracPart}` : intPart
  return negative && abs !== 0n ? `-${body}` : body
}

/** -1 / 0 / 1, comparing two decimal strings exactly (BigInt, common scale) — never a float subtraction. */
export function compareDecimal(a: string, b: string): -1 | 0 | 1 {
  const da = parseDecimal(a)
  const db = parseDecimal(b)
  const scale = Math.max(da.scale, db.scale)
  const av = signedValue(da, scale)
  const bv = signedValue(db, scale)
  if (av < bv) return -1
  if (av > bv) return 1
  return 0
}

export function addDecimal(a: string, b: string): string {
  const da = parseDecimal(a)
  const db = parseDecimal(b)
  const scale = Math.max(da.scale, db.scale)
  return formatSigned(signedValue(da, scale) + signedValue(db, scale), scale)
}

/** Exact product at combined scale (no rounding) — e.g. multiplying a 3dp distance by a 2dp rate yields a 5dp result. Callers that need a money-shaped (2dp) result call `roundMoney` on the output. */
export function multiplyDecimal(a: string, b: string): string {
  const da = parseDecimal(a)
  const db = parseDecimal(b)
  const av = (da.negative ? -1n : 1n) * da.digits
  const bv = (db.negative ? -1n : 1n) * db.digits
  return formatSigned(av * bv, da.scale + db.scale)
}

/** Half-up rounding to `scale` decimal places (default 2, THB's satang precision) — the one place this module rounds anything, and only ever explicitly, never as a side effect of another operation. */
export function roundMoney(value: string, scale = 2): string {
  const d = parseDecimal(value)
  if (d.scale <= scale) return formatSigned(signedValue(d, scale), scale)
  const factor = 10n ** BigInt(d.scale - scale)
  const truncated = d.digits / factor
  const remainder = d.digits % factor
  const roundedAbs = remainder * 2n >= factor ? truncated + 1n : truncated
  return formatSigned((d.negative ? -1n : 1n) * roundedAbs, scale)
}

export function isNegative(value: string): boolean {
  return parseDecimal(value).negative
}
