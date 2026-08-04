import { randomUUID } from 'node:crypto'
import { CryptoClient } from '@gadong/kernel'
import { bahtToSatang } from './money'
import { PayProfilesRepository } from './pay-profiles.repository'
import { PayProfilesService, parseDeclaration, serialiseDeclaration } from './pay-profiles.service'
import { PayslipsRepository } from './payslips.repository'
import { PayslipsService } from './payslips.service'
import { RefsRepository } from './refs.repository'
import { RunsRepository } from './runs.repository'
import { RunsService } from './runs.service'
import { PayInputsRepository } from './pay-inputs.repository'
import { FakePayrollDb } from './testing/fake-db'
import { fakeCryptoTransport } from './testing/fake-crypto-transport'
import { FakeDocsClient, FakeExportRecorder, FakeTimesheetClient } from './testing/fake-ports'
import { PROVINCE_BANGKOK, PROVINCE_LOW_BAND, seededConfig } from './testing/statutory-fixture'

/**
 * M7-1 pay structures on the write side, and M7-4 on the read side.
 *
 * The property tying them together: a salary, a PF rate, a tax declaration
 * and a bank account are S3, so they are encrypted BEFORE the INSERT and
 * every subsequent read states a purpose. Neither service ever writes one
 * of them in the clear, which is what makes "a DB dump shows no plaintext"
 * a property rather than an aspiration.
 */

const EMPLOYEE = '33333333-3333-4333-8333-333333333333'
const PREPARER = '11111111-1111-4111-8111-111111111111'
const APPROVER = '22222222-2222-4222-8222-222222222222'

async function harness(province: string = PROVINCE_BANGKOK) {
  const db = new FakePayrollDb()
  const tx = db.connect()
  const config = seededConfig()
  const crypto = new CryptoClient(fakeCryptoTransport())
  const refs = new RefsRepository(db.asPool())
  const repo = new PayProfilesRepository(db.asPool())
  const service = new PayProfilesService(repo, refs, crypto, config, () => randomUUID())

  await refs.upsertEmployee(tx, {
    employeeId: EMPLOYEE,
    empCode: 'E-0001',
    status: 'active',
    provinceCode: province,
    startDate: '2020-01-01',
    preferredLang: 'th',
    orgUnitId: null,
    employmentType: 'full_time',
  })
  return { db, tx, config, crypto, refs, repo, service }
}

function dto(overrides: Partial<Parameters<PayProfilesService['upsert']>[2]> = {}) {
  return {
    basePayThb: '45000',
    payBasis: 'monthly' as const,
    recurringItems: [],
    pfRatePercent: null,
    pfRateEmployerPercent: null,
    declaration: null,
    bankCode: 'KBANK',
    bankAccount: '1234567890',
    bankAccountName: 'SOMCHAI J',
    ...overrides,
  }
}

