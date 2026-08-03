import { AuditEmitter, CryptoClient } from '@gadong/kernel'
import { ConsentService } from './consent.service'
import { ConsentRepository } from './consent.repository'
import { EmployeeRepository } from './employee.repository'
import { EmployeeService } from './employee.service'
import { ChecklistService, SSO_DEADLINE_RULE_KEY } from './checklist.service'
import { OnboardingTaskRepository } from './onboarding-task.repository'
import { ProbationRepository } from './probation.repository'
import { FakeOnboardingDb } from './testing/fake-db'
import { fakeCryptoTransport } from './testing/fake-crypto-transport'
import { fakeConfigClient } from './testing/fake-config-client'
import type { CreateEmployeeInput } from './employee.service'

function makeHarness() {
  const db = new FakeOnboardingDb()
  const employeeRepo = new EmployeeRepository(db.asPool())
  const taskRepo = new OnboardingTaskRepository(db.asPool())
  const probationRepo = new ProbationRepository(db.asPool())
  const consentRepo = new ConsentRepository(db.asPool())
  const crypto = new CryptoClient(fakeCryptoTransport())
  const checklist = new ChecklistService(taskRepo, fakeConfigClient({ [SSO_DEADLINE_RULE_KEY]: 30 }))
  const audit = new AuditEmitter()
  const employeeService = new EmployeeService(employeeRepo, crypto, checklist, probationRepo, audit)
  const consentService = new ConsentService(consentRepo, employeeRepo, employeeService, crypto, audit)

  db.seedConsentForm({ purpose: 'hr_processing', lang: 'th', version: 1, body_text: 'HR processing notice, Thai, v1' })
  db.seedConsentForm({ purpose: 'biometric', lang: 'th', version: 1, body_text: 'Biometric consent notice, Thai, v1 — attendance only, revocable any time' })

  return { db, employeeService, consentService, employeeRepo }
}

function validInput(overrides: Partial<CreateEmployeeInput> = {}): CreateEmployeeInput {
  return {
    empCode: 'EMP-0001', firstNameTh: 'สมชาย', lastNameTh: 'ใจดี', firstNameEn: 'Somchai', lastNameEn: 'Jaidee',
    nationalId: '1101700230708', taxId: '1234567890123', ssoNumber: '1234567890', bankAccount: '1112223334', bankCode: 'KTB',
    dob: '1990-01-15', address: { houseNo: '99/9', subDistrict: 'Lumphini', district: 'Pathum Wan', province: 'Bangkok', postalCode: '10330' },
    phone: '0812345678', email: 'somchai.jaidee@example.com', employmentType: 'monthly', orgUnitId: 'org-1', positionId: 'pos-1',
    provinceCode: 'TH-10', startDate: '2026-09-01', preferredLang: 'th',
    ...overrides,
  }
}

async function createEmployee(harness: ReturnType<typeof makeHarness>, overrides: Partial<CreateEmployeeInput> = {}) {
  const prepared = await harness.employeeService.prepareCreate(validInput(overrides))
  const conn = harness.db.connect()
  await conn.query('BEGIN')
  const { id } = await harness.employeeService.commitCreate(conn, prepared, 'hr-1', 'hr-officer')
  await conn.query('COMMIT')
  return id
}

describe('ConsentService — ONB-020: biometric consent must be a separate submission', () => {
  it('rejects a single call bundling biometric with the general HR-processing notice', async () => {
    const harness = makeHarness()
    const id = await createEmployee(harness)

    await expect(
      harness.consentService.prepareDecision(id, { purpose: ['hr_processing', 'biometric'], decision: 'granted', formVersion: 1 }),
    ).rejects.toMatchObject({ code: 'ONB-020' })
  })

  it('accepts biometric alone', async () => {
    const harness = makeHarness()
    const id = await createEmployee(harness)
    const prepared = await harness.consentService.prepareDecision(id, { purpose: 'biometric', decision: 'granted', formVersion: 1 })
    expect(prepared).toHaveLength(1)
    expect(prepared[0]?.purpose).toBe('biometric')
  })

  it('accepts hr_processing alone', async () => {
    const harness = makeHarness()
    const id = await createEmployee(harness)
    const prepared = await harness.consentService.prepareDecision(id, { purpose: 'hr_processing', decision: 'granted', formVersion: 1 })
    expect(prepared).toHaveLength(1)
  })
})

