import { ConfigClient } from './config-client'
import type { ConfigTransport } from './config-client'
import { computeSubstitutes, HolidaysService } from './holidays.service'
import { HolidaysRepository } from './holidays.repository'
import { defaultHolidaySeed } from './holiday-seed'
import { FakeSchedulerDb } from './testing/fake-db'

function configTransport(floor: number): ConfigTransport {
  return {
    get: (path: string) => {
      if (path.startsWith('/rules/holidays.public.min_per_year')) {
        return Promise.resolve({
          ruleKey: 'holidays.public.min_per_year',
          value: floor,
          unit: 'days',
          citation: 'LPA s.29',
          statutoryFloor: 13,
          statutoryCeiling: null,
        })
      }
      return Promise.reject(new Error(`unexpected rule: ${path}`))
    },
  }
}

describe('computeSubstitutes — pure substitute-day generation', () => {
  it('generates a substitute on the next working day when a holiday (Songkran) falls on the rest day', () => {
    // 2026-04-12 is a Sunday — treat it as "Songkran Day" for this scenario,
    // regardless of Songkran's real calendar date (brief: the acceptance
    // scenario is about the RULE, not this particular year's almanac).
    const subs = computeSubstitutes(['2026-04-12'], 0)
    expect(subs).toEqual([{ date: '2026-04-13', forDate: '2026-04-12' }])
  })

  it('skips forward past a second holiday and the rest day itself to find a genuinely free working day', () => {
    // Sunday 2026-04-12 is a holiday; Monday 2026-04-13 is ALSO already a
    // holiday; the substitute must land on 2026-04-14, not 04-13.
    const subs = computeSubstitutes(['2026-04-12', '2026-04-13'], 0)
    expect(subs).toEqual([{ date: '2026-04-14', forDate: '2026-04-12' }])
  })

  it('generates no substitute when no holiday falls on the rest day', () => {
    expect(computeSubstitutes(['2026-04-13'], 0)).toEqual([])
  })
})

describe('HolidaysService.setCalendar — the 13-holiday floor (M2-3)', () => {
  it('accepts a 15-holiday default seed (>= the configured 13 floor)', async () => {
    const db = new FakeSchedulerDb()
    const service = new HolidaysService(new HolidaysRepository(db.asPool()), new ConfigClient(configTransport(13)))
    const tx = db.connect()
    await tx.query('BEGIN')
    const result = await service.setCalendar(tx, { year: 2026, holidays: defaultHolidaySeed(2026) })
    await tx.query('COMMIT')

    const realHolidays = result.holidays.filter((h) => !h.isSubstitute)
    expect(realHolidays.length).toBeGreaterThanOrEqual(13)
  })

  it('rejects an attempt to set fewer than the configured floor, and the error carries the statutory citation', async () => {
    const db = new FakeSchedulerDb()
    const service = new HolidaysService(new HolidaysRepository(db.asPool()), new ConfigClient(configTransport(13)))
    const tooFew = defaultHolidaySeed(2026).slice(0, 5) // 5 < 13
    const tx = db.connect()
    await tx.query('BEGIN')

    await expect(service.setCalendar(tx, { year: 2026, holidays: tooFew })).rejects.toMatchObject({
      code: 'SCH-030',
      details: [{ year: 2026, providedCount: 5, statutoryFloor: 13, citation: 'LPA s.29' }],
    })
  })

  it('CONFIG-DRIVEN: raising the floor in config to 16 rejects the same 15-holiday seed that passed at floor 13', async () => {
    const db = new FakeSchedulerDb()
    const service = new HolidaysService(new HolidaysRepository(db.asPool()), new ConfigClient(configTransport(16)))
    const tx = db.connect()
    await tx.query('BEGIN')
    await expect(service.setCalendar(tx, { year: 2026, holidays: defaultHolidaySeed(2026) })).rejects.toMatchObject({
      code: 'SCH-030',
    })
  })

  it('auto-generates a substitute when a real holiday in the submitted list falls on the rest day, and does not count it toward the floor', async () => {
    const db = new FakeSchedulerDb()
    const service = new HolidaysService(new HolidaysRepository(db.asPool()), new ConfigClient(configTransport(13)))
    const base = defaultHolidaySeed(2026)
    const withSundayHoliday = [...base, { date: '2026-04-12', nameI18n: { en: 'Songkran Day (extra)' } }] // Sunday
    const tx = db.connect()
    await tx.query('BEGIN')
    const result = await service.setCalendar(tx, { year: 2026, holidays: withSundayHoliday, restDayOfWeek: 0 })
    await tx.query('COMMIT')

    // The default seed already carries Apr 13-15 (Songkran) as holidays, so
    // the substitute walks past those too, landing on the first genuinely
    // free working day: Apr 16.
    const substitute = result.holidays.find((h) => h.isSubstitute)
    expect(substitute).toBeDefined()
    expect(substitute?.holidayDate).toBe('2026-04-16')
    expect(substitute?.substituteForId).toBeDefined()
  })

  it('a second call replaces the prior holiday list (never silently accumulates duplicates), still enforcing the floor', async () => {
    const db = new FakeSchedulerDb()
    const service = new HolidaysService(new HolidaysRepository(db.asPool()), new ConfigClient(configTransport(13)))
    const tx = db.connect()
    await tx.query('BEGIN')
    await service.setCalendar(tx, { year: 2026, holidays: defaultHolidaySeed(2026) })
    await tx.query('COMMIT')

    const tx2 = db.connect()
    await tx2.query('BEGIN')
    const secondSeed = defaultHolidaySeed(2026).slice(0, 14) // still >= 13
    const result = await service.setCalendar(tx2, { year: 2026, holidays: secondSeed })
    await tx2.query('COMMIT')

    const view = await service.getCalendar(2026)
    expect(view.holidays.filter((h) => !h.isSubstitute)).toHaveLength(14)
    expect(result.holidays.filter((h) => !h.isSubstitute)).toHaveLength(14)
  })
})
