import { randomUUID } from 'node:crypto'
import { PunchRepository } from './punch.repository'
import type { NewPunchRow } from './punch.repository'
import { FakeAttendanceDb } from './testing/fake-attendance-db'

function samplePunch(overrides: Partial<NewPunchRow> = {}): NewPunchRow {
  return {
    id: randomUUID(),
    idemKey: 'device-1:seq-1',
    employeeId: 'emp-1',
    deviceId: 'device-1',
    punchedAt: '2026-01-01T08:00:00.000Z',
    direction: 'in',
    method: 'face',
    matchScore: 0.97,
    livenessPassed: true,
    siteCode: 'BKK-HQ',
    geo: null,
    ...overrides,
  }
}

describe('PunchRepository — offline kiosk replay (M4-4/M4-6)', () => {
  it('the same idem_key delivered three times creates exactly one punch', async () => {
    const db = new FakeAttendanceDb()
    const repo = new PunchRepository(db.asPool())

    for (let i = 0; i < 3; i++) {
      const tx = db.connect()
      await tx.query('BEGIN')
      await repo.insert(tx, samplePunch({ id: randomUUID() }))
      await tx.query('COMMIT')
    }

    expect(db.debugPunches()).toHaveLength(1)
  })

  it('reports duplicate: true from the second and third call, false from the first', async () => {
    const db = new FakeAttendanceDb()
    const repo = new PunchRepository(db.asPool())
    const results: boolean[] = []

    for (let i = 0; i < 3; i++) {
      const tx = db.connect()
      await tx.query('BEGIN')
      const { duplicate } = await repo.insert(tx, samplePunch({ id: randomUUID() }))
      await tx.query('COMMIT')
      results.push(duplicate)
    }

    expect(results).toEqual([false, true, true])
  })

  it('a different idem_key creates a second, independent punch', async () => {
    const db = new FakeAttendanceDb()
    const repo = new PunchRepository(db.asPool())

    const tx1 = db.connect()
    await tx1.query('BEGIN')
    await repo.insert(tx1, samplePunch({ idemKey: 'device-1:seq-1' }))
    await tx1.query('COMMIT')

    const tx2 = db.connect()
    await tx2.query('BEGIN')
    await repo.insert(tx2, samplePunch({ id: randomUUID(), idemKey: 'device-1:seq-2' }))
    await tx2.query('COMMIT')

    expect(db.debugPunches()).toHaveLength(2)
  })

  it('rejects an unrecognised direction via the CHECK constraint', async () => {
    const db = new FakeAttendanceDb()
    const repo = new PunchRepository(db.asPool())
    const tx = db.connect()
    await tx.query('BEGIN')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately bypassing the type system to prove the fake enforces the DB-level CHECK.
    await expect(repo.insert(tx, samplePunch({ direction: 'sideways' as any }))).rejects.toThrow(/punch_event_direction_check/)
  })

  it('a PIN punch (no matchScore/livenessPassed) stores nulls, not zero/false', async () => {
    const db = new FakeAttendanceDb()
    const repo = new PunchRepository(db.asPool())
    const tx = db.connect()
    await tx.query('BEGIN')
    const { row } = await repo.insert(tx, samplePunch({ method: 'pin', matchScore: null, livenessPassed: null }))
    await tx.query('COMMIT')

    expect(row.matchScore).toBeNull()
    expect(row.livenessPassed).toBeNull()
  })

  it('listForEmployee returns punches in the requested window, most recent first', async () => {
    const db = new FakeAttendanceDb()
    const repo = new PunchRepository(db.asPool())

    for (const [idemKey, punchedAt] of [
      ['device-1:seq-1', '2026-01-01T08:00:00.000Z'],
      ['device-1:seq-2', '2026-01-02T08:00:00.000Z'],
      ['device-1:seq-3', '2026-02-01T08:00:00.000Z'], // outside window
    ] as const) {
      const tx = db.connect()
      await tx.query('BEGIN')
      await repo.insert(tx, samplePunch({ id: randomUUID(), idemKey, punchedAt }))
      await tx.query('COMMIT')
    }

    const rows = await repo.listForEmployee(db.asPool(), 'emp-1', '2026-01-01T00:00:00.000Z', '2026-01-31T23:59:59.000Z')
    expect(rows.map((r) => r.idemKey)).toEqual(['device-1:seq-2', 'device-1:seq-1'])
  })
})
