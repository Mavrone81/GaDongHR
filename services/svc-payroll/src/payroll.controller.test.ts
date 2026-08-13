import 'reflect-metadata'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { HttpException } from '@nestjs/common'
import { CryptoClient, PERMISSION_METADATA_KEY, PUBLIC_METADATA_KEY, writeOutbox } from '@gadong/kernel'
import type { Pool } from 'pg'
import { PayrollController } from './payroll.controller'
import type { HealthCheckPort } from './payroll.controller'
import { PayProfilesRepository } from './pay-profiles.repository'
import { PayProfilesService } from './pay-profiles.service'
import { PayInputsRepository } from './pay-inputs.repository'
import { PayslipsRepository } from './payslips.repository'
import { PayslipsService } from './payslips.service'
import { RefsRepository } from './refs.repository'
import { RunsRepository } from './runs.repository'
import { RunsService } from './runs.service'
import { ExportsRepository } from './exports.repository'
import { ExportsService } from './exports.service'
import { FinalPayService } from './final-pay.service'
import { FakePayrollDb } from './testing/fake-db'
import { fakeCryptoTransport } from './testing/fake-crypto-transport'
import { FakeDirectoryClient, FakeDocsClient, FakeTimesheetClient } from './testing/fake-ports'
import { PROVINCE_BANGKOK, seededConfig } from './testing/statutory-fixture'

/**
 * The HTTP boundary. Three things are asserted here and nowhere else:
 *
 *  1. `/health` degrades rather than crashing, and is the ONLY `@Public()`
 *     route.
 *  2. EVERY other route declares exactly one permission, and every one of
 *     those permissions exists in the roadmap's catalog — a route guarded
 *     by a permission no role can hold is a route nobody can reach, which
 *     is the defect the roadmap records against `document.read` and the two
 *     `notify.notification.*` codes.
 *  3. A `GadongError` from the service layer becomes its declared HTTP
 *     status and envelope — in particular, a preparer approving their own
 *     run comes back as a 409 `AUZ-409` rather than a 500.
 */

const ROADMAP = join(__dirname, '..', '..', '..', 'docs', 'superpowers', 'plans', '00-PROGRAM-ROADMAP.md')

const PREPARER = '11111111-1111-4111-8111-111111111111'
const APPROVER = '22222222-2222-4222-8222-222222222222'
const EMPLOYEE = '33333333-3333-4333-8333-333333333333'

function fakeHealthCheck(result: 'up' | 'down' = 'up'): HealthCheckPort {
  return { check: jest.fn().mockResolvedValue(result) }
}

