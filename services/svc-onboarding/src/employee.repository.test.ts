import { randomUUID } from 'node:crypto'
import type { Queryable } from '@gadong/kernel'
import { EmployeeRepository } from './employee.repository'
import type { NewEmployeeRow } from './employee.repository'
import { ConstraintViolation, FakeOnboardingDb } from './testing/fake-db'

function buf(s: string): Buffer {
  return Buffer.from(s.padEnd(20, '.'), 'utf8')
}

function newEmployee(overrides: Partial<NewEmployeeRow> = {}): NewEmployeeRow {
  return {
    id: randomUUID(),
    empCode: 'EMP-0001',
    firstNameTh: buf('somchai-th'),
    lastNameTh: buf('jaidee-th'),
    firstNameEn: buf('somchai-en'),
    lastNameEn: buf('jaidee-en'),
    nameZh: null,
    nationalId: buf('1101700230708'),
    nationalIdBidx: Buffer.from('bidx-1101700230708'),
    passportNo: null,
    taxId: buf('taxid'),
    ssoNumber: buf('ssonum'),
    bankAccount: buf('bankacct'),
    bankCode: 'KTB',
    dob: buf('1990-01-01'),
    address: buf('{"province":"Bangkok"}'),
    phone: buf('0812345678'),
    email: buf('somchai@example.com'),
    emailBidx: Buffer.from('bidx-somchai@example.com'),
    employmentType: 'monthly',
    orgUnitId: 'org-1',
    positionId: 'pos-1',
    provinceCode: 'TH-10',
    startDate: '2026-09-01',
    status: 'draft',
    preferredLang: 'th',
    clockInMethod: 'biometric',
    ...overrides,
  }
}

describe('EmployeeRepository — SQL shape (mocked tx)', () => {
  it('insert() issues an INSERT into onboarding.employee and returns the mapped row', async () => {
    const returned = {
      id: 'emp-1',
      emp_code: 'EMP-0001',
      first_name_th: buf('a'), last_name_th: buf('b'), first_name_en: buf('c'), last_name_en: buf('d'), name_zh: null,
      national_id: buf('e'), national_id_bidx: Buffer.from('bidx'), passport_no: null,
      tax_id: buf('f'), sso_number: buf('g'), bank_account: buf('h'), bank_code: 'KTB',
      dob: buf('i'), address: buf('j'), phone: buf('k'), email: buf('l'), email_bidx: Buffer.from('ebidx'),
      employment_type: 'monthly', org_unit_id: 'org-1', position_id: 'pos-1', province_code: 'TH-10',
      start_date: '2026-09-01', termination_date: null, status: 'draft', preferred_lang: 'th', clock_in_method: 'biometric',
      created_at: new Date('2026-08-01T00:00:00Z'), updated_at: new Date('2026-08-01T00:00:00Z'),
    }
    const tx: Queryable = { query: jest.fn().mockResolvedValue({ rows: [returned] }) }
    const repo = new EmployeeRepository(tx)

    const row = await repo.insert(tx, newEmployee())

    expect(tx.query).toHaveBeenCalledTimes(1)
    const [sql, params] = (tx.query as jest.Mock).mock.calls[0] as [string, unknown[]]
    expect(sql).toMatch(/INSERT INTO onboarding\.employee/i)
    expect(params[1]).toBe('EMP-0001')
    expect(row).toMatchObject({ id: 'emp-1', empCode: 'EMP-0001', status: 'draft' })
  })

  it('a date column returned as a JS Date is normalised back to an ISO date string', async () => {
    const base = newEmployee()
    const returned = {
      id: 'emp-1', emp_code: base.empCode,
      first_name_th: base.firstNameTh, last_name_th: base.lastNameTh, first_name_en: base.firstNameEn, last_name_en: base.lastNameEn, name_zh: null,
      national_id: base.nationalId, national_id_bidx: base.nationalIdBidx, passport_no: null,
      tax_id: base.taxId, sso_number: base.ssoNumber, bank_account: base.bankAccount, bank_code: base.bankCode,
      dob: base.dob, address: base.address, phone: base.phone, email: base.email, email_bidx: base.emailBidx,
      employment_type: base.employmentType, org_unit_id: base.orgUnitId, position_id: base.positionId, province_code: base.provinceCode,
      start_date: new Date('2026-09-01T00:00:00.000Z'), termination_date: null, status: base.status, preferred_lang: base.preferredLang,
      clock_in_method: base.clockInMethod,
      created_at: new Date('2026-08-01T00:00:00Z'), updated_at: new Date('2026-08-01T00:00:00Z'),
    }
    const tx: Queryable = { query: jest.fn().mockResolvedValue({ rows: [returned] }) }
    const repo = new EmployeeRepository(tx)

    const row = await repo.insert(tx, base)
    expect(row.startDate).toBe('2026-09-01')
    expect(typeof row.startDate).toBe('string')
  })
})

