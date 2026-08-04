import 'reflect-metadata'
import { APP_GUARD } from '@nestjs/core'
import { AuthzClient, PERMISSION_METADATA_KEY, PUBLIC_METADATA_KEY, withTransaction } from '@gadong/kernel'
import type { AuthenticatedRequest, Decision } from '@gadong/kernel'
import type { Pool } from 'pg'
import { ConsolidationService } from './consolidation.service'
import { CorrectionAuditRepository } from './correction-audit.repository'
import { DayRecordRepository } from './day-record.repository'
import { EmployeeRefRepository } from './employee-ref.repository'
import { ExceptionRepository } from './exception.repository'
import { ExceptionsService } from './exceptions.service'
import { LeaveRefRepository } from './leave-ref.repository'
import { OtApprovalRefRepository } from './ot-approval-ref.repository'
import { PeriodRepository } from './period.repository'
import { PeriodService } from './period.service'
import { RosterRefRepository } from './roster-ref.repository'
import { defaultTimesheetConfig } from './testing/fake-config-client'
import { FakeTimesheetDb } from './testing/fake-db'
import { TimesheetController, DB_POOL } from './timesheet.controller'
import { ViewsService } from './views.service'
import { AppModule } from './app.module'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function fakePool(overrides: Partial<Pool> = {}): Pool {
  return {
    query: jest.fn().mockResolvedValue({ rows: [{ '?column?': 1 }] }),
    ...overrides,
  } as unknown as Pool
}

/** A scriptable `AuthzClient` — real `AuthzClient` wired to a fake `AuthzTransport` returning a canned `Decision` for every call, so the controller's SECOND `decide()` call (row-scoping — `org-scope.ts`) is exercised without HTTP. */
function fakeAuthzClient(decision: Decision): AuthzClient {
  return new AuthzClient({ post: async () => decision })
}

function fakeTimesheetPool(db: FakeTimesheetDb) {
  return {
    connect: async () => {
      const conn = db.connect()
      return {
        query: (sql: string, params?: unknown[]) => conn.query(sql, params),
        release: (err?: Error) => conn.release(err),
      }
    },
  } as unknown as Pool
}

function fullHarness(decision: Decision) {
  const db = new FakeTimesheetDb()
  const pool = fakeTimesheetPool(db)
  const dayRecords = new DayRecordRepository(db.asPool())
  const exceptions = new ExceptionRepository(db.asPool())
  const rosterRefs = new RosterRefRepository(db.asPool())
  const leaveRefs = new LeaveRefRepository(db.asPool())
  const otApprovalRefs = new OtApprovalRefRepository(db.asPool())
  const employeeRefs = new EmployeeRefRepository(db.asPool())
  const correctionAudits = new CorrectionAuditRepository(db.asPool())
  const periods = new PeriodRepository(db.asPool())
  const { client: configClient } = defaultTimesheetConfig()
  const consolidation = new ConsolidationService(dayRecords, exceptions, rosterRefs, leaveRefs, otApprovalRefs, employeeRefs, correctionAudits, configClient)
  const exceptionsService = new ExceptionsService(exceptions, dayRecords, periods, correctionAudits, consolidation)
  const periodService = new PeriodService(periods, exceptions)
  const views = new ViewsService(dayRecords, employeeRefs, exceptions)
  const authzClient = fakeAuthzClient(decision)
  const controller = new TimesheetController(pool, authzClient, views, exceptionsService, periodService)
  return { db, pool, dayRecords, employeeRefs, controller }
}