describe('ConsentService — biometric GRANT', () => {
  it('records a granted state, sets clock_in_method to biometric, and publishes consent.granted', async () => {
    const harness = makeHarness()
    const id = await createEmployee(harness)

    const prepared = await harness.consentService.prepareDecision(id, { purpose: 'biometric', decision: 'granted', formVersion: 1 })
    const conn = harness.db.connect()
    await conn.query('BEGIN')
    await harness.consentService.commitDecision(conn, prepared, 'emp-self', 'employee-ess')
    await conn.query('COMMIT')

    expect(await harness.consentService.currentState(id, 'biometric')).toBe('granted')
    expect(harness.db.debugEmployees().find((e) => e.id === id)?.clock_in_method).toBe('biometric')

    const granted = harness.db.debugOutboxRows().find((r) => r.topic === 'consent.granted')
    expect(granted?.payload).toMatchObject({ employeeId: id, purpose: 'biometric', formVersion: 1 })
  })
})

describe('ConsentService — biometric REFUSAL (the compliance-critical path)', () => {
  it('the refusal path completes successfully — same as a grant — and sets the alternative-method flag', async () => {
    const harness = makeHarness()
    const id = await createEmployee(harness)

    const prepared = await harness.consentService.prepareDecision(id, { purpose: 'biometric', decision: 'refused', formVersion: 1 })
    const conn = harness.db.connect()
    await conn.query('BEGIN')
    const records = await harness.consentService.commitDecision(conn, prepared, 'emp-self', 'employee-ess')
    await conn.query('COMMIT')

    // completes successfully — no exception, a real consent_record row exists
    expect(records).toHaveLength(1)
    expect(records[0]?.state).toBe('refused')
    expect(await harness.consentService.currentState(id, 'biometric')).toBe('refused')

    // the employee is switched to the alternative clock-in method
    expect(harness.db.debugEmployees().find((e) => e.id === id)?.clock_in_method).toBe('alternative')
  })

  it('a refusal does NOT publish consent.granted (or any event) — there is no consent.refused event in the catalog', async () => {
    const harness = makeHarness()
    const id = await createEmployee(harness)

    const prepared = await harness.consentService.prepareDecision(id, { purpose: 'biometric', decision: 'refused', formVersion: 1 })
    const conn = harness.db.connect()
    await conn.query('BEGIN')
    await harness.consentService.commitDecision(conn, prepared, 'emp-self', 'employee-ess')
    await conn.query('COMMIT')

    expect(harness.db.debugOutboxRows().filter((r) => r.topic.startsWith('consent.'))).toHaveLength(0)
  })

  it('no column anywhere in the stored consent_record or employee row encodes an adverse flag — refusal and grant are structurally symmetric writes', async () => {
    const harness = makeHarness()
    const id = await createEmployee(harness)

    const prepared = await harness.consentService.prepareDecision(id, { purpose: 'biometric', decision: 'refused', formVersion: 1 })
    const conn = harness.db.connect()
    await conn.query('BEGIN')
    await harness.consentService.commitDecision(conn, prepared, 'emp-self', 'employee-ess')
    await conn.query('COMMIT')

    const employeeRow = harness.db.debugEmployees().find((e) => e.id === id)
    const consentRow = harness.db.debugConsentRecords().find((r) => r.employee_id === id && r.purpose === 'biometric')
    // Every column name on both rows — none of them spell "adverse", "flag",
    // "denied", "penalty", or "blocked". `clock_in_method`/`state` are the
    // only two that differ between a grant and a refusal, and both are
    // neutral, symmetric vocabulary ('biometric'|'alternative', 'granted'|
    // 'refused') — never a boolean "isAdverse"-shaped column.
    const employeeColumns = Object.keys(employeeRow ?? {})
    const consentColumns = Object.keys(consentRow ?? {})
    for (const col of [...employeeColumns, ...consentColumns]) {
      expect(col).not.toMatch(/adverse|penalty|denied|blocked|flagged/i)
    }
  })

  it('refusal and grant produce the SAME shape of successful result — proves refusal is not a degraded/partial path', async () => {
    const harness = makeHarness()
    const grantedId = await createEmployee(harness, { empCode: 'EMP-GRANT', nationalId: '1101700230708' })
    const refusedId = await createEmployee(harness, { empCode: 'EMP-REFUSE', nationalId: '3109900764416' })

    const conn = harness.db.connect()

    const grantedPrepared = await harness.consentService.prepareDecision(grantedId, { purpose: 'biometric', decision: 'granted', formVersion: 1 })
    await conn.query('BEGIN')
    const grantedRecords = await harness.consentService.commitDecision(conn, grantedPrepared, 'emp-self', 'employee-ess')
    await conn.query('COMMIT')

    const refusedPrepared = await harness.consentService.prepareDecision(refusedId, { purpose: 'biometric', decision: 'refused', formVersion: 1 })
    await conn.query('BEGIN')
    const refusedRecords = await harness.consentService.commitDecision(conn, refusedPrepared, 'emp-self', 'employee-ess')
    await conn.query('COMMIT')

    expect(Object.keys(grantedRecords[0] ?? {}).sort()).toEqual(Object.keys(refusedRecords[0] ?? {}).sort())
    expect(grantedRecords[0]?.id).toBeDefined()
    expect(refusedRecords[0]?.id).toBeDefined()
  })
})

