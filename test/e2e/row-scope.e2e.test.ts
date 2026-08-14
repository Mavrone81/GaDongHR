/**
 * Row-scoping fix (roadmap "🔴 Open security gap — permissions are too
 * coarse for row-level access") — the real-HTTP proof the task's brief
 * asks for: a scoped principal, real cross-org-unit denial.
 *
 * `PermissionGuard` (kernel) used to answer only "may this user perform
 * this action" — `svc-authz`'s `Decision.scopeOrgUnitIds` was computed and
 * thrown away. This suite proves the closed version end to end against
 * `svc-onboarding`'s `/employees*` routes (the service this fix reaches
 * most directly, since `onboarding.employee` IS the org-unit source of
 * truth — no cross-schema read model needed to prove the property):
 *
 *  - a manager granted `employee.read` scoped to ONE org unit can read an
 *    employee inside it, and is denied reading an employee in a DIFFERENT
 *    org unit — the exact "manager sees their team, not the whole company"
 *    case the roadmap names.
 *  - the same denial applies to an explicitly-named org unit on the list
 *    route, and a plain (unfiltered) list route silently returns only the
 *    in-scope rows, never the out-of-scope employee — the empty-vs-403
 *    split this fix's design deliberately makes (see `.superpowers/sdd/
 *    02-modules/row-scoping.md`).
 *
 * Self-contained: seeds its own org units/employees rather than reusing
 * `lifecycle.e2e.test.ts`'s module-scoped state, so it can run
 * independently of that suite's ordering or outcome.
 */
import { PORTS, PERSONAS, mintToken } from './harness'
import { grantScopedPermission, seedAuthzOrgUnit, seedOnboardingOrgAndPosition } from './lib/db'

const BASE = { onboarding: `http://127.0.0.1:${String(PORTS.onboarding)}` }

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the response shape genuinely differs per route; this is the test-helper boundary, not application code.
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

const ORG_A = '00000000-0000-4000-8000-0000000ac201'
const ORG_B = '00000000-0000-4000-8000-0000000ac202'
const POS_A = '00000000-0000-4000-8000-0000000ac203'
const POS_B = '00000000-0000-4000-8000-0000000ac204'
/** A fresh, fixed-UUID persona distinct from `harness.ts`'s `PERSONAS` — this test's whole point is a grant SCOPED to one org unit, which none of the standing personas hold. */
const MANAGER_SCOPED_TO_ORG_A = '00000000-0000-4000-8000-0000e2e00301'

function employeeBody(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    firstNameTh: 'ทดสอบ',
    lastNameTh: 'ขอบเขต',
    firstNameEn: 'RowScope',
    lastNameEn: 'Test',
    taxId: '1103700000003',
    bankAccount: '1234567890',
    bankCode: 'KBANK',
    dob: '1995-01-01',
    address: { houseNo: '1', subDistrict: 'Lumphini', district: 'Pathum Wan', province: 'Bangkok', postalCode: '10330' },
    phone: '0899999999',
    email: `e2e-rowscope-${String(Math.random()).slice(2)}@example.test`,
    employmentType: 'monthly',
    provinceCode: 'TH-10',
    startDate: '2026-08-01',
    preferredLang: 'th',
    ...overrides,
  }
}

let hrOfficerToken: string
let scopedManagerToken: string
let employeeInOrgA: string
let employeeInOrgB: string

beforeAll(async () => {
  hrOfficerToken = await mintToken(PERSONAS.hrOfficer)

  await seedOnboardingOrgAndPosition(ORG_A, POS_A)
  await seedOnboardingOrgAndPosition(ORG_B, POS_B)
  // The FK `authz.user_role.org_scope_unit_id` needs these to exist in
  // svc-authz's OWN org-unit read model too (see `seedAuthzOrgUnit`'s doc)
  // — a separate schema from `onboarding.org_unit` above (roadmap
  // "Database conventions": "No foreign keys across schemas").
  await seedAuthzOrgUnit(ORG_A, 'E2E Row-Scope Org A')
  await seedAuthzOrgUnit(ORG_B, 'E2E Row-Scope Org B')

  await grantScopedPermission(MANAGER_SCOPED_TO_ORG_A, 'employee.read', ORG_A, PERSONAS.seeder)
  scopedManagerToken = await mintToken(MANAGER_SCOPED_TO_ORG_A)

  const resA = await call('POST', `${BASE.onboarding}/employees`, hrOfficerToken, employeeBody({
    empCode: 'E2E-ROWSCOPE-A',
    nationalId: '1101700230708',
    orgUnitId: ORG_A,
    positionId: POS_A,
  }))
  if (resA.status >= 300) throw new Error(`row-scope e2e setup: creating employee in org A failed: ${String(resA.status)} ${JSON.stringify(resA.json)}`)
  employeeInOrgA = resA.json.id as string

  const resB = await call('POST', `${BASE.onboarding}/employees`, hrOfficerToken, employeeBody({
    empCode: 'E2E-ROWSCOPE-B',
    nationalId: '1902970000199',
    orgUnitId: ORG_B,
    positionId: POS_B,
  }))
  if (resB.status >= 300) throw new Error(`row-scope e2e setup: creating employee in org B failed: ${String(resB.status)} ${JSON.stringify(resB.json)}`)
  employeeInOrgB = resB.json.id as string
}, 30_000)

describe('row-scoping fix: GET /employees/:id (roadmap "🔴 Open security gap")', () => {
  test('a manager scoped to org A can read the employee inside org A', async () => {
    const res = await call('GET', `${BASE.onboarding}/employees/${employeeInOrgA}`, scopedManagerToken)
    expect(res.status).toBe(200)
    expect(res.json?.id).toBe(employeeInOrgA)
  })

  test('the SAME manager, scoped only to org A, is denied 403 ONB-070 reading the employee in org B — cross-org-unit denial, over real HTTP', async () => {
    const res = await call('GET', `${BASE.onboarding}/employees/${employeeInOrgB}`, scopedManagerToken)
    expect(res.status).toBe(403)
    expect(res.json?.code).toBe('ONB-070')
  })
})

describe('row-scoping fix: GET /employees (list route — filtered, not 403, for the unfiltered case)', () => {
  test('an explicit ?org_unit filter naming an out-of-scope unit is denied 403 ONB-071', async () => {
    const res = await call('GET', `${BASE.onboarding}/employees?org_unit=${ORG_B}`, scopedManagerToken)
    expect(res.status).toBe(403)
    expect(res.json?.code).toBe('ONB-071')
  })

  test('an unfiltered list for the scoped manager contains org A\'s employee and never org B\'s', async () => {
    const res = await call('GET', `${BASE.onboarding}/employees`, scopedManagerToken)
    expect(res.status).toBe(200)
    const ids = (res.json?.employees as Array<{ id: string }> | undefined)?.map((e) => e.id) ?? []
    expect(ids).toContain(employeeInOrgA)
    expect(ids).not.toContain(employeeInOrgB)
  })
})