describe('TimesheetController /health', () => {
  it('reports db:up as overall status ok', async () => {
    const controller = new TimesheetController(fakePool(), fakeAuthzClient({ allowed: true, scopeOrgUnitIds: '*' }), {} as ViewsService, {} as ExceptionsService, {} as PeriodService)

    const out = await controller.health()

    expect(out).toMatchObject({ status: 'ok', service: 'svc-timesheet', dependencies: { db: 'up' } })
  })

  it('reports db:down as overall status degraded when the pool query rejects — not a crash', async () => {
    const pool = fakePool({ query: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as Pool['query'] })
    const controller = new TimesheetController(pool, fakeAuthzClient({ allowed: true, scopeOrgUnitIds: '*' }), {} as ViewsService, {} as ExceptionsService, {} as PeriodService)

    const out = await controller.health()

    expect(out).toMatchObject({ status: 'degraded', dependencies: { db: 'down' } })
  })

  it('health() has no @RequirePermission metadata — reachable without a permission', () => {
    const proto = TimesheetController.prototype as unknown as Record<string, () => unknown>
    const handler = proto['health']
    if (!handler) throw new Error('no such handler: health')
    expect(Reflect.getMetadata(PERMISSION_METADATA_KEY, handler)).toBeUndefined()
    expect(Reflect.getMetadata(PUBLIC_METADATA_KEY, handler)).toBe(true)
  })

  it('has no class-level @RequirePermission that could mask a future unannotated method', () => {
    expect(Reflect.getMetadata(PERMISSION_METADATA_KEY, TimesheetController)).toBeUndefined()
  })
})

describe('TimesheetController — every route but health declares exactly one @RequirePermission (brief CONSTRAINTS)', () => {
  const routeHandlers = [
    'myDays',
    'teamDays',
    'employeeDays',
    'exceptions',
    'proposeException',
    'confirmException',
    'manualPunch',
    'listPeriods',
    'createPeriod',
    'lockPeriod',
    'unlockPeriod',
    'exportPeriod',
    'otSummary',
  ] as const

  it.each(routeHandlers)('%s declares a @RequirePermission', (name) => {
    const proto = TimesheetController.prototype as unknown as Record<string, () => unknown>
    const handler = proto[name]
    if (!handler) throw new Error(`no such handler: ${name}`)
    expect(Reflect.getMetadata(PERMISSION_METADATA_KEY, handler)).toEqual(expect.any(String))
    expect(Reflect.getMetadata(PUBLIC_METADATA_KEY, handler)).toBeUndefined()
  })

  it('unlockPeriod requires timesheet.unlock — a DIFFERENT permission from lockPeriod\'s timesheet.lock (TC-M3-014: an HR Officer holding only timesheet.lock is denied)', () => {
    const proto = TimesheetController.prototype as unknown as Record<string, () => unknown>
    const lockPermission = Reflect.getMetadata(PERMISSION_METADATA_KEY, proto['lockPeriod'] as () => unknown)
    const unlockPermission = Reflect.getMetadata(PERMISSION_METADATA_KEY, proto['unlockPeriod'] as () => unknown)
    expect(lockPermission).toBe('timesheet.lock')
    expect(unlockPermission).toBe('timesheet.unlock')
    expect(unlockPermission).not.toBe(lockPermission)
  })
})

