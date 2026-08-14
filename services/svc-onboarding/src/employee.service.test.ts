import { AuditEmitter, CryptoClient } from '@gadong/kernel'
import { EmployeeService } from './employee.service'
import type { CreateEmployeeInput } from './employee.service'
import { EmployeeRepository } from './employee.repository'
import { ChecklistService, SSO_DEADLINE_RULE_KEY } from './checklist.service'
import { OnboardingTaskRepository } from './onboarding-task.repository'
import { ProbationRepository } from './probation.repository'
import { FakeOnboardingDb } from './testing/fake-db'
import { fakeCryptoTransport, unavailableCryptoTransport } from './testing/fake-crypto-transport'
import { fakeConfigClient } from './testing/fake-config-client'

function validInput(overrides: Partial<CreateEmployeeInput> = {}): CreateEmployeeInput {
  return {
    empCode: 'EMP-0001',
    firstNameTh: 'สมชาย',
    lastNameTh: 'ใจดี',
    firstNameEn: 'Somchai',
    lastNameEn: 'Jaidee',
    nationalId: '1101700230708',
    taxId: '1234567890123',
    ssoNumber: '1234567890',
    bankAccount: '1112223334',
    bankCode: 'KTB',
    dob: '1990-01-15',
    address: { houseNo: '99/9', subDistrict: 'Lumphini', district: 'Pathum Wan', province: 'Bangkok', postalCode: '10330' },
    phone: '0812345678',
    email: 'somchai.jaidee@example.com',
    employmentType: 'monthly',
    orgUnitId: 'org-1',
    positionId: 'pos-1',
    provinceCode: 'TH-10',
    startDate: '2026-09-01',
    preferredLang: 'th',
    ...overrides,
  }
}

function makeHarness(cryptoTransport = fakeCryptoTransport(), deadlineDays = 30) {
  const db = new FakeOnboardingDb()
  const employeeRepo = new EmployeeRepository(db.asPool())
  const taskRepo = new OnboardingTaskRepository(db.asPool())
  const probationRepo = new ProbationRepository(db.asPool())
  const crypto = new CryptoClient(cryptoTransport)
  const checklist = new ChecklistService(taskRepo, fakeConfigClient({ [SSO_DEADLINE_RULE_KEY]: deadlineDays }))
  const audit = new AuditEmitter()
  const service = new EmployeeService(employeeRepo, crypto, checklist, probationRepo, audit)
  return { db, service, employeeRepo, checklist }
}

async function createEmployee(service: EmployeeService, db: FakeOnboardingDb, input: CreateEmployeeInput) {
  const prepared = await service.prepareCreate(input)
  const conn = db.connect()
  await conn.query('BEGIN')
  const result = await service.commitCreate(conn, prepared, 'hr-1', 'hr-officer')
  await conn.query('COMMIT')
  return result
}

describe('EmployeeService.createEmployee — encrypt-before-write (the central compliance claim)', () => {
  it('the stored row contains ciphertext, never plaintext, for every 🔐 field', async () => {
    const { db, service } = makeHarness()
    const input = validInput()

    const { id } = await createEmployee(service, db, input)

    const stored = db.debugEmployees().find((r) => r.id === id)
    if (!stored) throw new Error('employee was not stored')

    const plaintextValues = [
      input.firstNameTh, input.lastNameTh, input.firstNameEn, input.lastNameEn,
      input.nationalId, input.taxId, input.ssoNumber!, input.bankAccount,
      input.dob, input.phone, input.email, JSON.stringify(input.address),
    ]
    const cipherFields = [
      stored.first_name_th, stored.last_name_th, stored.first_name_en, stored.last_name_en,
      stored.national_id, stored.tax_id, stored.sso_number, stored.bank_account,
      stored.dob, stored.phone, stored.email, stored.address,
    ]
    for (const cipher of cipherFields) {
      const asText = cipher.toString('utf8')
      for (const plain of plaintextValues) {
        expect(asText).not.toContain(plain)
      }
    }
    // negative-control demonstration (task brief): removing encryption makes
    // this assertion fail — proven directly in national-id-passthrough-style
    // by asserting the SAME property against a transport that just
    // base64-echoes plaintext back (i.e. "no encryption").
  })

  it('DEMONSTRATION: the same assertion FAILS against a transport that does not actually encrypt (base64-echoes plaintext) — proves the test is load-bearing, not vacuous', async () => {
    const passthroughTransport = {
      post: (path: string, body: unknown) => {
        if (path === '/encrypt') {
          const { fields } = body as { fields: Array<{ field: string; value: string }> }
          const out: Record<string, string> = {}
          for (const f of fields) {
            // "encrypts" by just base64-encoding the plaintext and padding to
            // the kernel's minimum ciphertext length — i.e. NOT encryption.
            const raw = Buffer.from(f.value, 'utf8')
            const padded = Buffer.concat([raw, Buffer.alloc(Math.max(0, 125 - raw.length))])
            out[f.field] = padded.toString('base64')
          }
          return Promise.resolve({ fields: out })
        }
        if (path === '/bidx') {
          const { value } = body as { value: string }
          const h = Buffer.alloc(32)
          Buffer.from(value).copy(h)
          return Promise.resolve({ bidx: h.toString('base64') })
        }
        throw new Error('unused in this test')
      },
    }
    const { db, service } = makeHarness(passthroughTransport)
    const input = validInput()
    const { id } = await createEmployee(service, db, input)
    const stored = db.debugEmployees().find((r) => r.id === id)
    // With a non-encrypting transport, the plaintext national ID DOES appear
    // in the stored bytea — this is the failure the real fake-crypto-transport
    // (XOR-obfuscation) and real svc-crypto prevent.
    expect(stored?.national_id.toString('utf8')).toContain(input.nationalId)
  })
})

