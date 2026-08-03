import { ShiftsRepository } from './shifts.repository'
import type { NewShiftRow } from './shifts.repository'
import { ShiftsService } from './shifts.service'
import { FakeSchedulerDb } from './testing/fake-db'

const NIGHT_SHIFT: NewShiftRow = {
  nameI18n: { en: 'Night Shift' },
  startT: '22:00',
  endT: '06:00',
  crossesMidnight: true,
  breakRules: [],
  graceMin: 0,
  differential: null,
}

describe('ShiftsService', () => {
  it('creates a valid midnight-crossing shift', async () => {
    const db = new FakeSchedulerDb()
    const service = new ShiftsService(new ShiftsRepository(db.asPool()))
    const tx = db.connect()
    await tx.query('BEGIN')
    const created = await service.create(tx, NIGHT_SHIFT)
    await tx.query('COMMIT')
    expect(created.crossesMidnight).toBe(true)
  })

  it('rejects a same-day shift with end before start and crossesMidnight false at CREATE time, not lazily later', async () => {
    const db = new FakeSchedulerDb()
    const service = new ShiftsService(new ShiftsRepository(db.asPool()))
    const tx = db.connect()
    await tx.query('BEGIN')
    await expect(
      service.create(tx, { ...NIGHT_SHIFT, startT: '17:00', endT: '09:00', crossesMidnight: false }),
    ).rejects.toMatchObject({ code: 'SCH-013' })
  })

  it('get() throws SCH-404 for an unknown id', async () => {
    const db = new FakeSchedulerDb()
    const service = new ShiftsService(new ShiftsRepository(db.asPool()))
    await expect(service.get('no-such-id')).rejects.toMatchObject({ code: 'SCH-404' })
  })

  it('patch() merges onto the existing row and re-validates timing', async () => {
    const db = new FakeSchedulerDb()
    const service = new ShiftsService(new ShiftsRepository(db.asPool()))
    const tx = db.connect()
    await tx.query('BEGIN')
    const created = await service.create(tx, NIGHT_SHIFT)
    await tx.query('COMMIT')

    const tx2 = db.connect()
    await tx2.query('BEGIN')
    const patched = await service.patch(tx2, created.id, { graceMin: 10 })
    await tx2.query('COMMIT')
    expect(patched.graceMin).toBe(10)
    expect(patched.crossesMidnight).toBe(true) // untouched fields preserved

    const tx3 = db.connect()
    await tx3.query('BEGIN')
    await expect(service.patch(tx3, created.id, { crossesMidnight: false })).rejects.toMatchObject({ code: 'SCH-013' })
  })
})