async function controllerHarness(options: { dbDown?: boolean; crypto?: 'up' | 'down'; config?: 'up' | 'down' } = {}) {
  const db = new FakePayrollDb()
  const tx = db.connect()
  const configClient = seededConfig()
  const crypto = new CryptoClient(fakeCryptoTransport())

  const profilesRepo = new PayProfilesRepository(db.asPool())
  const runsRepo = new RunsRepository(db.asPool())
  const payslipsRepo = new PayslipsRepository(db.asPool())
  const payInputsRepo = new PayInputsRepository(db.asPool())
  const refsRepo = new RefsRepository(db.asPool())
  const exportsRepo = new ExportsRepository(db.asPool())
  const profilesService = new PayProfilesService(profilesRepo, refsRepo, crypto, configClient, () => randomUUID())
  const payslipsService = new PayslipsService(payslipsRepo, runsRepo, crypto)
  const directory = new FakeDirectoryClient()
  const exportsService = new ExportsService(
    runsRepo,
    payslipsRepo,
    profilesRepo,
    profilesService,
    refsRepo,
    exportsRepo,
    directory,
    configClient,
    crypto,
    () => randomUUID(),
  )
  const timesheets = new FakeTimesheetClient()
  const runsService = new RunsService(
    runsRepo,
    profilesRepo,
    profilesService,
    payslipsRepo,
    payInputsRepo,
    refsRepo,
    configClient,
    crypto,
    timesheets,
    new FakeDocsClient(),
    exportsService,
    () => randomUUID(),
    () => '2026-11-01T00:00:00.000Z',
  )
  const finalPay = new FinalPayService(refsRepo, profilesService, payInputsRepo, configClient, crypto, () => randomUUID())

  const pool = (
    options.dbDown === true ? { query: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')), connect: () => tx } : db
  ) as unknown as Pool

  const controller = new PayrollController(
    profilesService,
    runsService,
    payslipsService,
    finalPay,
    exportsService,
    pool,
    fakeHealthCheck(options.crypto ?? 'up'),
    fakeHealthCheck(options.config ?? 'up'),
  )

  await refsRepo.upsertEmployee(tx, {
    employeeId: EMPLOYEE,
    empCode: 'E-0001',
    status: 'active',
    provinceCode: PROVINCE_BANGKOK,
    startDate: '2020-01-01',
    preferredLang: 'th',
    orgUnitId: null,
    employmentType: 'full_time',
  })
  await refsRepo.upsertTimesheetLock(tx, { period: '2026-10', lockVersion: 7, locked: true, lockedBy: PREPARER })
  timesheets.seed('2026-10', 7, {})
  directory.seed(EMPLOYEE, { fullName: 'สมชาย ใจดี', nationalId: '1234567890123' })

  return { controller, db, tx, configClient, crypto, runsService, profilesService }
}

describe('GET /health', () => {
  it('reports ok with db, crypto and config all up', async () => {
    const { controller } = await controllerHarness()
    expect(await controller.health()).toMatchObject({
      status: 'ok',
      service: 'svc-payroll',
      dependencies: { db: 'up', crypto: 'up', config: 'up' },
    })
  })

  it('degrades — never crashes — when the database is unreachable', async () => {
    const { controller } = await controllerHarness({ dbDown: true })
    expect(await controller.health()).toMatchObject({ status: 'degraded', dependencies: { db: 'down' } })
  })

  it('degrades when svc-crypto is down: every money column depends on it, so this is the alarm that matters most', async () => {
    const { controller } = await controllerHarness({ crypto: 'down' })
    expect(await controller.health()).toMatchObject({ status: 'degraded', dependencies: { crypto: 'down' } })
  })

  it('degrades when svc-config is down: with no statutory figures the engine cannot compute anything', async () => {
    const { controller } = await controllerHarness({ config: 'down' })
    expect(await controller.health()).toMatchObject({ status: 'degraded', dependencies: { config: 'down' } })
  })

  it('reports outbox depth (event-bus health/metrics) — a fresh, undrained row is visible but not yet "stale"', async () => {
    const { controller, tx } = await controllerHarness()
    await writeOutbox(tx, 'payroll', 'payroll.committed', { runId: 'r1' })

    const health = await controller.health()
    expect(health.outbox).toMatchObject({ pending: 1, stale: false })
    expect(health.status).toBe('ok') // freshly-written, well under the staleness threshold
  })
})

describe('every route declares exactly one permission from the roadmap catalog; only /health is public', () => {
  const HANDLERS: Array<[string, keyof PayrollController, string | null]> = [
    ['GET /health', 'health', null],
    ['GET /profiles/:employeeId', 'getProfile', 'payroll.profile.read'],
    ['PUT /profiles/:employeeId', 'putProfile', 'payroll.profile.write'],
    ['POST /runs', 'createRun', 'payroll.run.prepare'],
    ['GET /runs', 'listRuns', 'payroll.run.prepare'],
    ['POST /runs/:id/calculate', 'calculate', 'payroll.run.calculate'],
    ['GET /runs/:id/variance', 'variance', 'payroll.run.approve'],
    ['POST /runs/:id/review', 'review', 'payroll.run.prepare'],
    ['POST /runs/:id/approve', 'approve', 'payroll.run.approve'],
    ['POST /runs/:id/commit', 'commit', 'payroll.run.commit'],
    ['POST /adjustment-runs', 'adjustmentRun', 'payroll.run.prepare'],
    ['GET /runs/:id/payslips', 'runPayslips', 'payslip.read.any'],
    ['GET /my/payslips', 'myPayslips', 'payslip.read.self'],
    ['POST /runs/:id/bank-file', 'bankFile', 'payroll.export'],
    ['POST /runs/:id/exports/:kind', 'statutoryExport', 'payroll.export'],
    ['POST /final-pay/:employeeId', 'finalPayAssessment', 'payroll.run.prepare'],
  ]

  /** The roadmap's permission catalog — the same list `svc-authz` seeds `PERMISSION_CATALOG` from. */
  function catalog(): Set<string> {
    const source = readFileSync(ROADMAP, 'utf8')
    const heading = source.indexOf('### Permission catalog')
    const block = source.slice(heading)
    const start = block.indexOf('\n```\n')
    const end = block.indexOf('\n```\n', start + 5)
    return new Set(
      block
        .slice(start + 5, end)
        .split(/\s+/)
        .filter((s) => s.length > 0),
    )
  }

  it.each(HANDLERS)('%s', (_label, handler, permission) => {
    const fn = PayrollController.prototype[handler] as unknown as object
    const declared: unknown = Reflect.getMetadata(PERMISSION_METADATA_KEY, fn)
    const isPublic: unknown = Reflect.getMetadata(PUBLIC_METADATA_KEY, fn)

    if (permission === null) {
      expect(isPublic).toBe(true)
      expect(declared).toBeUndefined()
      return
    }
    expect(isPublic).toBeUndefined()
    expect(declared).toBe(permission)
    expect(catalog().has(permission)).toBe(true)
  })

  it('/health is the ONLY public route', () => {
    const publics = HANDLERS.filter(
      ([, handler]) => Reflect.getMetadata(PUBLIC_METADATA_KEY, PayrollController.prototype[handler] as unknown as object) === true,
    )
    expect(publics.map(([label]) => label)).toEqual(['GET /health'])
  })

  it("none of the module doc's four uncatalogued permissions is used — they would be unreachable by any role", () => {
    const source = readFileSync(join(__dirname, 'payroll.controller.ts'), 'utf8')
    for (const absent of ['payroll.profile.manage', 'payroll.disburse', 'payroll.statutory.export', 'payroll.report']) {
      expect(source).not.toContain(`@RequirePermission('${absent}')`)
    }
  })
})

describe('service errors reach the client as their declared status and envelope', () => {
  async function preparedRun(h: Awaited<ReturnType<typeof controllerHarness>>) {
    await h.profilesService.upsert(
      h.tx,
      EMPLOYEE,
      {
        basePayThb: '45000',
        payBasis: 'monthly',
        recurringItems: [],
        pfRatePercent: null,
        pfRateEmployerPercent: null,
        declaration: null,
        bankCode: 'KBANK',
        bankAccount: '1234567890',
        bankAccountName: 'SOMCHAI J',
      },
      '2026-10-31',
    )
    const run = await h.runsService.createRun(h.tx, {
      period: '2026-10',
      runType: 'regular',
      preparedBy: PREPARER,
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      payDate: '2026-10-31',
    })
    await h.runsService.calculate(h.tx, run.id, [EMPLOYEE])
    await h.runsService.review(h.tx, run.id, PREPARER)
    return run
  }

  it('a preparer approving their own run is a 409 AUZ-409, not a 500', async () => {
    const h = await controllerHarness()
    const run = await preparedRun(h)

    await expect(h.controller.approve({ userId: PREPARER } as never, run.id)).rejects.toMatchObject({
      status: 409,
      response: { code: 'AUZ-409', message_i18n_key: 'authz.error.sod_violation' },
    })
  })

  it('a different approver succeeds through the same route', async () => {
    const h = await controllerHarness()
    const run = await preparedRun(h)
    expect(await h.controller.approve({ userId: APPROVER } as never, run.id)).toMatchObject({ status: 'approved', approvedBy: APPROVER })
  })

  it('an unauthenticated caller on a self-scoped route is 401, never an unscoped read', async () => {
    const h = await controllerHarness()
    await expect(h.controller.myPayslips({} as never)).rejects.toMatchObject({ status: 401, response: { code: 'PAY-401' } })
  })

  it('a sub-minimum wage on PUT /profiles is a 422 PAY-010 carrying the citation', async () => {
    const h = await controllerHarness()
    await expect(
      h.controller.putProfile(EMPLOYEE, {
        basePayThb: '11000',
        payBasis: 'monthly',
        recurringItems: [],
        pfRatePercent: null,
        pfRateEmployerPercent: null,
        declaration: null,
        bankCode: null,
        bankAccount: null,
        bankAccountName: null,
      }),
    ).rejects.toMatchObject({ status: 422, response: { code: 'PAY-010' } })
  })

  it('an export of an uncommitted run is a 409 PAY-050 — a filing of figures that may still change', async () => {
    const h = await controllerHarness()
    const run = await preparedRun(h)
    await expect(h.controller.statutoryExport(run.id, 'sso_1_10')).rejects.toMatchObject({ status: 409, response: { code: 'PAY-050' } })
  })

  it('an unknown export kind is refused before any lookup happens', async () => {
    const h = await controllerHarness()
    await expect(h.controller.statutoryExport('any', 'not_a_form')).rejects.toBeInstanceOf(HttpException)
  })

  it('an unknown bank format is a 422 PAY-051', async () => {
    const h = await controllerHarness()
    const run = await preparedRun(h)
    await h.runsService.approve(h.tx, run.id, APPROVER)
    await h.runsService.commit(h.tx, run.id)
    await expect(h.controller.bankFile(run.id, { format: 'citibank' })).rejects.toMatchObject({ status: 422, response: { code: 'PAY-051' } })
  })
})

describe('the read routes', () => {
  it('GET /runs lists every run, and filters by period when asked', async () => {
    const h = await controllerHarness()
    await h.profilesService.upsert(
      h.tx,
      EMPLOYEE,
      {
        basePayThb: '45000',
        payBasis: 'monthly',
        recurringItems: [],
        pfRatePercent: null,
        pfRateEmployerPercent: null,
        declaration: null,
        bankCode: null,
        bankAccount: null,
        bankAccountName: null,
      },
      '2026-10-31',
    )
    await h.runsService.createRun(h.tx, {
      period: '2026-10',
      runType: 'regular',
      preparedBy: PREPARER,
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      payDate: '2026-10-31',
    })
    expect((await h.controller.listRuns()).runs).toHaveLength(1)
    expect((await h.controller.listRuns('2026-10')).runs).toHaveLength(1)
    expect((await h.controller.listRuns('2026-11')).runs).toHaveLength(0)
  })

  it('GET /profiles returns the salary in the clear only to a caller who reached this route, with the bank account MASKED', async () => {
    const h = await controllerHarness()
    await h.profilesService.upsert(
      h.tx,
      EMPLOYEE,
      {
        basePayThb: '45000',
        payBasis: 'monthly',
        recurringItems: [],
        pfRatePercent: '5',
        pfRateEmployerPercent: '5',
        declaration: null,
        bankCode: 'KBANK',
        bankAccount: '1234567890',
        bankAccountName: 'SOMCHAI J',
      },
      '2026-10-31',
    )
    const view = await h.controller.getProfile(EMPLOYEE)
    expect(view).toMatchObject({ basePayThb: '45000.00', payBasis: 'monthly', pfRatePercent: '5', bankCode: 'KBANK' })
    expect(view.bankAccountMasked).toBe('******7890')
  })

  it('GET /my/payslips is self-scoped by construction: the employee id comes from the token, never the request', async () => {
    const h = await controllerHarness()
    const out = await h.controller.myPayslips({ userId: EMPLOYEE } as never)
    expect(out.payslips).toEqual([])
  })
})
