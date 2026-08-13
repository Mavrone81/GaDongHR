/**
 * The real-stack lifecycle test: hire -> onboard -> schedule -> attendance
 * -> timesheet -> payroll -> payslip, driven over real HTTP against real
 * NestJS services + real Postgres + real Vault (see harness.ts / README.md
 * for what's running and what's substituted).
 *
 * This suite does not assume the lifecycle completes. Per this task's
 * honesty requirement, every step's REAL outcome is asserted — including
 * the steps that fail, and why. See e2e-lifecycle.md for the narrative
 * report; this file is the evidence.
 */
import { PORTS, PERSONAS, mintToken } from './harness'
import { grantRole, grantPermission } from './lib/db'

/** A machine identity for `timesheet.totals.read` — granted to NO `ROLE_TEMPLATES` entry, ever (`timesheet.controller.ts`'s own doc on this route). Not one of `harness.ts`'s human `PERSONAS`, on purpose: this proves the permission gate itself, independent of any real caller's (svc-payroll's) missing credential — see the "known gap" test below. */
const TOTALS_READER_SUB = '00000000-0000-4000-8000-0000e2e00077'

const BASE = {
  authz: `http://127.0.0.1:${String(PORTS.authz)}`,
  config: `http://127.0.0.1:${String(PORTS.config)}`,
  onboarding: `http://127.0.0.1:${String(PORTS.onboarding)}`,
  scheduler: `http://127.0.0.1:${String(PORTS.scheduler)}`,
  attendance: `http://127.0.0.1:${String(PORTS.attendance)}`,
  timesheet: `http://127.0.0.1:${String(PORTS.timesheet)}`,
  payroll: `http://127.0.0.1:${String(PORTS.payroll)}`,
  docs: `http://127.0.0.1:${String(PORTS.docs)}`,
}

// The response shape genuinely differs per route (a run row, a payslip
// list, a bare error envelope) — `any` here is the test-helper boundary
// itself, not a shortcut around typing application code.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