describe('TimesheetController — row scoping wiring (org-scope.ts)', () => {
  it('myDays is self-scoped by construction: always req.userId, regardless of any other input', async () => {
    const h = fullHarness({ allowed: true, scopeOrgUnitIds: '*' })
    await withTransaction(h.pool, (tx) => h.dayRecords.ensureExists(tx, 'emp-1', '2026-08-10', null))
    await withTransaction(h.pool, (tx) => h.dayRecords.ensureExists(tx, 'emp-2', '2026-08-10', null))

    const req: AuthenticatedRequest = { userId: 'emp-1' }
    const result = await h.controller.myDays(req, '2026-08-01', '2026-08-31')

    expect(result.days.map((d) => d.employeeId)).toEqual(['emp-1'])
  })

  it("teamDays refuses (TSH-070) a manager whose decide() scope does not cover the requested org unit — TC-M3-017's spirit, at the org-unit level", async () => {
    const h = fullHarness({ allowed: true, scopeOrgUnitIds: ['org-a'] })
    const req: AuthenticatedRequest = { userId: 'mgr-a' }

    await expect(h.controller.teamDays(req, 'org-b', '2026-08-01', '2026-08-31')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'TSH-070' }),
    })
  })

  it('teamDays succeeds and returns only the scoped org unit\'s employees when the scope matches', async () => {
    const h = fullHarness({ allowed: true, scopeOrgUnitIds: ['org-a'] })
    await withTransaction(h.pool, (tx) => h.employeeRefs.upsert(tx, { employeeId: 'emp-1', empCode: 'E1', orgUnitId: 'org-a', employmentType: 'monthly', status: 'active' }))
    await withTransaction(h.pool, (tx) => h.dayRecords.ensureExists(tx, 'emp-1', '2026-08-10', null))

    const req: AuthenticatedRequest = { userId: 'mgr-a' }
    const result = await h.controller.teamDays(req, 'org-a', '2026-08-01', '2026-08-31')

    expect(result.days.map((d) => d.employeeId)).toEqual(['emp-1'])
  })

  it("TC-M3-017: an employee (scope 'self') requesting another employee's days via the org-wide route is refused (403 TSH-071), reachable only via /my for their own", async () => {
    const h = fullHarness({ allowed: true, scopeOrgUnitIds: 'self' })
    const req: AuthenticatedRequest = { userId: 'emp-1' }

    await expect(h.controller.employeeDays(req, 'emp-2', '2026-08-01', '2026-08-31')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'TSH-071' }),
    })
  })

  it('scopeFor fails closed (403) if the second decide() call disagrees with an assumed allow', async () => {
    const h = fullHarness({ allowed: false, scopeOrgUnitIds: [] })
    const req: AuthenticatedRequest = { userId: 'mgr-a' }

    await expect(h.controller.teamDays(req, 'org-a', '2026-08-01', '2026-08-31')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'AUZ-403' }),
    })
  })
})

