/**
 * The default calendar `svc-scheduler` ships with (M2-3: "ships with the
 * ≥13 statutory public holidays incl. National Labour Day"). Deliberately
 * limited to FIXED-date holidays only — the remaining Thai public holidays
 * a Cabinet actually announces each year (Makha Bucha, Visakha Bucha,
 * Asalha Bucha, Buddhist Lent Day) fall on the Buddhist lunar calendar and
 * have no closed-form Gregorian formula; shipping a wrong computed date for
 * one of those would be exactly the "underpays someone by 2x" defect this
 * module exists to prevent (brief WHERE THIS FITS). 15 fixed-date holidays
 * clears the ≥13 floor with margin; a company adds the lunar ones (and any
 * others) per Cabinet's annual announcement through the same "add, never
 * reduce below the floor" path `HolidaysService.setCalendar` enforces.
 *
 * Dates themselves are calendar/announcement facts, not the kind of
 * adjustable statutory NUMBER (a ceiling, a floor, a multiplier) the brief's
 * "no statutory number in a .ts file outside a test fixture" targets — that
 * rule is enforced for the ≥13 floor itself, which `HolidaysService` reads
 * from `svc-config`'s `holidays.public.min_per_year`, never from this file.
 */
export interface SeedHoliday {
  month: number // 1-12
  day: number
  nameI18n: Record<string, string>
}

export const THAI_FIXED_DATE_HOLIDAYS: SeedHoliday[] = [
  { month: 1, day: 1, nameI18n: { en: "New Year's Day", th: 'วันขึ้นปีใหม่' } },
  { month: 4, day: 6, nameI18n: { en: 'Chakri Memorial Day', th: 'วันจักรี' } },
  { month: 4, day: 13, nameI18n: { en: 'Songkran Day', th: 'วันสงกรานต์' } },
  { month: 4, day: 14, nameI18n: { en: 'Songkran Day', th: 'วันสงกรานต์' } },
  { month: 4, day: 15, nameI18n: { en: 'Songkran Day', th: 'วันสงกรานต์' } },
  { month: 5, day: 1, nameI18n: { en: 'National Labour Day', th: 'วันแรงงานแห่งชาติ' } },
  { month: 5, day: 4, nameI18n: { en: 'Coronation Day', th: 'วันฉัตรมงคล' } },
  { month: 6, day: 3, nameI18n: { en: "Queen Suthida's Birthday", th: 'วันเฉลิมพระชนมพรรษาสมเด็จพระราชินี' } },
  { month: 7, day: 28, nameI18n: { en: "King Vajiralongkorn's Birthday", th: 'วันเฉลิมพระชนมพรรษา ร.10' } },
  { month: 8, day: 12, nameI18n: { en: "The Queen Mother's Birthday / Mother's Day", th: 'วันแม่แห่งชาติ' } },
  { month: 10, day: 13, nameI18n: { en: 'King Bhumibol Memorial Day', th: 'วันคล้ายวันสวรรคต ร.9' } },
  { month: 10, day: 23, nameI18n: { en: 'Chulalongkorn Day', th: 'วันปิยมหาราช' } },
  { month: 12, day: 5, nameI18n: { en: "King Bhumibol's Birthday / Father's Day", th: 'วันพ่อแห่งชาติ' } },
  { month: 12, day: 10, nameI18n: { en: 'Constitution Day', th: 'วันรัฐธรรมนูญ' } },
  { month: 12, day: 31, nameI18n: { en: "New Year's Eve", th: 'วันสิ้นปี' } },
]

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

export function defaultHolidaySeed(year: number): Array<{ date: string; nameI18n: Record<string, string> }> {
  return THAI_FIXED_DATE_HOLIDAYS.map((h) => ({ date: `${year}-${pad2(h.month)}-${pad2(h.day)}`, nameI18n: h.nameI18n }))
}
