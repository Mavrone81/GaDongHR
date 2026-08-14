import { AuditEmitter, CryptoClient } from '@gadong/kernel'
import { SelfServiceService } from './self-service.service'
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
  const crypto = new CryptoClient(fakeCryptoTransport())
  const checklist = new ChecklistService(taskRepo, fakeConfigClient({ [SSO_DEADLINE_RULE_KEY]: 30 }))
  const audit = new AuditEmitter()
  const employeeService = new EmployeeService(employeeRepo, crypto, checklist, probationRepo, audit)
  const selfService = new SelfServiceService(employeeService)
  return { db, employeeService, selfService }
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

async function createEmployee(harness: ReturnType<typeof makeHarness>) {
  const prepared = await harness.employeeService.prepareCreate(validInput())
  const conn = harness.db.connect()
  await conn.query('BEGIN')
  const { id } = await harness.employeeService.commitCreate(conn, prepared, 'hr-1', 'hr-officer')
  await conn.query('COMMIT')
  return id
}

describe('SelfServiceService.submit — idempotent under retry (XC-EVENTS: triple delivery, one effect)', () => {
  it('the same submissionId delivered 3 times (3 separate requests/transactions, as a real retry would be) updates the phone number exactly once', async () => {
    const harness = makeHarness()
    const id = await createEmployee(harness)
    const submissionId = 'submission-abc-123'

    const results = []
    for (let i = 0; i < 3; i++) {
      const conn = harness.db.connect()
      await conn.query('BEGIN')
      results.push(await harness.selfService.submit(conn, submissionId, id, { phone: '0899999999' }, id, 'employee-ess'))
      await conn.query('COMMIT')
    }

    expect(results[0]).toMatchObject({ id })
    expect(results[1]).toBe('duplicate')
    expect(results[2]).toBe('duplicate')

    const updateEvents = harness.db.debugOutboxRows().filter((r) => r.topic === 'employee.updated')
    expect(updateEvents).toHaveLength(1) // one effect, not three

    const profile = await harness.employeeService.getProfile(id, id, 'self')
    expect(profile.phone).toBe('0899999999')
  })

  it('a DIFFERENT submissionId is a genuinely new effect', async () => {
    const harness = makeHarness()
    const id = await createEmployee(harness)

    const conn1 = harness.db.connect()
    await conn1.query('BEGIN')
    await harness.selfService.submit(conn1, 'submission-1', id, { phone: '0811111111' }, id, 'employee-ess')
    await conn1.query('COMMIT')

    const conn2 = harness.db.connect()
    await conn2.query('BEGIN')
    await harness.selfService.submit(conn2, 'submission-2', id, { phone: '0822222222' }, id, 'employee-ess')
    await conn2.query('COMMIT')

    const updateEvents = harness.db.debugOutboxRows().filter((r) => r.topic === 'employee.updated')
    expect(updateEvents).toHaveLength(2)
    const profile = await harness.employeeService.getProfile(id, id, 'self')
    expect(profile.phone).toBe('0822222222')
  })

  it('a rolled-back submission is redelivered on retry (idempotent() itself never opens/closes the transaction)', async () => {
    const harness = makeHarness()
    const id = await createEmployee(harness)
    const submissionId = 'submission-rollback-test'

    const conn1 = harness.db.connect()
    await conn1.query('BEGIN')
    await harness.selfService.submit(conn1, submissionId, id, { phone: '0833333333' }, id, 'employee-ess')
    await conn1.query('ROLLBACK') // simulates the caller's own transaction failing after idempotent() ran

    const conn2 = harness.db.connect()
    await conn2.query('BEGIN')
    const result = await harness.selfService.submit(conn2, submissionId, id, { phone: '0833333333' }, id, 'employee-ess')
    await conn2.query('COMMIT')

    expect(result).toMatchObject({ id }) // NOT 'duplicate' — the rolled-back attempt never committed
    const profile = await harness.employeeService.getProfile(id, id, 'self')
    expect(profile.phone).toBe('0833333333')
  })
})
