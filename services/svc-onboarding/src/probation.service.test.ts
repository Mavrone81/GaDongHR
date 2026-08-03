import { AuditEmitter, CryptoClient } from '@gadong/kernel'
import { ProbationService, PROBATION_ALERT_DAYS_FIRST, PROBATION_ALERT_DAYS_SECOND } from './probation.service'
import { ProbationRepository } from './probation.repository'
import { EmployeeRepository } from './employee.repository'
import { EmployeeService } from './employee.service'
import { ChecklistService, SSO_DEADLINE_RULE_KEY } from './checklist.service'
import { OnboardingTaskRepository } from './onboarding-task.repository'
import { FakeOnboardingDb } from './testing/fake-db'
import { fakeCryptoTransport } from './testing/fake-crypto-transport'
import { fakeConfigClient } from './testing/fake-config-client'
import type { CreateEmployeeInput } from './employee.service'

function makeHarness() {
  const db = new FakeOnboardingDb()
  const employeeRepo = new EmployeeRepository(db.asPool())
  const taskRepo = new OnboardingTaskRepository(db.asPool())
  const probationRepo = new ProbationRepository(db.asPool())
  const crypto = new CryptoClient(fakeCryptoTransport())
  const checklist = new ChecklistService(taskRepo, fakeConfigClient({ [SSO_DEADLINE_RULE_KEY]: 30 }))
  const audit = new AuditEmitter()
  const employeeService = new EmployeeService(employeeRepo, crypto, checklist, probationRepo, audit)
  const probationService = new ProbationService(probationRepo, employeeRepo, employeeService, audit)
  return { db, employeeService, probationService, checklist }
}

function validInput(overrides: Partial<CreateEmployeeInput> = {}): CreateEmployeeInput {
  return {
    empCode: 'EMP-0001', firstNameTh: 'สมชาย', lastNameTh: 'ใจดี', firstNameEn: 'Somchai', lastNameEn: 'Jaidee',
    nationalId: '1101700230708', taxId: '1234567890123', ssoNumber: '1234567890', bankAccount: '1112223334', bankCode: 'KTB',
    dob: '1990-01-15', address: { houseNo: '99/9', subDistrict: 'Lumphini', district: 'Pathum Wan', province: 'Bangkok', postalCode: '10330' },
    phone: '0812345678', email: 'somchai.jaidee@example.com', employmentType: 'monthly', orgUnitId: 'org-1', positionId: 'pos-1',
    provinceCode: 'TH-10', startDate: '2026-01-01', preferredLang: 'th', probationEndDate: '2026-04-01',
    ...overrides,
  }
}

async function createActiveEmployee(harness: ReturnType<typeof makeHarness>, overrides: Partial<CreateEmployeeInput> = {}) {
  const prepared = await harness.employeeService.prepareCreate(validInput(overrides))
  const conn = harness.db.connect()
  await conn.query('BEGIN')
  const { id } = await harness.employeeService.commitCreate(conn, prepared, 'hr-1', 'hr-officer')
  await conn.query('COMMIT')

  await conn.query('BEGIN')
  await harness.employeeService.transition(conn, id, 'onboarding', undefined, 'hr-1', 'hr-officer')
  await conn.query('COMMIT')
  for (const t of await harness.checklist.listForEmployee(id)) {
    await conn.query('BEGIN')
    await harness.checklist.completeTask(conn, t.id, true)
    await conn.query('COMMIT')
  }
  await conn.query('BEGIN')
  await harness.employeeService.transition(conn, id, 'active', undefined, 'hr-1', 'hr-officer')
  await conn.query('COMMIT')

  return id
}

describe('ProbationService.alertLevel — −14/−7 day alerts (PRD M1-5 AC)', () => {
  it('due_14 exactly 14 days before end_date, due_7 exactly 7 days before, none otherwise', () => {
    const { probationService } = makeHarness()
    const probation = { id: 'p1', employeeId: 'emp-1', endDate: '2026-12-01', outcome: null, decidedAt: null, extendedTo: null }

    expect(probationService.alertLevel(probation, '2026-11-17')).toBe('due_14')
    expect(probationService.alertLevel(probation, '2026-11-24')).toBe('due_7')
    expect(probationService.alertLevel(probation, '2026-11-20')).toBe('none')
    expect(probationService.alertLevel(probation, '2026-12-01')).toBe('none')
    expect(PROBATION_ALERT_DAYS_FIRST).toBe(14)
    expect(PROBATION_ALERT_DAYS_SECOND).toBe(7)
  })

  it('uses extendedTo, not the original endDate, once a probation has been extended', () => {
    const { probationService } = makeHarness()
    const probation = { id: 'p1', employeeId: 'emp-1', endDate: '2026-12-01', outcome: null, decidedAt: null, extendedTo: '2027-01-15' }
    expect(probationService.alertLevel(probation, '2027-01-01')).toBe('due_14')
  })

  it('a decided probation never alerts again', () => {
    const { probationService } = makeHarness()
    const probation = { id: 'p1', employeeId: 'emp-1', endDate: '2026-12-01', outcome: 'confirm' as const, decidedAt: '2026-11-01T00:00:00Z', extendedTo: null }
    expect(probationService.alertLevel(probation, '2026-11-17')).toBe('none')
  })
})