describe('TimesheetController — end-to-end route wiring (each route reaches the right service call)', () => {
  it('manualPunch (HR correction path, "same event pipeline") records a punch', async () => {
    const h = fullHarness({ allowed: true, scopeOrgUnitIds: '*' })
    const result = await h.controller.manualPunch({ employeeId: 'emp-1', punchedAt: '2026-08-10T09:00:00Z', direction: 'in' })
    expect(result.day.actualIn).toBe('2026-08-10T09:00:00Z')
  })

  it('createPeriod → listPeriods → lockPeriod → unlockPeriod, full round trip through the controller', async () => {
    const h = fullHarness({ allowed: true, scopeOrgUnitIds: '*' })
    const req: AuthenticatedRequest = { userId: 'hr-1' }

    const created = await h.controller.createPeriod({ from: '2026-08-01', to: '2026-08-31' })
    const listed = await h.controller.listPeriods()
    expect(listed.periods.map((p) => p.id)).toContain(created.period.id)

    const locked = await h.controller.lockPeriod(req, created.period.id)
    expect(locked.period.status).toBe('locked')
    expect(locked.period.lockVersion).toBe(1)

    const unlocked = await h.controller.unlockPeriod(req, created.period.id, { reason: 'correction needed' })
    expect(unlocked.varianceReportRequired).toBe(true)
  })

  it('propose → confirm through the controller applies a correction and returns the recomputed day', async () => {
    const h = fullHarness({ allowed: true, scopeOrgUnitIds: '*' })
    const day = await withTransaction(h.pool, (tx) => h.dayRecords.ensureExists(tx, 'emp-1', '2026-08-10', null))
    const excRepo = new ExceptionRepository(h.db.asPool())
    const exc = await withTransaction(h.pool, (tx) => excRepo.raise(tx, day.id, 'missed_punch', 'no out-punch recorded'))

    const mgrReq: AuthenticatedRequest = { userId: 'mgr-1' }
    await h.controller.proposeException(mgrReq, exc.id, {
      actualIn: '2026-08-10T09:00:00Z',
      actualOut: '2026-08-10T17:00:00Z',
      resolutionNote: 'confirmed by footage',
      reason: 'confirmed by footage',
    })

    const hrReq: AuthenticatedRequest = { userId: 'hr-1' }
    const confirmed = await h.controller.confirmException(hrReq, exc.id)
    expect(confirmed.dayRecord.status).toBe('corrected')
    expect(confirmed.exception.resolvedBy).toBe('hr-1')
  })

  it('exceptions() queue route: scoped to the caller\'s org unit', async () => {
    const h = fullHarness({ allowed: true, scopeOrgUnitIds: ['org-a'] })
    await withTransaction(h.pool, (tx) => h.employeeRefs.upsert(tx, { employeeId: 'emp-1', empCode: 'E1', orgUnitId: 'org-a', employmentType: 'monthly', status: 'active' }))
    const day = await withTransaction(h.pool, (tx) => h.dayRecords.ensureExists(tx, 'emp-1', '2026-08-10', null))
    const excRepo = new ExceptionRepository(h.db.asPool())
    await withTransaction(h.pool, (tx) => excRepo.raise(tx, day.id, 'late', '10 min'))

    const req: AuthenticatedRequest = { userId: 'mgr-a' }
    const result = await h.controller.exceptions(req, 'open', 'org-a')
    expect(result.exceptions).toHaveLength(1)
  })

  it('otSummary aggregates ot_15x/ot_2x/ot_3x across the scoped org unit', async () => {
    const h = fullHarness({ allowed: true, scopeOrgUnitIds: ['org-a'] })
    await withTransaction(h.pool, (tx) => h.employeeRefs.upsert(tx, { employeeId: 'emp-1', empCode: 'E1', orgUnitId: 'org-a', employmentType: 'monthly', status: 'active' }))
    await withTransaction(h.pool, (tx) => {
      return h.dayRecords.ensureExists(tx, 'emp-1', '2026-08-10', null).then((d) => h.dayRecords.updateComputed(tx, d.id, { workedHours: '10.00', lateMin: '0', ot15x: '2.00', ot2x: '0.00', ot3x: '0.00', status: 'ok' }))
    })

    const req: AuthenticatedRequest = { userId: 'mgr-a' }
    const summary = await h.controller.otSummary(req, '2026-08-01', '2026-08-31', 'org-a')
    expect(summary.totals.ot15x).toBe('2.00')
    expect(summary.employeeCount).toBe(1)
  })

  it('exportPeriod returns a locked-version snapshot scoped to the caller', async () => {
    const h = fullHarness({ allowed: true, scopeOrgUnitIds: '*' })
    const req: AuthenticatedRequest = { userId: 'hr-1' }
    const period = await h.controller.createPeriod({ from: '2026-08-01', to: '2026-08-31' })
    await h.controller.lockPeriod(req, period.period.id)

    const exported = await h.controller.exportPeriod(req, period.period.id)
    expect(exported.lockVersion).toBe(1)
    expect(Array.isArray(exported.rows)).toBe(true)
  })
})

describe('AppModule mounts the kernel PermissionGuard (svc-timesheet is reached by end users, per M3-TIMESHEET.md\'s permission-scoped API manual)', () => {
  it('registers an APP_GUARD provider bound to PermissionGuard', () => {
    const providers = (Reflect.getMetadata('providers', AppModule) as unknown[] | undefined) ?? []
    const appGuardEntry = providers.find((p) => isRecord(p) && p['provide'] === APP_GUARD)
    expect(appGuardEntry).toBeDefined()
  })

  it('registers a DB_POOL provider', () => {
    const providers = (Reflect.getMetadata('providers', AppModule) as unknown[] | undefined) ?? []
    const hasDbPool = providers.some((p) => isRecord(p) && p['provide'] === DB_POOL)
    expect(hasDbPool).toBe(true)
  })

  it('registers TimesheetController', () => {
    const controllers = (Reflect.getMetadata('controllers', AppModule) as unknown[] | undefined) ?? []
    expect(controllers).toContain(TimesheetController)
  })
})