describe('ConsentService — one-tap withdrawal (PDPA §4.4)', () => {
  it('ONB-024 when there is nothing granted to withdraw', async () => {
    const harness = makeHarness()
    const id = await createEmployee(harness)
    await expect(harness.consentService.prepareWithdraw(id)).rejects.toMatchObject({ code: 'ONB-024' })
  })

  it('withdraws a granted biometric consent: records "withdrawn", flips clock_in_method to alternative, publishes consent.withdrawn', async () => {
    const harness = makeHarness()
    const id = await createEmployee(harness)
    const conn = harness.db.connect()

    const grantPrepared = await harness.consentService.prepareDecision(id, { purpose: 'biometric', decision: 'granted', formVersion: 1 })
    await conn.query('BEGIN')
    await harness.consentService.commitDecision(conn, grantPrepared, 'emp-self', 'employee-ess')
    await conn.query('COMMIT')
    expect(harness.db.debugEmployees().find((e) => e.id === id)?.clock_in_method).toBe('biometric')

    const withdrawPrepared = await harness.consentService.prepareWithdraw(id)
    await conn.query('BEGIN')
    await harness.consentService.commitWithdraw(conn, withdrawPrepared, 'emp-self', 'employee-ess')
    await conn.query('COMMIT')

    expect(await harness.consentService.currentState(id, 'biometric')).toBe('withdrawn')
    expect(harness.db.debugEmployees().find((e) => e.id === id)?.clock_in_method).toBe('alternative')
    const withdrawn = harness.db.debugOutboxRows().find((r) => r.topic === 'consent.withdrawn')
    expect(withdrawn?.payload).toMatchObject({ employeeId: id, purpose: 'biometric' })
  })

  it('ONB-024 when the current state is already withdrawn (cannot double-withdraw)', async () => {
    const harness = makeHarness()
    const id = await createEmployee(harness)
    const conn = harness.db.connect()

    const grantPrepared = await harness.consentService.prepareDecision(id, { purpose: 'biometric', decision: 'granted', formVersion: 1 })
    await conn.query('BEGIN')
    await harness.consentService.commitDecision(conn, grantPrepared, 'emp-self', 'employee-ess')
    await conn.query('COMMIT')

    const withdrawPrepared = await harness.consentService.prepareWithdraw(id)
    await conn.query('BEGIN')
    await harness.consentService.commitWithdraw(conn, withdrawPrepared, 'emp-self', 'employee-ess')
    await conn.query('COMMIT')

    await expect(harness.consentService.prepareWithdraw(id)).rejects.toMatchObject({ code: 'ONB-024' })
  })
})

describe('ConsentService — ONB-023 unknown form version/purpose', () => {
  it('rejects a decision naming a form version that was never seeded', async () => {
    const harness = makeHarness()
    const id = await createEmployee(harness)
    await expect(
      harness.consentService.prepareDecision(id, { purpose: 'hr_processing', decision: 'granted', formVersion: 99 }),
    ).rejects.toMatchObject({ code: 'ONB-023' })
  })
})
