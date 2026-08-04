import { withTransaction } from '@gadong/kernel'
import { DayRecordRepository } from './day-record.repository'
import { EmployeeRefRepository } from './employee-ref.repository'
import { ExceptionRepository } from './exception.repository'
import { FakeTimesheetDb } from './testing/fake-db'
import { ViewsService } from './views.service'

function fakePool(db: FakeTimesheetDb) {
  return {
    connect: async () => {
      const conn = db.connect()
      return {
        query: (sql: string, params?: unknown[]) => conn.query(sql, params),
        release: (err?: Error) => conn.release(err),
      }
    },
  } as unknown as import('pg').Pool
}

async function seed(pool: import('pg').Pool, dayRecords: DayRecordRepository, employeeRefs: EmployeeRefRepository) {
  // Two teams: org-a (managed by mgr-a) has emp-1/emp-2; org-b (managed by mgr-b, a PEER manager) has emp-3.
  await withTransaction(pool, async (tx) => {
    await employeeRefs.upsert(tx, { employeeId: 'emp-1', empCode: 'E1', orgUnitId: 'org-a', employmentType: 'monthly', status: 'active' })
    await employeeRefs.upsert(tx, { employeeId: 'emp-2', empCode: 'E2', orgUnitId: 'org-a', employmentType: 'monthly', status: 'active' })
    await employeeRefs.upsert(tx, { employeeId: 'emp-3', empCode: 'E3', orgUnitId: 'org-b', employmentType: 'monthly', status: 'active' })
    await dayRecords.ensureExists(tx, 'emp-1', '2026-08-10', null)
    await dayRecords.ensureExists(tx, 'emp-2', '2026-08-10', null)
    await dayRecords.ensureExists(tx, 'emp-3', '2026-08-10', null)
  })
}

function harness() {
  const db = new FakeTimesheetDb()
  const pool = fakePool(db)
  const dayRecords = new DayRecordRepository(db.asPool())
  const employeeRefs = new EmployeeRefRepository(db.asPool())
  const exceptions = new ExceptionRepository(db.asPool())
  const service = new ViewsService(dayRecords, employeeRefs, exceptions)
  return { db, pool, dayRecords, employeeRefs, exceptions, service }
}

