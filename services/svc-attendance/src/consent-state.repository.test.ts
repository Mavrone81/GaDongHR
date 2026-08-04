import { ConsentStateRepository } from './consent-state.repository'
import { FakeAttendanceDb } from './testing/fake-attendance-db'

describe('ConsentStateRepository', () => {
  it('returns null / false for an employee with no consent-state row', async () => {
    const db = new FakeAttendanceDb()
    const repo = new ConsentStateRepository(db.asPool())
    expect(await repo.find('emp-1')).toBeNull()
    expect(await repo.isGranted('emp-1')).toBe(false)
  })

  it('upsert records granted, isGranted becomes true', async () => {
    const db = new FakeAttendanceDb()
    const repo = new ConsentStateRepository(db.asPool())
    const tx = db.connect()
    await tx.query('BEGIN')
    await repo.upsert(tx, 'emp-1', 'granted', '2026-01-01T00:00:00.000Z')
    await tx.query('COMMIT')

    expect(await repo.isGranted('emp-1')).toBe(true)
    const row = await repo.find('emp-1')
    expect(row).toMatchObject({ employeeId: 'emp-1', state: 'granted' })
  })

  it('a later withdrawn upsert overwrites granted — isGranted becomes false again', async () => {
    const db = new FakeAttendanceDb()
    const repo = new ConsentStateRepository(db.asPool())

    const tx1 = db.connect()
    await tx1.query('BEGIN')
    await repo.upsert(tx1, 'emp-1', 'granted', '2026-01-01T00:00:00.000Z')
    await tx1.query('COMMIT')

    const tx2 = db.connect()
    await tx2.query('BEGIN')
    await repo.upsert(tx2, 'emp-1', 'withdrawn', '2026-01-02T00:00:00.000Z')
    await tx2.query('COMMIT')

    expect(await repo.isGranted('emp-1')).toBe(false)
  })

  it('rejects an unrecognised state via the CHECK constraint', async () => {
    const db = new FakeAttendanceDb()
    const repo = new ConsentStateRepository(db.asPool())
    const tx = db.connect()
    await tx.query('BEGIN')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately bypassing the type system to prove the fake enforces the DB-level CHECK, not just TypeScript.
    await expect(repo.upsert(tx, 'emp-1', 'bogus' as any, '2026-01-01T00:00:00.000Z')).rejects.toThrow(/biometric_consent_state_check/)
  })
})
