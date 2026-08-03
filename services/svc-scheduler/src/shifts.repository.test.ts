import { ShiftsRepository } from './shifts.repository'
import type { NewShiftRow } from './shifts.repository'
import { ConstraintViolation, FakeSchedulerDb } from './testing/fake-db'

const NIGHT_SHIFT: NewShiftRow = {
  nameI18n: { en: 'Night Shift', th: 'กะดึก' },
  startT: '22:00',
  endT: '06:00',
  crossesMidnight: true,
  breakRules: [{ minutes: 60, paid: false }],
  graceMin: 15,
  differential: { kind: 'percent', amount: 10 },
}

describe('ShiftsRepository', () => {
  it('inserts and reads back a night shift crossing midnight, jsonb columns intact', async () => {
    const db = new FakeSchedulerDb()
    const tx = db.connect()
    await tx.query('BEGIN')
    const repo = new ShiftsRepository(db.asPool())
    const created = await repo.insert(tx, NIGHT_SHIFT)
    await tx.query('COMMIT')

    const found = await repo.findById(created.id)
    expect(found).not.toBeNull()
    expect(found?.crossesMidnight).toBe(true)
    expect(found?.startT).toBe('22:00')
    expect(found?.endT).toBe('06:00')
    expect(found?.breakRules).toEqual([{ minutes: 60, paid: false }])
    expect(found?.differential).toEqual({ kind: 'percent', amount: 10 })
  })

  it('rejects a negative grace_min — shift_grace_min_check', async () => {
    const db = new FakeSchedulerDb()
    const tx = db.connect()
    await tx.query('BEGIN')
    const repo = new ShiftsRepository(db.asPool())
    await expect(repo.insert(tx, { ...NIGHT_SHIFT, graceMin: -1 })).rejects.toThrow(ConstraintViolation)
  })

  it('lists shifts and updates one in place', async () => {
    const db = new FakeSchedulerDb()
    const repo = new ShiftsRepository(db.asPool())
    const tx = db.connect()
    await tx.query('BEGIN')
    const created = await repo.insert(tx, NIGHT_SHIFT)
    await tx.query('COMMIT')

    const tx2 = db.connect()
    await tx2.query('BEGIN')
    const updated = await repo.update(tx2, created.id, { ...NIGHT_SHIFT, graceMin: 20 })
    await tx2.query('COMMIT')

    expect(updated?.graceMin).toBe(20)
    const list = await repo.list()
    expect(list).toHaveLength(1)
    expect(list[0]?.graceMin).toBe(20)
  })

  it('update() returns null for an unknown id', async () => {
    const db = new FakeSchedulerDb()
    const repo = new ShiftsRepository(db.asPool())
    const tx = db.connect()
    await tx.query('BEGIN')
    const result = await repo.update(tx, 'no-such-id', NIGHT_SHIFT)
    expect(result).toBeNull()
  })
})
