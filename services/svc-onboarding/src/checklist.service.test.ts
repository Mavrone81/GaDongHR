import { ChecklistService, ESCALATION_LEAD_DAYS, SSO_DEADLINE_RULE_KEY } from './checklist.service'
import { OnboardingTaskRepository } from './onboarding-task.repository'
import { FakeOnboardingDb } from './testing/fake-db'
import { fakeConfigClient } from './testing/fake-config-client'

function makeService(deadlineDays = 30): { service: ChecklistService; db: FakeOnboardingDb } {
  const db = new FakeOnboardingDb()
  const repo = new OnboardingTaskRepository(db.asPool())
  const service = new ChecklistService(repo, fakeConfigClient({ [SSO_DEADLINE_RULE_KEY]: deadlineDays }))
  return { service, db }
}

describe('ChecklistService — SSO task due date and escalation, resolved from svc-config (never hard-coded)', () => {
  it('a new hire with start date D gets an sso_registration task due D+30 when svc-config says 30', async () => {
    const { service, db } = makeService(30)
    const conn = db.connect()
    const deadlineDays = await service.resolveSsoDeadlineDays()
    const plan = service.planTasks('monthly', '2026-09-01', deadlineDays)

    await conn.query('BEGIN')
    await service.createTasks(conn, 'emp-1', plan)
    await conn.query('COMMIT')

    const tasks = await service.listForEmployee('emp-1')
    const sso = tasks.find((t) => t.taskKey === 'sso_registration')
    expect(sso?.dueDate).toBe('2026-10-01') // 2026-09-01 + 30 days
  })

  it('escalates at D+23 when the deadline is 30 (30 - 7 = 23), and the 7-day lead is a fixed constant, not fetched', async () => {
    const { service, db } = makeService(30)
    const conn = db.connect()
    const deadlineDays = await service.resolveSsoDeadlineDays()
    const plan = service.planTasks('monthly', '2026-09-01', deadlineDays)

    await conn.query('BEGIN')
    await service.createTasks(conn, 'emp-1', plan)
    await conn.query('COMMIT')

    const tasks = await service.listForEmployee('emp-1')
    const sso = tasks.find((t) => t.taskKey === 'sso_registration')
    expect(sso?.escalateAt).toBe('2026-09-24') // D+30 - 7 = D+23 = 2026-09-01 + 23 days
    expect(ESCALATION_LEAD_DAYS).toBe(7)
  })

  it('a different svc-config value (e.g. 20) changes BOTH the due date and the escalation date — proves the number is genuinely resolved from config, not a baked-in 30', async () => {
    const { service, db } = makeService(20)
    const conn = db.connect()
    const deadlineDays = await service.resolveSsoDeadlineDays()
    expect(deadlineDays).toBe(20)
    const plan = service.planTasks('monthly', '2026-09-01', deadlineDays)

    await conn.query('BEGIN')
    await service.createTasks(conn, 'emp-1', plan)
    await conn.query('COMMIT')

    const tasks = await service.listForEmployee('emp-1')
    const sso = tasks.find((t) => t.taskKey === 'sso_registration')
    expect(sso?.dueDate).toBe('2026-09-21') // +20
    expect(sso?.escalateAt).toBe('2026-09-14') // +20-7=+13
  })

  it('isSsoTaskEscalated() is true once "today" reaches the escalation date and false before it', async () => {
    const { service, db } = makeService(30)
    const conn = db.connect()
    const plan = service.planTasks('monthly', '2026-09-01', 30)
    await conn.query('BEGIN')
    await service.createTasks(conn, 'emp-1', plan)
    await conn.query('COMMIT')

    expect(await service.isSsoTaskEscalated('emp-1', '2026-09-23')).toBe(false)
    expect(await service.isSsoTaskEscalated('emp-1', '2026-09-24')).toBe(true)
    expect(await service.isSsoTaskEscalated('emp-1', '2026-10-05')).toBe(true)
  })

  it('a contract employee gets no probation_review task but still gets sso_registration', async () => {
    const { service, db } = makeService(30)
    const conn = db.connect()
    const deadlineDays = await service.resolveSsoDeadlineDays()
    const plan = service.planTasks('contract', '2026-09-01', deadlineDays)

    await conn.query('BEGIN')
    await service.createTasks(conn, 'emp-1', plan)
    await conn.query('COMMIT')

    const keys = (await service.listForEmployee('emp-1')).map((t) => t.taskKey)
    expect(keys).not.toContain('probation_review')
    expect(keys).toContain('sso_registration')
  })
})

