export interface EffectiveRecord {
  effectiveFrom: string      // ISO date, INCLUSIVE
  effectiveTo: string | null // ISO date, INCLUSIVE; null = open-ended
}

/**
 * Resolves which version of an effective-dated record applies on a date.
 *
 * Both bounds are INCLUSIVE. The Statutory Spec writes closed ranges
 * ("15,000 until 2025-12-31, 17,500 from 2026-01-01"); an exclusive upper
 * bound would drop the last day of every window — one wrong payslip a year,
 * which is exactly the class of defect this product exists to prevent.
 *
 * Comparison is lexicographic on YYYY-MM-DD, which is ordering-correct and
 * keeps timezones out of a question that has none.
 */
export function resolveEffective<T extends EffectiveRecord>(records: T[], on: string): T | null {
  const matches = records.filter(
    (r) => r.effectiveFrom <= on && (r.effectiveTo === null || on <= r.effectiveTo),
  )
  if (matches.length === 0) return null
  // Overlapping windows are a data defect the governance workflow should
  // prevent; if one slips through, the most recently opened window wins.
  return matches.reduce((a, b) => (a.effectiveFrom >= b.effectiveFrom ? a : b))
}