describe('EmployeeRepository — against FakeOnboardingDb (relational behaviour)', () => {
  it('insert() then findById() round-trips every field', async () => {
    const db = new FakeOnboardingDb()
    const conn = db.connect()
    const repo = new EmployeeRepository(conn)

    await conn.query('BEGIN')
    const inserted = await repo.insert(conn, newEmployee())
    await conn.query('COMMIT')

    const found = await repo.findById(inserted.id)
    expect(found).toEqual(inserted)
  })

  it('UNIQUE national_id_bidx: a second employee with the same blind index is rejected — the DB-level mechanism behind ONB-002', async () => {
    const db = new FakeOnboardingDb()
    const conn = db.connect()
    const repo = new EmployeeRepository(conn)

    await conn.query('BEGIN')
    await repo.insert(conn, newEmployee({ empCode: 'EMP-0001', nationalIdBidx: Buffer.from('same-bidx') }))
    await conn.query('COMMIT')

    await conn.query('BEGIN')
    await expect(
      repo.insert(conn, newEmployee({ empCode: 'EMP-0002', nationalIdBidx: Buffer.from('same-bidx') })),
    ).rejects.toThrow(ConstraintViolation)
  })

  it('UNIQUE emp_code: a duplicate employee code is rejected', async () => {
    const db = new FakeOnboardingDb()
    const conn = db.connect()
    const repo = new EmployeeRepository(conn)

    await conn.query('BEGIN')
    await repo.insert(conn, newEmployee({ empCode: 'EMP-0001' }))
    await conn.query('COMMIT')

    await conn.query('BEGIN')
    await expect(
      repo.insert(conn, newEmployee({ empCode: 'EMP-0001', nationalIdBidx: Buffer.from('different-bidx') })),
    ).rejects.toThrow(ConstraintViolation)
  })

  it('findByNationalIdBidx() finds the matching row', async () => {
    const db = new FakeOnboardingDb()
    const conn = db.connect()
    const repo = new EmployeeRepository(conn)

    await conn.query('BEGIN')
    const inserted = await repo.insert(conn, newEmployee({ nationalIdBidx: Buffer.from('findme-bidx') }))
    await conn.query('COMMIT')

    const found = await repo.findByNationalIdBidx(Buffer.from('findme-bidx'))
    expect(found?.id).toBe(inserted.id)
    expect(await repo.findByNationalIdBidx(Buffer.from('no-such-bidx'))).toBeNull()
  })

  it('update() patches only the given columns and bumps updated_at', async () => {
    const db = new FakeOnboardingDb()
    const conn = db.connect()
    const repo = new EmployeeRepository(conn)

    await conn.query('BEGIN')
    const inserted = await repo.insert(conn, newEmployee({ status: 'draft' }))
    await conn.query('COMMIT')

    await conn.query('BEGIN')
    const updated = await repo.update(conn, inserted.id, { status: 'onboarding' })
    await conn.query('COMMIT')

    expect(updated?.status).toBe('onboarding')
    expect(updated?.empCode).toBe(inserted.empCode) // untouched field preserved
    expect(new Date(updated!.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(inserted.updatedAt).getTime())
  })

  it('update() on a non-existent id returns null', async () => {
    const db = new FakeOnboardingDb()
    const conn = db.connect()
    const repo = new EmployeeRepository(conn)

    await conn.query('BEGIN')
    const updated = await repo.update(conn, 'no-such-id', { status: 'active' })
    await conn.query('COMMIT')
    expect(updated).toBeNull()
  })

  it('list() filters by orgUnitId and status', async () => {
    const db = new FakeOnboardingDb()
    const conn = db.connect()
    const repo = new EmployeeRepository(conn)

    await conn.query('BEGIN')
    await repo.insert(conn, newEmployee({ empCode: 'E1', orgUnitId: 'org-a', status: 'draft', nationalIdBidx: Buffer.from('b1') }))
    await repo.insert(conn, newEmployee({ empCode: 'E2', orgUnitId: 'org-b', status: 'active', nationalIdBidx: Buffer.from('b2') }))
    await repo.insert(conn, newEmployee({ empCode: 'E3', orgUnitId: 'org-a', status: 'active', nationalIdBidx: Buffer.from('b3') }))
    await conn.query('COMMIT')

    const byOrg = await repo.list({ orgUnitId: 'org-a' }, '*', 'caller-1')
    expect(byOrg.map((r) => r.empCode).sort()).toEqual(['E1', 'E3'])

    const byStatus = await repo.list({ status: 'active' }, '*', 'caller-1')
    expect(byStatus.map((r) => r.empCode).sort()).toEqual(['E2', 'E3'])

    const byBoth = await repo.list({ orgUnitId: 'org-a', status: 'active' }, '*', 'caller-1')
    expect(byBoth.map((r) => r.empCode)).toEqual(['E3'])
  })

  describe('list() row-scoping (roadmap "🔴 Open security gap")', () => {
    it('an org-unit array scope restricts the result to those org units only, regardless of filter', async () => {
      const db = new FakeOnboardingDb()
      const conn = db.connect()
      const repo = new EmployeeRepository(conn)

      await conn.query('BEGIN')
      await repo.insert(conn, newEmployee({ empCode: 'E1', orgUnitId: 'org-a', status: 'active', nationalIdBidx: Buffer.from('sb1') }))
      await repo.insert(conn, newEmployee({ empCode: 'E2', orgUnitId: 'org-b', status: 'active', nationalIdBidx: Buffer.from('sb2') }))
      await repo.insert(conn, newEmployee({ empCode: 'E3', orgUnitId: 'org-c', status: 'active', nationalIdBidx: Buffer.from('sb3') }))
      await conn.query('COMMIT')

      const scoped = await repo.list({}, ['org-a', 'org-b'], 'caller-1')
      expect(scoped.map((r) => r.empCode).sort()).toEqual(['E1', 'E2'])
    })

    it("'self' scope returns exactly the caller's own row, never any other", async () => {
      const db = new FakeOnboardingDb()
      const conn = db.connect()
      const repo = new EmployeeRepository(conn)

      await conn.query('BEGIN')
      const self = await repo.insert(conn, newEmployee({ empCode: 'ESELF', orgUnitId: 'org-a', status: 'active', nationalIdBidx: Buffer.from('sb4') }))
      await repo.insert(conn, newEmployee({ empCode: 'EOTHER', orgUnitId: 'org-a', status: 'active', nationalIdBidx: Buffer.from('sb5') }))
      await conn.query('COMMIT')

      const scoped = await repo.list({}, 'self', self.id)
      expect(scoped.map((r) => r.id)).toEqual([self.id])
    })

    it('an empty org-unit array scope returns no rows at all, without querying', async () => {
      const db = new FakeOnboardingDb()
      const conn = db.connect()
      const repo = new EmployeeRepository(conn)

      await conn.query('BEGIN')
      await repo.insert(conn, newEmployee({ empCode: 'E1', orgUnitId: 'org-a', status: 'active', nationalIdBidx: Buffer.from('sb6') }))
      await conn.query('COMMIT')

      const scoped = await repo.list({}, [], 'caller-1')
      expect(scoped).toEqual([])
    })
  })

  it('a rolled-back insert() is not visible after ROLLBACK', async () => {
    const db = new FakeOnboardingDb()
    const conn = db.connect()
    const repo = new EmployeeRepository(conn)

    await conn.query('BEGIN')
    const inserted = await repo.insert(conn, newEmployee())
    await conn.query('ROLLBACK')

    expect(await repo.findById(inserted.id)).toBeNull()
  })
})
