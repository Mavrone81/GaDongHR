import { OnboardingTaskRepository } from './onboarding-task.repository'
import { FakeOnboardingDb } from './testing/fake-db'

describe('OnboardingTaskRepository — against FakeOnboardingDb', () => {
  it('insert() creates a pending task; findByEmployeeId() lists it', async () => {
    const db = new FakeOnboardingDb()
    const conn = db.connect()
    const repo = new OnboardingTaskRepository(conn)

    await conn.query('BEGIN')
    const task = await repo.insert(conn, { employeeId: 'emp-1', taskKey: 'sso_registration', dueDate: '2026-10-01' })
    await conn.query('COMMIT')

    expect(task).toMatchObject({ employeeId: 'emp-1', taskKey: 'sso_registration', dueDate: '2026-10-01', status: 'pending' })

    const found = await repo.findByEmployeeId('emp-1')
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ id: task.id, status: 'pending' })
  })

  it('markCompleted() flips status to completed and is reflected by findById()', async () => {
    const db = new FakeOnboardingDb()
    const conn = db.connect()
    const repo = new OnboardingTaskRepository(conn)

    await conn.query('BEGIN')
    const task = await repo.insert(conn, { employeeId: 'emp-1', taskKey: 'document_upload', dueDate: '2026-09-01' })
    await conn.query('COMMIT')

    await conn.query('BEGIN')
    const completed = await repo.markCompleted(conn, task.id)
    await conn.query('COMMIT')

    expect(completed?.status).toBe('completed')
    expect((await repo.findById(task.id))?.status).toBe('completed')
  })

  it('markCompleted() on a non-existent id returns null', async () => {
    const db = new FakeOnboardingDb()
    const conn = db.connect()
    const repo = new OnboardingTaskRepository(conn)

    await conn.query('BEGIN')
    expect(await repo.markCompleted(conn, 'no-such-task')).toBeNull()
    await conn.query('COMMIT')
  })

  it('a rolled-back insert() is not visible after ROLLBACK', async () => {
    const db = new FakeOnboardingDb()
    const conn = db.connect()
    const repo = new OnboardingTaskRepository(conn)

    await conn.query('BEGIN')
    const task = await repo.insert(conn, { employeeId: 'emp-1', taskKey: 'pdpa_consent', dueDate: '2026-09-01' })
    await conn.query('ROLLBACK')

    expect(await repo.findById(task.id)).toBeNull()
  })
})