describe('EmployeeService.createEmployee — Thai national ID checksum (ONB-001)', () => {
  it('rejects an invalid checksum with ONB-001 and writes no row', async () => {
    const { db, service } = makeHarness()
    await expect(service.prepareCreate(validInput({ nationalId: '1101700230701' }))).rejects.toMatchObject({ code: 'ONB-001' })
    expect(db.debugEmployees()).toHaveLength(0)
  })

  it('accepts a valid checksum', async () => {
    const { db, service } = makeHarness()
    const { id } = await createEmployee(service, db, validInput({ nationalId: '3109900764416' }))
    expect(id).toBeDefined()
  })
})

describe('EmployeeService.createEmployee — duplicate national ID (ONB-002, via blind index)', () => {
  it('a second employee with the same national ID is rejected, and no plaintext comparison is possible (the check only ever sees a Buffer bidx)', async () => {
    const { db, service } = makeHarness()
    await createEmployee(service, db, validInput({ empCode: 'EMP-0001', nationalId: '1101700230708' }))

    await expect(
      service.prepareCreate(validInput({ empCode: 'EMP-0002', nationalId: '1101700230708' })),
    ).rejects.toMatchObject({ code: 'ONB-002' })

    expect(db.debugEmployees()).toHaveLength(1)
  })

  it('a different national ID is accepted', async () => {
    const { db, service } = makeHarness()
    await createEmployee(service, db, validInput({ empCode: 'EMP-0001', nationalId: '1101700230708' }))
    await createEmployee(service, db, validInput({ empCode: 'EMP-0002', nationalId: '3109900764416' }))
    expect(db.debugEmployees()).toHaveLength(2)
  })
})

describe('EmployeeService.createEmployee — CRY-503 fail closed', () => {
  it('crypto unavailable ⇒ the write fails with CRY-503 and no row is written', async () => {
    const { db, service } = makeHarness(unavailableCryptoTransport())
    await expect(service.prepareCreate(validInput())).rejects.toMatchObject({ code: 'CRY-503' })
    expect(db.debugEmployees()).toHaveLength(0)
    expect(db.debugOutboxRows()).toHaveLength(0)
  })
})

describe('EmployeeService — creates the checklist (including SSO task) and the probation record atomically with the employee row', () => {
  it('a rolled-back create leaves no employee, no checklist tasks, and no outbox row', async () => {
    const { db, service } = makeHarness()
    const prepared = await service.prepareCreate(validInput())
    const conn = db.connect()
    await conn.query('BEGIN')
    await service.commitCreate(conn, prepared, 'hr-1', 'hr-officer')
    await conn.query('ROLLBACK')

    expect(db.debugEmployees()).toHaveLength(0)
    expect(db.debugOnboardingTasks()).toHaveLength(0)
    expect(db.debugOutboxRows()).toHaveLength(0)
  })

  it('a committed create publishes employee.created with no S3 plaintext in the payload', async () => {
    const { db, service } = makeHarness()
    const { id } = await createEmployee(service, db, validInput())

    const outbox = db.debugOutboxRows().find((r) => r.topic === 'employee.created')
    expect(outbox).toBeDefined()
    const payload = JSON.stringify(outbox?.payload)
    expect(payload).not.toContain('1101700230708') // national ID
    expect(payload).not.toContain('somchai.jaidee@example.com') // email
    expect(outbox?.payload).toMatchObject({ id, empCode: 'EMP-0001', status: 'draft' })
  })

  it('opens a probation record when probationEndDate is given', async () => {
    const { db, service } = makeHarness()
    const { id } = await createEmployee(service, db, validInput({ probationEndDate: '2026-12-01' }))
    const probation = db.debugProbations().find((p) => p.employee_id === id)
    expect(probation).toMatchObject({ end_date: '2026-12-01', outcome: null })
  })
})

