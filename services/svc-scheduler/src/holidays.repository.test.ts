import { HolidaysRepository } from './holidays.repository'
import { ConstraintViolation, FakeSchedulerDb } from './testing/fake-db'

describe('HolidaysRepository', () => {
  it('creates a calendar for a year and rejects a second one for the same year', async () => {
    const db = new FakeSchedulerDb()
    const repo = new HolidaysRepository(db.asPool())
    const tx = db.connect()
    await tx.query('BEGIN')
    const created = await repo.insertCalendar(tx, 2026)
    await tx.query('COMMIT')
    expect(created.year).toBe(2026)

    const tx2 = db.connect()
    await tx2.query('BEGIN')
    await expect(repo.insertCalendar(tx2, 2026)).rejects.toThrow(ConstraintViolation)
  })

  it('inserts holidays, rejects a duplicate date within the same calendar, lists in date order', async () => {
    const db = new FakeSchedulerDb()
    const repo = new HolidaysRepository(db.asPool())
    const tx = db.connect()
    await tx.query('BEGIN')
    const calendar = await repo.insertCalendar(tx, 2026)
    await repo.insertHoliday(tx, calendar.id, { holidayDate: '2026-05-01', nameI18n: { en: 'Labour Day' }, isSubstitute: false, substituteForId: null })
    await repo.insertHoliday(tx, calendar.id, { holidayDate: '2026-01-01', nameI18n: { en: "New Year" }, isSubstitute: false, substituteForId: null })
    await tx.query('COMMIT')

    const list = await repo.listByCalendar(calendar.id)
    expect(list.map((h) => h.holidayDate)).toEqual(['2026-01-01', '2026-05-01'])

    const tx2 = db.connect()
    await tx2.query('BEGIN')
    await expect(
      repo.insertHoliday(tx2, calendar.id, { holidayDate: '2026-01-01', nameI18n: { en: 'dup' }, isSubstitute: false, substituteForId: null }),
    ).rejects.toThrow(ConstraintViolation)
  })

  it('deleteAllByCalendar clears every holiday for that calendar, within the same transaction as reinsertion', async () => {
    const db = new FakeSchedulerDb()
    const repo = new HolidaysRepository(db.asPool())
    const tx = db.connect()
    await tx.query('BEGIN')
    const calendar = await repo.insertCalendar(tx, 2026)
    await repo.insertHoliday(tx, calendar.id, { holidayDate: '2026-01-01', nameI18n: { en: 'x' }, isSubstitute: false, substituteForId: null })
    await tx.query('COMMIT')

    const tx2 = db.connect()
    await tx2.query('BEGIN')
    await repo.deleteAllByCalendar(tx2, calendar.id)
    await repo.insertHoliday(tx2, calendar.id, { holidayDate: '2026-02-02', nameI18n: { en: 'y' }, isSubstitute: false, substituteForId: null })
    await tx2.query('COMMIT')

    const list = await repo.listByCalendar(calendar.id)
    expect(list.map((h) => h.holidayDate)).toEqual(['2026-02-02'])
  })
})