describe('ChecklistService.completeTask — ONB-030: sso_registration cannot complete without a real SSO number', () => {
  it('rejects completing sso_registration when ssoNumberPresent is false', async () => {
    const { service, db } = makeService(30)
    const conn = db.connect()
    const plan = service.planTasks('monthly', '2026-09-01', 30)
    await conn.query('BEGIN')
    const [task] = await service.createTasks(conn, 'emp-1', plan)
    await conn.query('COMMIT')
    const ssoTask = (await service.listForEmployee('emp-1')).find((t) => t.taskKey === 'sso_registration')
    if (!ssoTask) throw new Error('test setup: no sso task')
    void task

    await conn.query('BEGIN')
    await expect(service.completeTask(conn, ssoTask.id, false)).rejects.toMatchObject({ code: 'ONB-030' })
  })

  it('completes sso_registration when ssoNumberPresent is true', async () => {
    const { service, db } = makeService(30)
    const conn = db.connect()
    const plan = service.planTasks('monthly', '2026-09-01', 30)
    await conn.query('BEGIN')
    await service.createTasks(conn, 'emp-1', plan)
    await conn.query('COMMIT')
    const ssoTask = (await service.listForEmployee('emp-1')).find((t) => t.taskKey === 'sso_registration')
    if (!ssoTask) throw new Error('test setup: no sso task')

    await conn.query('BEGIN')
    const completed = await service.completeTask(conn, ssoTask.id, true)
    await conn.query('COMMIT')
    expect(completed.status).toBe('completed')
  })

  it('a non-sso task completes regardless of ssoNumberPresent', async () => {
    const { service, db } = makeService(30)
    const conn = db.connect()
    const plan = service.planTasks('monthly', '2026-09-01', 30)
    await conn.query('BEGIN')
    await service.createTasks(conn, 'emp-1', plan)
    await conn.query('COMMIT')
    const docTask = (await service.listForEmployee('emp-1')).find((t) => t.taskKey === 'document_upload')
    if (!docTask) throw new Error('test setup: no document_upload task')

    await conn.query('BEGIN')
    const completed = await service.completeTask(conn, docTask.id, false)
    await conn.query('COMMIT')
    expect(completed.status).toBe('completed')
  })

  it('ONB-031 unknown task id', async () => {
    const { service, db } = makeService(30)
    const conn = db.connect()
    await expect(service.completeTask(conn, 'no-such-task', true)).rejects.toMatchObject({ code: 'ONB-031' })
  })
})

describe('ChecklistService.allComplete', () => {
  it('false when any task is pending, true once every task is completed', async () => {
    const { service, db } = makeService(30)
    const conn = db.connect()
    const plan = service.planTasks('contract', '2026-09-01', 30)
    await conn.query('BEGIN')
    await service.createTasks(conn, 'emp-1', plan)
    await conn.query('COMMIT')

    expect(await service.allComplete('emp-1')).toBe(false)

    const tasks = await service.listForEmployee('emp-1')
    for (const t of tasks) {
      await conn.query('BEGIN')
      await service.completeTask(conn, t.id, true)
      await conn.query('COMMIT')
    }
    expect(await service.allComplete('emp-1')).toBe(true)
  })
})