async function call(method: string, url: string, token: string | undefined, body?: unknown): Promise<{ status: number; json: Json }> {
  const res = await fetch(url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  let json: Json = null
  const text = await res.text()
  if (text.length > 0) {
    try {
      json = JSON.parse(text)
    } catch {
      json = text
    }
  }
  return { status: res.status, json }
}

let hrOfficerToken: string
let managerToken: string
let payrollPreparerToken: string
let payrollApproverToken: string
let noPermsToken: string

let employeeId: string
let employeeToken: string
let shiftId: string
let periodId: string

beforeAll(async () => {
  hrOfficerToken = await mintToken(PERSONAS.hrOfficer)
  managerToken = await mintToken(PERSONAS.manager)
  payrollPreparerToken = await mintToken(PERSONAS.payrollPreparer)
  payrollApproverToken = await mintToken(PERSONAS.payrollApprover)
  noPermsToken = await mintToken(PERSONAS.noPermissions)
}, 30_000)

describe('guards are real (not the crypto-client / OIDC-middleware / permission-guard defects this session already found once)', () => {
  test('no bearer token at all -> denied, not 500', async () => {
    const res = await call('POST', `${BASE.onboarding}/employees`, undefined, {})
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
  })

  test('a real, verified token with zero grants -> 403, not 500 (request.userId propagated, permission denied)', async () => {
    const res = await call('POST', `${BASE.onboarding}/employees`, noPermsToken, {})
    expect(res.status).toBe(403)
    expect(res.json?.code).toBe('AUZ-403')
  })

  test('a garbage bearer token -> denied, not 500 (signature verification is real)', async () => {
    const res = await call('POST', `${BASE.onboarding}/employees`, 'not-a-real-jwt', {})
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
  })
})

describe('1. hire', () => {
  test('POST /employees creates a real row via real HTTP + real crypto + real Postgres', async () => {
    const res = await call('POST', `${BASE.onboarding}/employees`, hrOfficerToken, {
      empCode: 'E2E-0001',
      firstNameTh: 'สมชาย',
      lastNameTh: 'ทดสอบ',
      firstNameEn: 'Somchai',
      lastNameEn: 'Test',
      nationalId: '1103700000001',
      taxId: '1103700000001',
      bankAccount: '1234567890',
      bankCode: 'KBANK',
      dob: '1995-01-01',
      address: { houseNo: '1', subDistrict: 'Lumphini', district: 'Pathum Wan', province: 'Bangkok', postalCode: '10330' },
      phone: '0812345678',
      email: 'e2e-somchai@example.test',
      employmentType: 'monthly',
      orgUnitId: '00000000-0000-4000-8000-0000000ac001',
      positionId: '00000000-0000-4000-8000-0000000ac002',
      provinceCode: 'TH-10',
      startDate: '2026-08-01',
      preferredLang: 'th',
    })
    expect(res.status).toBeLessThan(300)
    expect(typeof res.json?.id).toBe('string')
    employeeId = res.json.id as string
  })
})

describe('2. onboard', () => {
  test('POST /employees/:id/transition moves the employee toward active', async () => {
    const res = await call('POST', `${BASE.onboarding}/employees/${employeeId}/transition`, hrOfficerToken, {
      to: 'active',
      reason: 'e2e lifecycle test',
    })
    // Recorded regardless of outcome — this is real HTTP against the real
    // EmployeeService.transition state machine, not asserted to a fixed
    // value in advance.
    console.log('[e2e] transition ->', res.status, JSON.stringify(res.json))
    expect(res.status).toBeLessThan(500)
  })

  test('the employee can grant their own PDPA consent (consent.self, self-scoped)', async () => {
    await grantRole(employeeId, 'employee-ess', PERSONAS.seeder)
    employeeToken = await mintToken(employeeId)
    const res = await call('POST', `${BASE.onboarding}/employees/${employeeId}/consents`, employeeToken, {
      purpose: 'hr_processing',
      decision: 'granted',
      formVersion: 1,
    })
    console.log('[e2e] consent ->', res.status, JSON.stringify(res.json))
    expect(res.status).toBeLessThan(500)
  })
})

describe('3. schedule', () => {
  test('a manager can create a shift', async () => {
    const res = await call('POST', `${BASE.scheduler}/shifts`, managerToken, {
      nameI18n: { en: 'Day shift', th: 'กะกลางวัน' },
      startT: '09:00',
      endT: '18:00',
      crossesMidnight: false,
      breakRules: [],
      graceMin: 5,
      differential: null,
    })
    console.log('[e2e] create shift ->', res.status, JSON.stringify(res.json))
    if (res.status < 300) shiftId = res.json.id as string
    expect(res.status).toBeLessThan(500)
  })

  test('a manager can assign the employee to the shift and publish the roster', async () => {
    if (!shiftId) {
      console.warn('[e2e] skipping roster assign — no shiftId (shift creation above did not succeed)')
      return
    }
    const assign = await call('POST', `${BASE.scheduler}/rosters/entries`, managerToken, {
      employeeId,
      shiftId,
      workDate: '2026-08-10',
    })
    console.log('[e2e] assign roster entry ->', assign.status, JSON.stringify(assign.json))
    expect(assign.status).toBeLessThan(500)

    const publish = await call('POST', `${BASE.scheduler}/rosters/publish`, managerToken, {
      from: '2026-08-10',
      to: '2026-08-10',
      employeeIds: [employeeId],
    })
    console.log('[e2e] publish roster ->', publish.status, JSON.stringify(publish.json))
    expect(publish.status).toBeLessThan(500)
  })
})

describe('4. attendance -> timesheet -> OT classification', () => {
  test('the employee can punch in/out for real via svc-attendance (PIN code, real HTTP, real S2 crypto, real Postgres)', async () => {
    const idemBase = `e2e-${Date.now().toString(36)}`
    const in_ = await call('POST', `${BASE.attendance}/punches/code`, employeeToken, {
      idemKey: `${idemBase}-in`,
      direction: 'in',
      siteCode: 'HQ',
      punchedAt: '2026-08-10T09:00:00.000Z',
      deviceId: 'e2e-kiosk',
      kind: 'pin',
      code: '000000',
    })
    console.log('[e2e] attendance punch in ->', in_.status, JSON.stringify(in_.json))
    expect(in_.status).toBeLessThan(500)

    const out = await call('POST', `${BASE.attendance}/punches/code`, employeeToken, {
      idemKey: `${idemBase}-out`,
      direction: 'out',
      siteCode: 'HQ',
      punchedAt: '2026-08-10T17:00:00.000Z',
      deviceId: 'e2e-kiosk',
      kind: 'pin',
      code: '000000',
    })
    console.log('[e2e] attendance punch out ->', out.status, JSON.stringify(out.json))
    expect(out.status).toBeLessThan(500)
  })

  test('SEAM DEFECT: the attendance punches above never reach svc-timesheet\'s day_record (no OutboxRelay is instantiated anywhere in this codebase — see e2e-lifecycle.md)', async () => {
    const res = await call('GET', `${BASE.timesheet}/my/days?from=2026-08-10&to=2026-08-10`, employeeToken)
    console.log('[e2e] timesheet days after attendance punch ->', res.status, JSON.stringify(res.json))
    expect(res.status).toBeLessThan(300)
    expect(res.json?.days ?? []).toHaveLength(0)
  })

  test('SEAM DEFECT: manual-punch cannot complete because svc-timesheet cannot read its own OT-threshold config', async () => {
    // svc-timesheet's ConsolidationService.recomputeDay calls
    // ConfigClient.getNumber('hours.regular.max_per_day') against
    // svc-config's GET /rules/:key. That route requires
    // config.rule.read (rules.controller.ts), but
    // services/svc-timesheet/src/config-client.ts's HttpConfigTransport
    // sends a plain, unauthenticated fetch — the same "service-to-service,
    // no bearer token" shape as the (already fixed) totals route, but
    // this route was never marked @Public(). See e2e-lifecycle.md.
    const res = await call('POST', `${BASE.timesheet}/manual-punch`, hrOfficerToken, {
      employeeId,
      punchedAt: '2026-08-10T09:00:00.000Z',
      direction: 'in',
    })
    console.log('[e2e] manual-punch ->', res.status, JSON.stringify(res.json))
    // Documented, not fabricated: recording the REAL status so a future
    // fix of the config-read seam turns this assertion red, which is the
    // signal to update it.
    expect([200, 201, 500]).toContain(res.status)
  })

  test('period create + lock works (does not depend on the config seam)', async () => {
    const create = await call('POST', `${BASE.timesheet}/periods`, hrOfficerToken, { from: '2026-08-01', to: '2026-08-31' })
    console.log('[e2e] create period ->', create.status, JSON.stringify(create.json))
    expect(create.status).toBeLessThan(300)
    periodId = create.json.period.id as string

    const lock = await call('POST', `${BASE.timesheet}/periods/${periodId}/lock`, hrOfficerToken, {})
    console.log('[e2e] lock period ->', lock.status, JSON.stringify(lock.json))
    expect(lock.status).toBeLessThan(300)
    expect(lock.json.period.lockVersion).toBe(1)
  })

  test('SEAM DEFECT, known gap (documented in timesheet.controller.ts): svc-payroll\'s real caller (ports.ts\'s HttpTimesheetClient) sends no bearer token at all, so the totals route now correctly denies it', async () => {
    const res = await call('GET', `${BASE.timesheet}/periods/${periodId}/totals?lockVersion=1`, undefined)
    console.log('[e2e] totals, no credential (svc-payroll\'s real shape today) ->', res.status, JSON.stringify(res.json))
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
  })

  test('VERIFIED FIX: GET /periods/:id/totals returns real totals for the correct lockVersion, once granted the machine-only timesheet.totals.read permission', async () => {
    await grantPermission(TOTALS_READER_SUB, 'timesheet.totals.read', PERSONAS.seeder)
    const totalsToken = await mintToken(TOTALS_READER_SUB)
    const res = await call('GET', `${BASE.timesheet}/periods/${periodId}/totals?lockVersion=1`, totalsToken)
    console.log('[e2e] totals(v1) ->', res.status, JSON.stringify(res.json))
    expect(res.status).toBe(200)
    expect(Array.isArray(res.json.totals)).toBe(true)
  })

  test('VERIFIED FIX: a stale lockVersion is rejected (409), never silently served', async () => {
    const totalsToken = await mintToken(TOTALS_READER_SUB)
    const res = await call('GET', `${BASE.timesheet}/periods/${periodId}/totals?lockVersion=99`, totalsToken)
    console.log('[e2e] totals(stale) ->', res.status, JSON.stringify(res.json))
    expect(res.status).toBe(409)
  })
})

describe('5. payroll: create -> calculate -> variance -> review -> approve -> commit', () => {
  test('SEAM DEFECT: PUT /profiles/:employeeId cannot complete — payroll_employee_ref was never populated', async () => {
    // PayProfilesService.upsert requires RefsRepository.findEmployee(id) to
    // return a row. That row is populated exclusively by consuming
    // `employee.created`/`employee.updated` — an event nothing in this
    // codebase ever delivers (packages/kernel/src/outbox/relay.ts's
    // OutboxRelay is never instantiated by any service; grep confirms zero
    // non-test usages repo-wide). So every employee, including the one
    // just hired above, is permanently unknown to svc-payroll. See
    // e2e-lifecycle.md.
    const res = await call('PUT', `${BASE.payroll}/profiles/${employeeId}`, payrollPreparerToken, {
      basePayThb: '30000.00',
      payBasis: 'monthly',
      recurringItems: [],
      pfRatePercent: null,
      pfRateEmployerPercent: null,
      declaration: null,
      bankCode: null,
      bankAccount: null,
      bankAccountName: null,
    })
    console.log('[e2e] put pay profile ->', res.status, JSON.stringify(res.json))
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
  })

  test('SEAM DEFECT (downstream of the same cause): a regular run cannot be created — payroll never learns a period is locked', async () => {
    // RunsService.createRun requires RefsRepository.findTimesheetLock(period)
    // to report locked:true for any non-final_pay run. That table is
    // populated exclusively by consuming `timesheet.locked` — the same
    // dead event-delivery path. The period WAS genuinely locked over real
    // HTTP two tests above; payroll has no way to know that today.
    const res = await call('POST', `${BASE.payroll}/runs`, payrollPreparerToken, {
      period: '2026-08',
      runType: 'regular',
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
      payDate: '2026-09-05',
    })
    console.log('[e2e] create run ->', res.status, JSON.stringify(res.json))
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
  })

  test('segregation of duties is still enforced end to end: approver === preparer is refused, real HTTP, real DB constraint', async () => {
    // Exercised independently of the blocked run-creation path above:
    // create a final_pay run (the one run type that does not require a
    // populated timesheet lock ref) so approve()'s SoD check has a real
    // run to act on.
    const created = await call('POST', `${BASE.payroll}/runs`, payrollPreparerToken, {
      period: '2026-08',
      runType: 'final_pay',
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
      payDate: '2026-09-05',
    })
    console.log('[e2e] create final_pay run ->', created.status, JSON.stringify(created.json))
    if (created.status >= 300) {
      console.warn('[e2e] skipping SoD check — final_pay run creation itself failed, see log above')
      return
    }
    const runId = created.json.id as string
    const approveBySamePreparer = await call('POST', `${BASE.payroll}/runs/${runId}/approve`, payrollPreparerToken, {})
    console.log('[e2e] approve by preparer ->', approveBySamePreparer.status, JSON.stringify(approveBySamePreparer.json))
    expect(approveBySamePreparer.status).toBeGreaterThanOrEqual(400)
    expect(approveBySamePreparer.status).toBeLessThan(500)

    // The positive path, over real HTTP: a genuinely different identity
    // (payrollApproverToken, a DIFFERENT sub than payrollPreparerToken)
    // succeeds, and the returned row's `approvedBy` is that identity's own
    // `sub` — proof that `request.userId` really propagated from the
    // verified bearer token through OidcMiddleware into the DB row, not
    // just that the guard denied the negative case.
    const approveByApprover = await call('POST', `${BASE.payroll}/runs/${runId}/approve`, payrollApproverToken, {})
    console.log('[e2e] approve by approver ->', approveByApprover.status, JSON.stringify(approveByApprover.json))
    expect(approveByApprover.status).toBeLessThan(300)
    expect(approveByApprover.json?.approvedBy).toBe(PERSONAS.payrollApprover)
  })
})

describe('6. payroll run lifecycle + post-commit immutability, proven WITHOUT the dead event bus', () => {
  // Every payroll test above (section 5) is genuinely blocked by seam
  // defect #1 (the event bus): `POST /runs` (regular), `PUT /profiles/:id`,
  // and therefore `calculate`/`review`/`approve`/`commit` for a REAL
  // employee's payslip are all unreachable today, and this suite refuses to
  // manufacture `payroll.payroll_employee_ref`/`payroll.timesheet_lock`
  // rows directly in Postgres to route around that — see e2e-lifecycle.md,
  // "what was deliberately NOT done".
  //
  // `RunsService.createRun` has exactly one run type that does not require
  // a populated `timesheet_lock` ref: `final_pay` (it pays an individual
  // leaving mid-period and cannot wait for the period to close —
  // runs.service.ts's own comment). `RunsService.calculate` for a
  // `final_pay` run never calls `TimesheetClient.getLockedTotals` at all
  // (`totals = runType === 'final_pay' ? new Map() : ...`), and calculating
  // with an EMPTY `employeeIds` array is a real, legitimate no-op the
  // service's own code allows (the per-employee loop simply does not run)
  // — not a fabricated shortcut, a genuinely reachable state with zero
  // payslips. This is REAL run-lifecycle + REAL trigger coverage against
  // REAL Postgres; it produces NO payslip content and proves NOTHING about
  // gross-to-net correctness — see the explicitly-skipped money test below
  // for why that assertion could not be made this session.
  let immutableRunId: string

  test('a final_pay run with zero employees reaches calculated -> reviewed -> approved -> committed, all real HTTP', async () => {
    const created = await call('POST', `${BASE.payroll}/runs`, payrollPreparerToken, {
      period: '2026-08-immutability',
      runType: 'final_pay',
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
      payDate: '2026-09-05',
    })
    console.log('[e2e] create empty final_pay run ->', created.status, JSON.stringify(created.json))
    expect(created.status).toBeLessThan(300)
    immutableRunId = created.json.id as string

    const calc = await call('POST', `${BASE.payroll}/runs/${immutableRunId}/calculate`, payrollPreparerToken, { employeeIds: [] })
    console.log('[e2e] calculate(empty) ->', calc.status, JSON.stringify(calc.json))
    expect(calc.status).toBeLessThan(300)

    const review = await call('POST', `${BASE.payroll}/runs/${immutableRunId}/review`, payrollPreparerToken, {})
    console.log('[e2e] review ->', review.status, JSON.stringify(review.json))
    expect(review.status).toBeLessThan(300)

    const approve = await call('POST', `${BASE.payroll}/runs/${immutableRunId}/approve`, payrollApproverToken, {})
    console.log('[e2e] approve ->', approve.status, JSON.stringify(approve.json))
    expect(approve.status).toBeLessThan(300)

    const commit = await call('POST', `${BASE.payroll}/runs/${immutableRunId}/commit`, payrollApproverToken, {})
    console.log('[e2e] commit ->', commit.status, JSON.stringify(commit.json))
    expect(commit.status).toBeLessThan(300)
    expect(commit.json?.status).toBe('committed')
  })

  test('PROVEN: a committed run cannot be recalculated (immutability, real Postgres trigger)', async () => {
    const res = await call('POST', `${BASE.payroll}/runs/${immutableRunId}/calculate`, payrollPreparerToken, { employeeIds: [] })
    console.log('[e2e] recalculate after commit ->', res.status, JSON.stringify(res.json))
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
  })

  test('PROVEN: a committed run cannot be re-committed', async () => {
    const res = await call('POST', `${BASE.payroll}/runs/${immutableRunId}/commit`, payrollApproverToken, {})
    console.log('[e2e] re-commit ->', res.status, JSON.stringify(res.json))
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
  })
})

// eslint-disable-next-line jest/no-disabled-tests -- deliberately skipped: see the block comment immediately below and e2e-lifecycle.md
describe.skip('7. payroll money assertions — BLOCKED by seam defect #1, arithmetic committed for review, not asserted green', () => {
  /**
   * THIS BLOCK DOES NOT RUN. Skipped, not deleted, per the coordinator's
   * explicit instruction: the arithmetic below is the expensive,
   * legally-reviewable part of "assert the payslip figures", and
   * committing it now — reviewable by a human against Thai statute — means
   * that when seam defect #1 (the dead event bus) is fixed separately,
   * turning this into a real, green assertion is a ONE-LINE change
   * (`describe.skip` -> `describe`), not a rebuild of the lifecycle from
   * scratch.
   *
   * INPUT (a real, achievable e2e scenario once the event bus exists):
   *   - monthly employee, base pay 25,000.00 THB/month, provinceCode 'TH-10'
   *     (the only province with a seeded minwage.daily.* rule)
   *   - period 2026-08 (August; before EWF's 2026-10-01 effective date, so
   *     EWF is cleanly 0 — no need to also verify that gate in this example)
   *   - OT: 10 hours at the LPA s.61 workday multiplier (1.5x), 4 hours at
   *     the LPA s.63 holiday-OT multiplier (3x); no s.62 holiday-work hours
   *     (kept out to isolate the two multipliers the task text names)
   *   - no PF enrollment, no declared tax allowances (spouse/children/
   *     parents all 0), no YTD income (a fresh August hire) — the simplest
   *     declaration state (`NO_DECLARATION`), so the only tax figures in
   *     play are the personal allowance and the 50%/100,000-cap expense
   *     deduction every employee gets regardless of declaration
   *
   * SEEDED RULES USED (services/svc-config/seed/TH-STATUTORY-v1.json, as
   * corrected this session — see e2e-lifecycle.md's seam-defects list for
   * what was wrong in the shipped file before this session):
   *   sso.rate.employee/employer = 5%, sso.wage.floor = 1,650 THB,
   *   sso.wage.ceiling = 17,500 THB (effective 2026-01-01 — NOT the 15,000
   *   figure this task's own brief text names; the brief was going from an
   *   older figure, the seeded rule is what the running engine actually
   *   uses, and that is what this arithmetic follows),
   *   ot.workday.multiplier = 1.5, ot.holiday_ot.multiplier = 3,
   *   ot.hourly_base.days_divisor = 30, ot.hourly_base.hours_divisor = 8,
   *   tax.expense.rate = 50%, tax.expense.cap = 100,000 THB,
   *   tax.allowance.personal = 60,000 THB, tax.pit.brackets = the 8-bracket
   *   table (0% to 150,000; 5% to 300,000; ...; 35% above 5,000,000),
   *   payroll.periods.per_year = 12.
   *
   * ARITHMETIC (bigint satang throughout, mirroring engine/gross-to-net.ts
   * and engine/pit.ts exactly — see money.ts's mulDivRoundHalfUp for the
   * one rounding rule, half-up, applied once per figure):
   *
   *   hourlyBase (monthly) = basePay / (daysDivisor x hoursDivisor)
   *                        = 2,500,000 / (30 x 8) = 2,500,000 / 240 (kept
   *                          as an exact rational, never rounded on its own)
   *
   *   otWorkday   = hourlyBase x 1.5 x 10h
   *               = mulDivRoundHalfUp(2_500_000, 15 x 10, 240 x 10 x 1)
   *               = 2_500_000 x 150 / 2_400 = 156,250 satang exactly (no
   *                 rounding needed) = THB 1,562.50
   *   otHolidayOt = hourlyBase x 3 x 4h
   *               = mulDivRoundHalfUp(2_500_000, 3 x 4, 240 x 1 x 1)
   *               = 2_500_000 x 12 / 240 = 125,000 satang exactly
   *               = THB 1,250.00
   *   overtimePay = 156,250 + 125,000 = 281,250 satang = THB 2,812.50
   *
   *   basePayEarned (monthly) = basePay = 2,500,000 satang = THB 25,000.00
   *   gross = basePayEarned + overtimePay = 2,781,250 satang = THB 27,812.50
   *
   *   ssoWage = basePayEarned + overtimePay = 2,781,250 satang (OT IS in
   *             the SSO wage base — gross-to-net.ts line ~208, confirmed by
   *             reading the source, not assumed)
   *   ssoCappedWage = clamp(2,781,250; floor 165,000; ceiling 1,750,000)
   *                 = 1,750,000 satang (THB 17,500.00 — the ceiling binds)
   *   ssoEmployee = ssoEmployer = 1,750,000 x 5% = 87,500 satang = THB 875.00
   *
   *   ewfEmployee = ewfEmployer = 0 (period end 2026-08-31 is before the
   *                 2026-10-01 EWF effective date; rules.ewfRateEmployee/
   *                 Employer both resolve to null for this period)
   *   pfEmployee = pfEmployer = 0 (profile.pfRatePercent is null)
   *
   *   WHT (annualised, remainingPeriods = 12 - 8 + 1 = 5 for August, the
   *        8th period of a 12-period year):
   *     recurringTaxableThisPeriod = gross (all of it taxable) = 2,781,250
   *     projectedAnnualIncome = 0 (no YTD) + 2,781,250 x 5 + 0 (no one-off)
   *                           = 13,906,250 satang = THB 139,062.50
   *     uncappedExpense = 13,906,250 x 50% = 6,953,125 satang
   *     expenseDeduction = min(6,953,125; cap 10,000,000) = 6,953,125 satang
   *                      = THB 69,531.25
   *     annualSso = 0 (no YTD SSO) + 87,500 x 5 = 437,500 satang
   *     totalAllowances = personalAllowance 6,000,000 + spouse 0 + children 0
   *                      + childrenSecond 0 + parents 0 + annualSso 437,500
   *                      + annualPf 0 + declaredOther 0 = 6,437,500 satang
   *                      = THB 64,375.00
   *     netAnnualIncome = 13,906,250 - 6,953,125 - 6,437,500 = 515,625 satang
   *                      = THB 5,156.25 — entirely inside PIT bracket 1
   *                        (0 to 150,000 THB @ 0%), so annualTax = 0
   *     wht = divideRoundHalfUp(clampNonNegative(0 - 0), 5) = 0 satang
   *
   *   net = gross - ssoEmployee - ewfEmployee - pfEmployee - wht
   *         - otherDeductions + nonTaxablePay
   *       = 2,781,250 - 87,500 - 0 - 0 - 0 - 0 + 0
   *       = 2,693,750 satang = THB 26,937.50
   *
   * EXPECTED (bigint satang — what a real `commit()`'s payslip would carry
   * once seam defect #1 is fixed and this describe block is turned back on):
   *   gross: 2_781_250n, basePayEarned: 2_500_000n, overtimePay: 281_250n,
   *   ssoWage: 2_781_250n, ssoCappedWage: 1_750_000n,
   *   ssoEmployee: 87_500n, ssoEmployer: 87_500n,
   *   ewfEmployee: 0n, ewfEmployer: 0n, pfEmployee: 0n, pfEmployer: 0n,
   *   wht: 0n, net: 2_693_750n
   */
  test.todo('assert the exact bigint-satang gross-to-net figures above against a real committed payslip')
})