describe('EmployeeService.getProfile — decrypts S2 fields, excludes S3', () => {
  it('round-trips names/address/dob/phone/email through the real encrypt→decrypt path', async () => {
    const { db, service } = makeHarness()
    const input = validInput()
    const { id } = await createEmployee(service, db, input)

    const profile = await service.getProfile(id, 'caller-1', '*')
    expect(profile.firstNameTh).toBe(input.firstNameTh)
    expect(profile.lastNameEn).toBe(input.lastNameEn)
    expect(profile.email).toBe(input.email)
    expect(profile.address).toEqual(input.address)
    expect(profile).not.toHaveProperty('nationalId')
    expect(profile).not.toHaveProperty('taxId')
  })

  it('ONB-003 for an unknown id', async () => {
    const { service } = makeHarness()
    await expect(service.getProfile('no-such-id', 'caller-1', '*')).rejects.toMatchObject({ code: 'ONB-003' })
  })
})

describe('EmployeeService.getProfile — row-scoping fix (roadmap "🔴 Open security gap")', () => {
  it("'self' scope allows the employee reading their own profile", async () => {
    const { db, service } = makeHarness()
    const { id } = await createEmployee(service, db, validInput())
    await expect(service.getProfile(id, id, 'self')).resolves.toMatchObject({ id })
  })

  it("'self' scope denies (ONB-070) reading a DIFFERENT employee's profile — the flagship vulnerability shape, for onboarding's own employee records", async () => {
    const { db, service } = makeHarness()
    const { id } = await createEmployee(service, db, validInput())
    await expect(service.getProfile(id, 'someone-else', 'self')).rejects.toMatchObject({ code: 'ONB-070' })
  })

  it('an org-unit array scope allows a caller whose scope covers the row\'s org unit, and denies one that does not', async () => {
    const { db, service } = makeHarness()
    const { id } = await createEmployee(service, db, validInput({ orgUnitId: 'org-a' }))
    await expect(service.getProfile(id, 'manager-1', ['org-a'])).resolves.toMatchObject({ id })
    await expect(service.getProfile(id, 'manager-2', ['org-b'])).rejects.toMatchObject({ code: 'ONB-070' })
  })

  it('404 (not found) takes precedence over 403 (out of scope) — a missing id never leaks scope information', async () => {
    const { service } = makeHarness()
    await expect(service.getProfile('no-such-id', 'someone', 'self')).rejects.toMatchObject({ code: 'ONB-003' })
  })
})

describe('EmployeeService.list — no sensitive decryption', () => {
  it('returns summaries only', async () => {
    const { db, service } = makeHarness()
    await createEmployee(service, db, validInput({ empCode: 'EMP-A', orgUnitId: 'org-a' }))
    await createEmployee(service, db, validInput({ empCode: 'EMP-B', nationalId: '3109900764416', orgUnitId: 'org-b' }))

    const all = await service.list({}, 'caller-1', '*')
    expect(all.map((e) => e.empCode).sort()).toEqual(['EMP-A', 'EMP-B'])
    expect(all[0]).not.toHaveProperty('nationalId')

    const scoped = await service.list({ orgUnitId: 'org-a' }, 'caller-1', '*')
    expect(scoped.map((e) => e.empCode)).toEqual(['EMP-A'])
  })
})

