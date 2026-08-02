/**
 * Buddhist Era offset: พ.ศ. = C.E. + 543. This is a rendering-only concern —
 * every date in every table is stored ISO-8601 Gregorian UTC (roadmap
 * "Internationalisation"), never B.E. This module is the one place that
 * offset is allowed to appear.
 */
const BE_OFFSET = 543

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})/

function parseIsoDate(iso: string): { year: number; month: string; day: string } {
  const match = ISO_DATE_PATTERN.exec(iso)
  if (!match) {
    throw new Error(`not a valid ISO-8601 date: ${JSON.stringify(iso)}`)
  }
  // The regex has exactly 3 capture groups and `match` only reaches here
  // when `.exec` succeeded, so groups 1-3 are guaranteed present —
  // `noUncheckedIndexedAccess` still types them as possibly-undefined.
  const yearStr = match[1] ?? ''
  const month = match[2] ?? ''
  const day = match[3] ?? ''
  return { year: Number(yearStr), month, day }
}

/** `toBuddhistEra('2026-08-02')` is `2569`. Never store the result — render only. */
export function toBuddhistEra(iso: string): number {
  return parseIsoDate(iso).year + BE_OFFSET
}

export type Locale = 'th' | 'en' | 'zh'

/**
 * Thai locale renders the Buddhist Era year; `en` and `zh` render the stored
 * Gregorian year unchanged. The underlying value is never mutated — this
 * function only chooses which year number to print.
 */
export function formatDate(iso: string, locale: Locale): string {
  const { year, month, day } = parseIsoDate(iso)
  const renderedYear = locale === 'th' ? year + BE_OFFSET : year
  return `${day}/${month}/${renderedYear}`
}

const SATANG_PER_BAHT = 100n
const THOUSANDS_SEPARATOR_PATTERN = /\B(?=(\d{3})+(?!\d))/g

/**
 * Money is `bigint` satang end to end — no `number`, no float, anywhere near
 * a payroll figure. Rounding is a render-only concern and happens here, at
 * the very last step (splitting into whole baht + 2-digit satang remainder),
 * never inside the engine that produced the amount. `locale` is accepted for
 * interface symmetry with `formatDate` and future localisation (digit
 * grouping conventions differ by locale); today it does not vary output —
 * the Baht sign and Arabic-numeral grouping are used regardless of locale.
 */
export function formatTHB(satang: bigint, locale: Locale): string {
  void locale
  const negative = satang < 0n
  const absSatang = negative ? -satang : satang
  const baht = absSatang / SATANG_PER_BAHT
  const remainder = absSatang % SATANG_PER_BAHT

  const grouped = baht.toString().replace(THOUSANDS_SEPARATOR_PATTERN, ',')
  const satangDigits = remainder.toString().padStart(2, '0')
  const sign = negative ? '-' : ''
  return `${sign}฿${grouped}.${satangDigits}`
}