describe('pay profile — write', () => {
  it('creates a profile and returns the view, with the bank account MASKED', async () => {
    const h = await harness()
    const view = await h.service.upsert(h.tx, EMPLOYEE, dto(), '2026-10-31')
    expect(view).toMatchObject({ employeeId: EMPLOYEE, basePayThb: '45000.00', payBasis: 'monthly', bankAccountMasked: '******7890' })
  })

  it('NOTHING SENSITIVE REACHES THE DATABASE IN THE CLEAR', async () => {
    const h = await harness()
    await h.service.upsert(h.tx, EMPLOYEE, dto({ pfRatePercent: '5', declaration: { spouse: true, children: 1, childrenSecondFrom2018: 0, parentsCaredFor: 0, otherAllowances: bahtToSatang('12000') } }), '2026-10-31')

    const row = h.db.debugTable('pay_profile')[0] ?? {}
    const raw = Buffer.concat(Object.values(row).filter((v): v is Buffer => Buffer.isBuffer(v))).toString('utf8')
    for (const secret of ['45000', '1234567890', 'SOMCHAI', '12000']) expect(raw).not.toContain(secret)
    // ...but the non-sensitive routing fields ARE plaintext, as classified.
    expect(row['pay_basis']).toBe('monthly')
    expect(row['bank_code']).toBe('KBANK')
  })

  it('a second upsert UPDATES rather than creating a duplicate — one profile per employee', async () => {
    const h = await harness()
    await h.service.upsert(h.tx, EMPLOYEE, dto(), '2026-10-31')
    const view = await h.service.upsert(h.tx, EMPLOYEE, dto({ basePayThb: '50000' }), '2026-10-31')
    expect(view.basePayThb).toBe('50000.00')
    expect(h.db.debugTable('pay_profile')).toHaveLength(1)
  })

  it('REJECTS a wage below the employee\'s provincial minimum, at the moment it is typed', async () => {
    const h = await harness()
    await expect(h.service.upsert(h.tx, EMPLOYEE, dto({ basePayThb: '11000' }), '2026-10-31')).rejects.toMatchObject({
      code: 'PAY-010',
      httpStatus: 422,
      details: [expect.objectContaining({ provinceCode: PROVINCE_BANGKOK, statutoryFloor: '400.00' })],
    })
    expect(h.db.debugTable('pay_profile')).toHaveLength(0)
  })

  it('...and the SAME wage is accepted for an employee in a lower provincial band', async () => {
    const h = await harness(PROVINCE_LOW_BAND)
    const view = await h.service.upsert(h.tx, EMPLOYEE, dto({ basePayThb: '11000' }), '2026-10-31')
    expect(view.basePayThb).toBe('11000.00')
  })

  it('an employee with no province on file is not blocked — the floor is re-checked at calculate time', async () => {
    const h = await harness()
    await h.tx.query('UPDATE payroll.payroll_employee_ref SET province_code = $2 WHERE employee_id = $1 RETURNING *', [EMPLOYEE, null])
    await expect(h.service.upsert(h.tx, EMPLOYEE, dto({ basePayThb: '11000' }), '2026-10-31')).resolves.toBeDefined()
  })

  it('REJECTS a write for a province with no notification on file (PAY-012) — fails closed', async () => {
    // Changed 2026-08-04: this used to assert the write SUCCEEDED. Accepting
    // a base pay that could not be checked against any floor is how an
    // unverified wage reaches a payslip looking checked — strictly worse
    // than having no check at all, because the payslip is indistinguishable
    // from a compliant one. The 77-province table (Spec §12 V4) is not
    // shipped, so this genuinely blocks; that is what a go-live blocker
    // should do. See the roadmap's unverified-statutory-figures section.
    const h = await harness('TH-99')
    await expect(h.service.upsert(h.tx, EMPLOYEE, dto({ basePayThb: '11000' }), '2026-10-31')).rejects.toMatchObject({
      code: 'PAY-012',
    })
  })

  it('REJECTS a provident-fund rate outside the statutory band, on either side', async () => {
    const h = await harness()
    await expect(h.service.upsert(h.tx, EMPLOYEE, dto({ pfRatePercent: '1' }), '2026-10-31')).rejects.toMatchObject({ code: 'PAY-011' })
    await expect(h.service.upsert(h.tx, EMPLOYEE, dto({ pfRatePercent: '16' }), '2026-10-31')).rejects.toMatchObject({ code: 'PAY-011' })
    await expect(h.service.upsert(h.tx, EMPLOYEE, dto({ pfRateEmployerPercent: '99' }), '2026-10-31')).rejects.toMatchObject({ code: 'PAY-011' })
    await expect(h.service.upsert(h.tx, EMPLOYEE, dto({ pfRatePercent: '2' }), '2026-10-31')).resolves.toBeDefined()
  })

  it('refuses a profile for an employee this service has never heard of', async () => {
    const h = await harness()
    await expect(h.service.upsert(h.tx, randomUUID(), dto(), '2026-10-31')).rejects.toMatchObject({ code: 'PAY-404' })
  })
})

describe('pay profile — read', () => {
  it('round-trips every encrypted field back to what was written', async () => {
    const h = await harness()
    const declaration = { spouse: true, children: 2, childrenSecondFrom2018: 1, parentsCaredFor: 1, otherAllowances: bahtToSatang('12345.67') }
    await h.service.upsert(h.tx, EMPLOYEE, dto({ pfRatePercent: '5', pfRateEmployerPercent: '7', declaration }), '2026-10-31')

    const decrypted = await h.service.decrypt(EMPLOYEE, 'test', h.tx)
    expect(decrypted).toMatchObject({ basePay: bahtToSatang('45000'), pfRatePercent: '5', pfRateEmployerPercent: '7', bankAccount: '1234567890' })
    expect(decrypted.declaration).toEqual(declaration)
  })

  it('a profile that does not exist is a 404, never an empty default that would pay someone zero', async () => {
    const h = await harness()
    await expect(h.service.decrypt(EMPLOYEE, 'test', h.tx)).rejects.toMatchObject({ code: 'PAY-404' })
    await expect(h.service.view(EMPLOYEE, 'test')).rejects.toMatchObject({ code: 'PAY-404' })
  })

  it('a blank purpose is refused by the kernel client before any S3 value is read', async () => {
    const h = await harness()
    await h.service.upsert(h.tx, EMPLOYEE, dto(), '2026-10-31')
    await expect(h.service.decrypt(EMPLOYEE, '   ', h.tx)).rejects.toThrow(/purpose is required/)
  })
})

