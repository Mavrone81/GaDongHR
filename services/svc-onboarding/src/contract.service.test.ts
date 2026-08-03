import { CryptoClient } from '@gadong/kernel'
import { ContractService } from './contract.service'
import { EmployeeRepository } from './employee.repository'
import { EmployeeService } from './employee.service'
import { ChecklistService, SSO_DEADLINE_RULE_KEY } from './checklist.service'
import { OnboardingTaskRepository } from './onboarding-task.repository'
import { ProbationRepository } from './probation.repository'
import { AuditEmitter } from '@gadong/kernel'
import { FakeOnboardingDb } from './testing/fake-db'
import { fakeCryptoTransport } from './testing/fake-crypto-transport'
import { fakeConfigClient } from './testing/fake-config-client'
import { fakeDocsClient } from './testing/fake-docs-client'
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
  const docsClient = fakeDocsClient()
  const contractService = new ContractService(employeeRepo, crypto, docsClient)
  return { db, employeeService, contractService, docsClient }
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

describe('ContractService.generate — M1-4', () => {
  it('renders a contract via svc-docs with decrypted name merge fields and no S3 field anywhere in the request', async () => {
    const harness = makeHarness()
    const id = await createEmployee(harness)

    const result = await harness.contractService.generate(id, { templateId: 'employment_contract', lang: 'en' })
    expect(result.id).toBeDefined()
    expect(result.sha256).toBeDefined()

    expect(harness.docsClient.calls).toHaveLength(1)
    const call = harness.docsClient.calls[0]
    expect(call).toMatchObject({ kind: 'employment_contract', lang: 'en', entityType: 'employee', entityId: id })
    expect(call?.mergeFields['employeeNameEn']).toMatchObject({ value: 'Somchai Jaidee' })

    const requestJson = JSON.stringify(call)
    expect(requestJson).not.toContain('1101700230708') // national ID
    expect(requestJson).not.toContain('1112223334') // bank account
  })

  it('merges mergeOverrides as free text', async () => {
    const harness = makeHarness()
    const id = await createEmployee(harness)
    await harness.contractService.generate(id, { templateId: 'employment_contract', lang: 'th', mergeOverrides: { probationMonths: '4' } })
    expect(harness.docsClient.calls[0]?.mergeFields['probationMonths']).toMatchObject({ value: '4' })
  })

  it('ONB-003 for an unknown employee', async () => {
    const harness = makeHarness()
    await expect(harness.contractService.generate('no-such-id', { templateId: 'employment_contract', lang: 'th' })).rejects.toMatchObject({ code: 'ONB-003' })
  })
})