describe('ProbationService.decide — confirm/extend/terminate outcomes (M1-5 §1.3)', () => {
  it('confirm records the outcome', async () => {
    const harness = makeHarness()
    const id = await createActiveEmployee(harness)
    const conn = harness.db.connect()

    await conn.query('BEGIN')
    const result = await harness.probationService.decide(conn, id, { outcome: 'confirm' }, 'hr-1', 'hr-officer')
    await conn.query('COMMIT')

    expect(result.probation.outcome).toBe('confirm')
  })

  it('extend requires newEndDate (ONB-041) and, when given, records extendedTo', async () => {
    const harness = makeHarness()
    const id = await createActiveEmployee(harness)
    const conn = harness.db.connect()

    await conn.query('BEGIN')
    await expect(harness.probationService.decide(conn, id, { outcome: 'extend' }, 'hr-1', 'hr-officer')).rejects.toMatchObject({ code: 'ONB-041' })

    const result = await harness.probationService.decide(conn, id, { outcome: 'extend', newEndDate: '2026-05-01' }, 'hr-1', 'hr-officer')
    await conn.query('COMMIT')
    expect(result.probation).toMatchObject({ outcome: 'extend', extendedTo: '2026-05-01' })
  })

  it('terminate requires a reason category (ONB-011), publishes employee.terminated via the SAME path as a direct transition, and computes severanceApplicable', async () => {
    const harness = makeHarness()
    const id = await createActiveEmployee(harness, { startDate: '2026-01-01' })
    const conn = harness.db.connect()

    await conn.query('BEGIN')
    await expect(harness.probationService.decide(conn, id, { outcome: 'terminate' }, 'hr-1', 'hr-officer')).rejects.toMatchObject({ code: 'ONB-011' })

    const result = await harness.probationService.decide(conn, id, { outcome: 'terminate', reasonCategory: 'performance' }, 'hr-1', 'hr-officer')
    await conn.query('COMMIT')

    expect(result.probation.outcome).toBe('terminate')
    // service started 2026-01-01; probation.decide runs "today" (real clock,
    // long past 120 days from any 2026-01-01 fixture date) ⇒ severance applies
    expect(result.severanceApplicable).toBe(true)

    const employeeRow = await harness.employeeService.findRawById(id)
    expect(employeeRow?.status).toBe('terminated')
    const terminatedEvent = harness.db.debugOutboxRows().find((r) => r.topic === 'employee.terminated')
    expect(terminatedEvent?.payload).toMatchObject({ id, reasonCategory: 'performance' })
  })

  it('ONB-040 when there is no open probation (already decided, or none exists)', async () => {
    const harness = makeHarness()
    const id = await createActiveEmployee(harness)
    const conn = harness.db.connect()

    await conn.query('BEGIN')
    await harness.probationService.decide(conn, id, { outcome: 'confirm' }, 'hr-1', 'hr-officer')
    await conn.query('COMMIT')

    await conn.query('BEGIN')
    await expect(harness.probationService.decide(conn, id, { outcome: 'confirm' }, 'hr-1', 'hr-officer')).rejects.toMatchObject({ code: 'ONB-040' })
  })

  it('ONB-040 for an employee with no probation record at all', async () => {
    const harness = makeHarness()
    const id = await createActiveEmployee(harness, { probationEndDate: undefined, empCode: 'EMP-NOPROB', nationalId: '3109900764416' })
    const conn = harness.db.connect()
    await conn.query('BEGIN')
    await expect(harness.probationService.decide(conn, id, { outcome: 'confirm' }, 'hr-1', 'hr-officer')).rejects.toMatchObject({ code: 'ONB-040' })
  })
})