describe('EmployeeService.list — row-scoping fix', () => {
  it("an org-unit array scope silently restricts the list to in-scope org units (no filter given) — a manager sees only their own team", async () => {
    const { db, service } = makeHarness()
    await createEmployee(service, db, validInput({ empCode: 'EMP-A', orgUnitId: 'org-a' }))
    await createEmployee(service, db, validInput({ empCode: 'EMP-B', nationalId: '3109900764416', orgUnitId: 'org-b' }))

    const scoped = await service.list({}, 'manager-1', ['org-a'])
    expect(scoped.map((e) => e.empCode)).toEqual(['EMP-A'])
  })

  it('an explicit org_unit filter outside the caller\'s scope is rejected with ONB-071, not silently emptied', async () => {
    const { db, service } = makeHarness()
    await createEmployee(service, db, validInput({ empCode: 'EMP-A', orgUnitId: 'org-a' }))

    await expect(service.list({ orgUnitId: 'org-b' }, 'manager-1', ['org-a'])).rejects.toMatchObject({ code: 'ONB-071' })
  })

  it("'self' scope lists exactly the caller's own record", async () => {
    const { db, service } = makeHarness()
    const { id } = await createEmployee(service, db, validInput({ empCode: 'EMP-SELF' }))
    await createEmployee(service, db, validInput({ empCode: 'EMP-OTHER', nationalId: '3109900764416' }))

    const scoped = await service.list({}, id, 'self')
    expect(scoped.map((e) => e.empCode)).toEqual(['EMP-SELF'])
  })
})

describe('EmployeeService sensitive read — GET /employees/:id/sensitive (M1-1 AC #4)', () => {
  it('rejects a read with no purpose (ONB-021)', async () => {
    const { db, service } = makeHarness()
    const { id } = await createEmployee(service, db, validInput())
    await expect(service.prepareSensitiveRead(id, ['national_id'], '', 'caller-1', '*')).rejects.toMatchObject({ code: 'ONB-021' })
    await expect(service.prepareSensitiveRead(id, ['national_id'], '   ', 'caller-1', '*')).rejects.toMatchObject({ code: 'ONB-021' })
  })

  it('rejects an unknown field name (ONB-022)', async () => {
    const { db, service } = makeHarness()
    const { id } = await createEmployee(service, db, validInput())
    await expect(service.prepareSensitiveRead(id, ['not_a_real_field'], 'kyc-check', 'caller-1', '*')).rejects.toMatchObject({ code: 'ONB-022' })
  })

  it("out-of-scope caller is denied (ONB-070) before any decrypt happens — sensitive fields are S3-class, no weaker check than getProfile's", async () => {
    const { db, service } = makeHarness()
    const { id } = await createEmployee(service, db, validInput())
    await expect(service.prepareSensitiveRead(id, ['national_id'], 'kyc-check', 'someone-else', 'self')).rejects.toMatchObject({ code: 'ONB-070' })
  })

  it('with a purpose, decrypts every requested field and emits exactly one audit entry per field', async () => {
    const { db, service } = makeHarness()
    const input = validInput()
    const { id } = await createEmployee(service, db, input)

    const values = await service.prepareSensitiveRead(id, ['national_id', 'bank_account'], 'annual KYC refresh', 'caller-1', '*')
    expect(values['national_id']).toBe(input.nationalId)
    expect(values['bank_account']).toBe(input.bankAccount)

    const conn = db.connect()
    await conn.query('BEGIN')
    await service.commitSensitiveReadAudit(conn, id, ['national_id', 'bank_account'], 'annual KYC refresh', 'hr-1', 'hr-officer')
    await conn.query('COMMIT')

    const auditEvents = db.debugOutboxRows().filter((r) => r.topic === 'audit.employee.sensitive.read')
    expect(auditEvents).toHaveLength(2) // exactly one per field, not one for the whole call
    const fieldsAudited = auditEvents.map((e) => (e.payload as { entity: string }).entity.replace('employee.', '')).sort()
    expect(fieldsAudited).toEqual(['bank_account', 'national_id'])
    for (const e of auditEvents) {
      expect(e.payload).toMatchObject({ purpose: 'annual KYC refresh', actorId: 'hr-1', entityId: id })
    }
  })

  it('audit payload carries no plaintext value — only the field name and hashes', async () => {
    const { db, service } = makeHarness()
    const input = validInput()
    const { id } = await createEmployee(service, db, input)
    await service.prepareSensitiveRead(id, ['national_id'], 'purpose', 'caller-1', '*')

    const conn = db.connect()
    await conn.query('BEGIN')
    await service.commitSensitiveReadAudit(conn, id, ['national_id'], 'purpose', 'hr-1', 'hr-officer')
    await conn.query('COMMIT')

    const [event] = db.debugOutboxRows().filter((r) => r.topic === 'audit.employee.sensitive.read')
    expect(JSON.stringify(event?.payload)).not.toContain(input.nationalId)
  })
})

