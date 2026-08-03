import { ProbationRepository } from './probation.repository'
import { ConstraintViolation, FakeOnboardingDb } from './testing/fake-db'

describe('ProbationRepository — against FakeOnboardingDb', () => {
  it('insert() then findByEmployeeId() round-trips', async () => {
    const db = new FakeOnboardingDb()
    const conn = db.connect()
    const repo = new ProbationRepository(conn)

    await conn.query('BEGIN')
    const row = await repo.insert(conn, 'emp-1', '2026-12-01')
    await conn.query('COMMIT')

    expect(row).toMatchObject({ employeeId: 'emp-1', endDate: '2026-12-01', outcome: null })
    expect(await repo.findByEmployeeId('emp-1')).toMatchObject({ id: row.id })
  })

  it('UNIQUE employee_id: a second probation record for the same employee is rejected (0..1 relationship)', async () => {
    const db = new FakeOnboardingDb()
    const conn = db.connect()
    const repo = new ProbationRepository(conn)

    await conn.query('BEGIN')
    await repo.insert(conn, 'emp-1', '2026-12-01')
    await conn.query('COMMIT')

    await expect(repo.insert(conn, 'emp-1', '2027-01-01')).rejects.toThrow(ConstraintViolation)
  })

  it('decide() records confirm/extend/terminate outcomes', async () => {
    const db = new FakeOnboardingDb()
    const conn = db.connect()
    const repo = new ProbationRepository(conn)

    await conn.query('BEGIN')
    const row = await repo.insert(conn, 'emp-1', '2026-12-01')
    await conn.query('COMMIT')

    await conn.query('BEGIN')
    const extended = await repo.decide(conn, row.id, 'extend', '2026-11-20T00:00:00.000Z', '2027-01-01')
    await conn.query('COMMIT')

    expect(extended).toMatchObject({ outcome: 'extend', extendedTo: '2027-01-01' })
  })

  it('rejects an invalid outcome — CHECK constraint', async () => {
    const db = new FakeOnboardingDb()
    const conn = db.connect()
    const repo = new ProbationRepository(conn)

    await conn.query('BEGIN')
    const row = await repo.insert(conn, 'emp-1', '2026-12-01')
    await conn.query('COMMIT')

    await conn.query('BEGIN')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately an invalid value to prove the CHECK constraint
    await expect(repo.decide(conn, row.id, 'bogus' as any, '2026-11-20T00:00:00.000Z', null)).rejects.toThrow(ConstraintViolation)
  })

  it('decide() on a non-existent id returns null', async () => {
    const db = new FakeOnboardingDb()
    const conn = db.connect()
    const repo = new ProbationRepository(conn)

    await conn.query('BEGIN')
    expect(await repo.decide(conn, 'no-such-id', 'confirm', '2026-11-20T00:00:00.000Z', null)).toBeNull()
    await conn.query('COMMIT')
  })
})