describe('the ล.ย.01 declaration blob', () => {
  it('round-trips through its serialised form', () => {
    const declaration = { spouse: true, children: 3, childrenSecondFrom2018: 1, parentsCaredFor: 2, otherAllowances: bahtToSatang('9999.99') }
    expect(parseDeclaration(serialiseDeclaration(declaration))).toEqual(declaration)
  })

  it('a malformed blob reads as NO declaration — the engine then withholds on the personal allowance and flags the payslip, rather than failing the whole run', () => {
    expect(parseDeclaration('not json')).toBeNull()
    expect(parseDeclaration('42')).toBeNull()
  })

  it('a negative or fractional count is read as zero rather than reducing tax by a nonsense allowance', () => {
    const parsed = parseDeclaration(JSON.stringify({ children: -3, parentsCaredFor: 1.5, spouse: 'yes' }))
    expect(parsed).toMatchObject({ children: 0, parentsCaredFor: 0, spouse: false })
  })
})

describe('the in-app payslip (M7-4 read side)', () => {
  async function committedPayslip() {
    const h = await harness()
    const db = h.db
    const runsRepo = new RunsRepository(db.asPool())
    const payslipsRepo = new PayslipsRepository(db.asPool())
    const payslipsService = new PayslipsService(payslipsRepo, runsRepo, h.crypto)
    const timesheets = new FakeTimesheetClient()
    const runs = new RunsService(
      runsRepo,
      h.repo,
      h.service,
      payslipsRepo,
      new PayInputsRepository(db.asPool()),
      h.refs,
      h.config,
      h.crypto,
      timesheets,
      new FakeDocsClient(),
      new FakeExportRecorder(),
      () => randomUUID(),
      () => '2026-11-01T00:00:00.000Z',
    )
    await h.service.upsert(h.tx, EMPLOYEE, dto(), '2026-10-31')
    await h.refs.upsertTimesheetLock(h.tx, { period: '2026-10', lockVersion: 7, locked: true, lockedBy: PREPARER })
    timesheets.seed('2026-10', 7, {})
    const run = await runs.createRun(h.tx, {
      period: '2026-10',
      runType: 'regular',
      preparedBy: PREPARER,
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      payDate: '2026-10-31',
    })
    await runs.calculate(h.tx, run.id, [EMPLOYEE])
    await runs.review(h.tx, run.id, PREPARER)
    await runs.approve(h.tx, run.id, APPROVER)
    await runs.commit(h.tx, run.id)
    return { ...h, payslipsService, run }
  }

  it('renders every figure through the kernel THB formatter, in the employee\'s language, with B.E. dates', async () => {
    const h = await committedPayslip()
    const [slip] = await h.payslipsService.listForEmployee(EMPLOYEE, null, h.tx)
    expect(slip).toMatchObject({
      lang: 'th',
      period: '2026-10',
      payDate: '31/10/2569',
      gross: '฿45,000.00',
      ssoEmployee: '฿875.00',
      ssoEmployer: '฿875.00',
      ewfEmployee: '฿43.75',
      net: '฿44,081.25',
    })
  })

  it('an employee may read their own payslip in another language without re-rendering the PDF', async () => {
    const h = await committedPayslip()
    const [slip] = await h.payslipsService.listForEmployee(EMPLOYEE, 'en', h.tx)
    expect(slip?.lang).toBe('en')
    expect(slip?.payDate).toBe('31/10/2026')
  })

  it('itemises the payslip into its categorised lines', async () => {
    const h = await committedPayslip()
    const [slip] = await h.payslipsService.listForRun(h.run.id, h.tx)
    expect(slip?.lines.map((l) => l.kind)).toEqual(
      expect.arrayContaining(['earning:base_pay', 'employee_deduction:sso_employee', 'employer_contribution:sso_employer']),
    )
  })

  it('carries the encrypted PDF reference, decrypted only for a caller who stated a purpose', async () => {
    const h = await committedPayslip()
    const [slip] = await h.payslipsService.listForRun(h.run.id, h.tx)
    expect(slip?.pdfRef).toMatch(/^minio:\/\/payslips\//)
  })

  it('getOne refuses a payslip that does not exist', async () => {
    const h = await committedPayslip()
    await expect(h.payslipsService.getOne(randomUUID(), 'test', h.tx)).rejects.toMatchObject({ code: 'PAY-404' })
  })
})