describe('ViewsService — row scoping (roadmap security gap: PermissionGuard checks the ACTION, this closes the ROW)', () => {
  it('myDays never depends on any scope — always exactly the caller\'s own rows', async () => {
    const h = harness()
    await seed(h.pool, h.dayRecords, h.employeeRefs)

    const result = await h.service.myDays('emp-1', '2026-08-01', '2026-08-31')
    expect(result.map((r) => r.employeeId)).toEqual(['emp-1'])
  })

  it("a manager's team query (scope = their own org unit) returns their team only — not a peer's team, not the org", async () => {
    const h = harness()
    await seed(h.pool, h.dayRecords, h.employeeRefs)

    const teamA = await h.service.teamDays('org-a', '2026-08-01', '2026-08-31', ['org-a'])
    expect(teamA.map((r) => r.employeeId).sort()).toEqual(['emp-1', 'emp-2'])
    expect(teamA.map((r) => r.employeeId)).not.toContain('emp-3')
  })

  it("a manager scoped to org-a is REFUSED (TSH-070, 403) when querying org-b — a peer's team is not reachable by changing the URL param", async () => {
    const h = harness()
    await seed(h.pool, h.dayRecords, h.employeeRefs)

    await expect(h.service.teamDays('org-b', '2026-08-01', '2026-08-31', ['org-a'])).rejects.toMatchObject({ code: 'TSH-070' })
  })

  it('scope "*" (HR) sees every team, unrestricted', async () => {
    const h = harness()
    await seed(h.pool, h.dayRecords, h.employeeRefs)

    const orgA = await h.service.teamDays('org-a', '2026-08-01', '2026-08-31', '*')
    const orgB = await h.service.teamDays('org-b', '2026-08-01', '2026-08-31', '*')
    expect(orgA.map((r) => r.employeeId).sort()).toEqual(['emp-1', 'emp-2'])
    expect(orgB.map((r) => r.employeeId)).toEqual(['emp-3'])
  })

  it('scope "self" (an individual employee, not a manager) is refused a team view entirely', async () => {
    const h = harness()
    await seed(h.pool, h.dayRecords, h.employeeRefs)

    await expect(h.service.teamDays('org-a', '2026-08-01', '2026-08-31', 'self')).rejects.toMatchObject({ code: 'TSH-070' })
  })

  it('employeeDays (HR single-employee view): scope "*" reaches anyone; an org-unit scope reaches only employees in that unit', async () => {
    const h = harness()
    await seed(h.pool, h.dayRecords, h.employeeRefs)

    const viaStar = await h.service.employeeDays('emp-3', '2026-08-01', '2026-08-31', 'hr-1', '*')
    expect(viaStar.map((r) => r.employeeId)).toEqual(['emp-3'])

    await expect(h.service.employeeDays('emp-3', '2026-08-01', '2026-08-31', 'mgr-a', ['org-a'])).rejects.toMatchObject({
      code: 'TSH-071',
    })
  })

  it("employeeDays with scope 'self' allows only the caller's own id — an employee cannot view a co-worker's days by guessing their id", async () => {
    const h = harness()
    await seed(h.pool, h.dayRecords, h.employeeRefs)

    const own = await h.service.employeeDays('emp-1', '2026-08-01', '2026-08-31', 'emp-1', 'self')
    expect(own.map((r) => r.employeeId)).toEqual(['emp-1'])

    await expect(h.service.employeeDays('emp-2', '2026-08-01', '2026-08-31', 'emp-1', 'self')).rejects.toMatchObject({
      code: 'TSH-071',
    })
  })

  it('exceptionsQueue scopes to the requested org unit when given, refusing one outside the caller\'s scope', async () => {
    const h = harness()
    await seed(h.pool, h.dayRecords, h.employeeRefs)
    const dayA = await h.dayRecords.findOne('emp-1', '2026-08-10')
    const dayB = await h.dayRecords.findOne('emp-3', '2026-08-10')
    await withTransaction(h.pool, (tx) => h.exceptions.raise(tx, dayA?.id ?? '', 'late', '10 min'))
    await withTransaction(h.pool, (tx) => h.exceptions.raise(tx, dayB?.id ?? '', 'late', '10 min'))

    const teamAQueue = await h.service.exceptionsQueue('open', 'org-a', 'mgr-a', ['org-a'])
    expect(teamAQueue).toHaveLength(1)

    await expect(h.service.exceptionsQueue('open', 'org-b', 'mgr-a', ['org-a'])).rejects.toMatchObject({ code: 'TSH-070' })
  })

  it('exceptionsQueue with no org_unit param and scope "*" (HR) returns every open exception across the org', async () => {
    const h = harness()
    await seed(h.pool, h.dayRecords, h.employeeRefs)
    const dayA = await h.dayRecords.findOne('emp-1', '2026-08-10')
    const dayB = await h.dayRecords.findOne('emp-3', '2026-08-10')
    await withTransaction(h.pool, (tx) => h.exceptions.raise(tx, dayA?.id ?? '', 'late', '10 min'))
    await withTransaction(h.pool, (tx) => h.exceptions.raise(tx, dayB?.id ?? '', 'late', '10 min'))

    const all = await h.service.exceptionsQueue('open', null, 'hr-1', '*')
    expect(all).toHaveLength(2)
  })

  it('exceptionsQueue with no org_unit param and an array scope resolves to exactly that manager\'s teams', async () => {
    const h = harness()
    await seed(h.pool, h.dayRecords, h.employeeRefs)
    const dayA = await h.dayRecords.findOne('emp-1', '2026-08-10')
    const dayB = await h.dayRecords.findOne('emp-3', '2026-08-10')
    await withTransaction(h.pool, (tx) => h.exceptions.raise(tx, dayA?.id ?? '', 'late', '10 min'))
    await withTransaction(h.pool, (tx) => h.exceptions.raise(tx, dayB?.id ?? '', 'late', '10 min'))

    const mgrAQueue = await h.service.exceptionsQueue('open', null, 'mgr-a', ['org-a'])
    expect(mgrAQueue).toHaveLength(1)
  })
})