describe('EmployeeService.transition — lifecycle guards (M1-ONBOARDING §1.2)', () => {
  it('onboarding→active is blocked while the checklist is incomplete (ONB-010)', async () => {
    const { db, service } = makeHarness()
    const { id } = await createEmployee(service, db, validInput())
    const conn = db.connect()
    await conn.query('BEGIN')
    await service.transition(conn, id, 'onboarding', undefined, 'hr-1', 'hr-officer')
    await conn.query('COMMIT')

    await conn.query('BEGIN')
    await expect(service.transition(conn, id, 'active', undefined, 'hr-1', 'hr-officer')).rejects.toMatchObject({ code: 'ONB-010' })
  })

  it('onboarding→active succeeds once every checklist task is completed', async () => {
    const { db, service, checklist } = makeHarness()
    const { id } = await createEmployee(service, db, validInput({ employmentType: 'contract' }))
    const conn = db.connect()
    await conn.query('BEGIN')
    await service.transition(conn, id, 'onboarding', undefined, 'hr-1', 'hr-officer')
    await conn.query('COMMIT')

    const tasks = await checklist.listForEmployee(id)
    for (const t of tasks) {
      await conn.query('BEGIN')
      await checklist.completeTask(conn, t.id, true)
      await conn.query('COMMIT')
    }

    await conn.query('BEGIN')
    const result = await service.transition(conn, id, 'active', undefined, 'hr-1', 'hr-officer')
    await conn.query('COMMIT')
    expect(result.status).toBe('active')
  })

  it('an invalid transition (draft→active, skipping onboarding) is rejected (ONB-010)', async () => {
    const { db, service } = makeHarness()
    const { id } = await createEmployee(service, db, validInput())
    const conn = db.connect()
    await conn.query('BEGIN')
    await expect(service.transition(conn, id, 'active', undefined, 'hr-1', 'hr-officer')).rejects.toMatchObject({ code: 'ONB-010' })
  })

  it('active→terminated requires a reason category (ONB-011)', async () => {
    const { db, service, checklist } = makeHarness()
    const { id } = await createEmployee(service, db, validInput({ employmentType: 'contract' }))
    const conn = db.connect()
    await conn.query('BEGIN')
    await service.transition(conn, id, 'onboarding', undefined, 'hr-1', 'hr-officer')
    await conn.query('COMMIT')
    for (const t of await checklist.listForEmployee(id)) {
      await conn.query('BEGIN')
      await checklist.completeTask(conn, t.id, true)
      await conn.query('COMMIT')
    }
    await conn.query('BEGIN')
    await service.transition(conn, id, 'active', undefined, 'hr-1', 'hr-officer')
    await conn.query('COMMIT')

    await conn.query('BEGIN')
    await expect(service.transition(conn, id, 'terminated', undefined, 'hr-1', 'hr-officer')).rejects.toMatchObject({ code: 'ONB-011' })
    await conn.query('COMMIT')

    await conn.query('BEGIN')
    const result = await service.transition(conn, id, 'terminated', 'resignation', 'hr-1', 'hr-officer')
    await conn.query('COMMIT')
    expect(result.status).toBe('terminated')

    const terminatedEvent = db.debugOutboxRows().find((r) => r.topic === 'employee.terminated')
    expect(terminatedEvent?.payload).toMatchObject({ id, reasonCategory: 'resignation' })
  })
})

describe('EmployeeService.prepareUpdate/commitUpdate — PATCH re-encrypts changed S3 fields', () => {
  it('changing the national ID re-encrypts and re-computes the blind index, and blocks a duplicate', async () => {
    const { db, service } = makeHarness()
    const { id: id1 } = await createEmployee(service, db, validInput({ empCode: 'EMP-0001', nationalId: '1101700230708' }))
    const { id: id2 } = await createEmployee(service, db, validInput({ empCode: 'EMP-0002', nationalId: '3109900764416' }))

    // id2 cannot take id1's national ID
    await expect(service.prepareUpdate(id2, { nationalId: '1101700230708' })).rejects.toMatchObject({ code: 'ONB-002' })

    // id1 can change to a fresh, valid national ID
    const prepared = await service.prepareUpdate(id1, { nationalId: '1902970000199' })
    const conn = db.connect()
    await conn.query('BEGIN')
    await service.commitUpdate(conn, prepared, 'hr-1', 'hr-officer')
    await conn.query('COMMIT')

    const profileValues = await service.prepareSensitiveRead(id1, ['national_id'], 'verify update', 'caller-1', '*')
    expect(profileValues['national_id']).toBe('1902970000199')
  })

  it('ONB-001 on an invalid replacement national ID', async () => {
    const { db, service } = makeHarness()
    const { id } = await createEmployee(service, db, validInput())
    await expect(service.prepareUpdate(id, { nationalId: '0000000000000' })).rejects.toMatchObject({ code: 'ONB-001' })
  })
})
