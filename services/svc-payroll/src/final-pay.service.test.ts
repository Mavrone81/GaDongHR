import { randomUUID } from 'node:crypto'
import { CryptoClient } from '@gadong/kernel'
import { satangToBaht } from './money'
import { decryptMoney } from './money-crypto'
import { FinalPayService } from './final-pay.service'
import { PayProfilesRepository } from './pay-profiles.repository'
import { PayProfilesService } from './pay-profiles.service'
import { PayInputsRepository } from './pay-inputs.repository'
import { RefsRepository } from './refs.repository'
import { FakePayrollDb } from './testing/fake-db'
import { fakeCryptoTransport } from './testing/fake-crypto-transport'
import { PROVINCE_BANGKOK, seededConfig } from './testing/statutory-fixture'

/**
 * M7-7 — termination pay. Severance by the s.118 tiers, pay in lieu of
 * notice under s.17, and the s.119 cause that may void severance and MUST
 * be recorded with its citation when it does.
 */

const EMPLOYEE = '33333333-3333-4333-8333-333333333333'
const PERIOD = '2026-10'

async function harness(options: { startDate?: string; terminationDate?: string; noticeGiven?: boolean; statutoryCause?: string | null; statutoryCitation?: string | null; basePayThb?: string } = {}) {
  const db = new FakePayrollDb()
  const tx = db.connect()
  const config = seededConfig()
  const crypto = new CryptoClient(fakeCryptoTransport())
  const refs = new RefsRepository(db.asPool())
  const profilesRepo = new PayProfilesRepository(db.asPool())
  const profilesService = new PayProfilesService(profilesRepo, refs, crypto, config, () => randomUUID())
  const payInputs = new PayInputsRepository(db.asPool())
  const service = new FinalPayService(refs, profilesService, payInputs, config, crypto, () => randomUUID())

  await refs.upsertEmployee(tx, {
    employeeId: EMPLOYEE,
    empCode: 'E-1',
    status: 'active',
    provinceCode: PROVINCE_BANGKOK,
    startDate: options.startDate ?? '2020-01-01',
    preferredLang: 'th',
    orgUnitId: null,
    employmentType: 'full_time',
  })
  await profilesService.upsert(
    tx,
    EMPLOYEE,
    {
      basePayThb: options.basePayThb ?? '45000',
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
  if (options.terminationDate !== undefined) {
    await refs.upsertTermination(tx, {
      employeeId: EMPLOYEE,
      terminationDate: options.terminationDate,
      lastWorkingDay: options.terminationDate,
      reasonCategory: 'employer_termination',
      statutoryCause: options.statutoryCause ?? null,
      statutoryCitation: options.statutoryCitation ?? null,
      noticeGiven: options.noticeGiven ?? false,
    })
  }
  return { db, tx, config, crypto, refs, payInputs, service }
}

describe('final pay — severance by the s.118 tiers', () => {
  it('three years of service: 180 days of last wage, cited to s.118', async () => {
    const h = await harness({ startDate: '2020-01-01', terminationDate: '2023-01-01', noticeGiven: true })
    const assessment = await h.service.assess(h.tx, EMPLOYEE, PERIOD)

    expect(assessment.service).toEqual({ totalDays: 1097, completedYears: 3 })
    expect(assessment.severanceDays).toBe(180)
    expect(satangToBaht(assessment.severance)).toBe('270000.00')
    expect(assessment.severanceTier?.citation).toBe('LPA s.118')
  })

  it('one day earlier is the 90-day tier — a 135,000 THB difference decided by a date comparison', async () => {
    const h = await harness({ startDate: '2020-01-01', terminationDate: '2022-12-31', noticeGiven: true })
    const assessment = await h.service.assess(h.tx, EMPLOYEE, PERIOD)
    expect(assessment.severanceDays).toBe(90)
    expect(satangToBaht(assessment.severance)).toBe('135000.00')
  })

  it('under 120 days of service: no severance, and no tier — a legitimate answer under s.118', async () => {
    const h = await harness({ startDate: '2026-08-01', terminationDate: '2026-10-31', noticeGiven: true })
    const assessment = await h.service.assess(h.tx, EMPLOYEE, PERIOD)
    expect(assessment.severanceDays).toBe(0)
    expect(assessment.severance).toBe(0n)
    expect(assessment.severanceTier).toBeNull()
    expect(assessment.components).toHaveLength(0)
  })

  it('the severance is QUEUED as a pay input, encrypted, so the final-pay run pays it through the ordinary engine', async () => {
    const h = await harness({ startDate: '2020-01-01', terminationDate: '2023-01-01', noticeGiven: true })
    await h.service.assess(h.tx, EMPLOYEE, PERIOD)

    const inputs = await h.payInputs.listOutstanding(EMPLOYEE, PERIOD, h.tx)
    expect(inputs).toHaveLength(1)
    const input = inputs[0]
    if (input === undefined) throw new Error('no input')
    expect(input).toMatchObject({ source: 'severance', kind: 'severance', direction: 'earning' })
    // The classification comes from the rule pack, not from this code.
    expect(input.taxable).toBe(true)
    expect(input.ssoWageBase).toBe(false)
    // ...and it is a one-off, so the annualised method adds it once.
    expect(input.meta).toMatchObject({ oneOff: true })
    expect(satangToBaht(await decryptMoney(h.crypto, input.id, 'amount', input.amount, 'test'))).toBe('270000.00')

    const raw = Buffer.concat(Object.values(h.db.debugTable('pay_input')[0] ?? {}).filter((v): v is Buffer => Buffer.isBuffer(v))).toString('utf8')
    expect(raw).not.toContain('270000')
  })

  it('re-assessing the same termination cannot queue a second severance line', async () => {
    const h = await harness({ startDate: '2020-01-01', terminationDate: '2023-01-01', noticeGiven: true })
    await h.service.assess(h.tx, EMPLOYEE, PERIOD)
    await expect(h.service.assess(h.tx, EMPLOYEE, PERIOD)).rejects.toMatchObject({ constraint: 'pay_input_source_source_ref_key' })
  })
})

describe('final pay — LPA s.119 statutory cause', () => {
  it('a recorded cause WITH its citation voids severance, and the assessment says which law was relied on', async () => {
    const h = await harness({
      startDate: '2020-01-01',
      terminationDate: '2023-01-01',
      noticeGiven: true,
      statutoryCause: 'wilful_damage_to_employer',
      statutoryCitation: 'LPA s.119(2)',
    })
    const assessment = await h.service.assess(h.tx, EMPLOYEE, PERIOD)

    expect(assessment.severance).toBe(0n)
    expect(assessment.severanceDays).toBe(0)
    expect(assessment.withheldCause).toEqual({ cause: 'wilful_damage_to_employer', citation: 'LPA s.119(2)' })
    expect(await h.payInputs.listOutstanding(EMPLOYEE, PERIOD, h.tx)).toHaveLength(0)
  })

  it('a cause recorded WITHOUT a citation is refused (PAY-060) — "we had a reason" with no record is not a defence', async () => {
    const h = await harness({
      startDate: '2020-01-01',
      terminationDate: '2023-01-01',
      noticeGiven: true,
      statutoryCause: 'wilful_damage_to_employer',
      statutoryCitation: null,
    })
    await expect(h.service.assess(h.tx, EMPLOYEE, PERIOD)).rejects.toMatchObject({ code: 'PAY-060' })
  })

  it('a citation with no cause is equally refused', async () => {
    const h = await harness({ startDate: '2020-01-01', terminationDate: '2023-01-01', noticeGiven: true, statutoryCause: null, statutoryCitation: 'LPA s.119(2)' })
    await expect(h.service.assess(h.tx, EMPLOYEE, PERIOD)).rejects.toMatchObject({ code: 'PAY-060' })
  })

  it('withholding severance does NOT withhold pay in lieu of notice — s.17 and s.118 are different obligations', async () => {
    const h = await harness({
      startDate: '2020-01-01',
      terminationDate: '2023-01-01',
      noticeGiven: false,
      statutoryCause: 'wilful_damage_to_employer',
      statutoryCitation: 'LPA s.119(2)',
    })
    const assessment = await h.service.assess(h.tx, EMPLOYEE, PERIOD)
    expect(assessment.severance).toBe(0n)
    expect(satangToBaht(assessment.noticeInLieu)).toBe('45000.00')
  })
})

describe('final pay — notice in lieu (LPA s.17)', () => {
  it('owed when notice was not given', async () => {
    const h = await harness({ startDate: '2020-01-01', terminationDate: '2023-01-01', noticeGiven: false })
    const assessment = await h.service.assess(h.tx, EMPLOYEE, PERIOD)
    expect(satangToBaht(assessment.noticeInLieu)).toBe('45000.00')
    const queued = await h.payInputs.listOutstanding(EMPLOYEE, PERIOD, h.tx)
    const notice = queued.find((i) => i.source === 'notice_in_lieu')
    // Pay in lieu IS wages for the period it replaces, so it carries the
    // ordinary wage classification.
    expect(notice).toMatchObject({ taxable: true, ssoWageBase: true })
  })

  it('not owed when notice was given', async () => {
    const h = await harness({ startDate: '2020-01-01', terminationDate: '2023-01-01', noticeGiven: true })
    const assessment = await h.service.assess(h.tx, EMPLOYEE, PERIOD)
    expect(assessment.noticeInLieu).toBe(0n)
  })

  it('THE NOTICE PERIOD IS DATA: doubling it in config doubles the amount', async () => {
    const h = await harness({ startDate: '2020-01-01', terminationDate: '2023-01-01', noticeGiven: false })
    h.config.amend('notice.min_pay_periods', '2023-01-01', '2')
    const assessment = await h.service.assess(h.tx, EMPLOYEE, PERIOD)
    expect(satangToBaht(assessment.noticeInLieu)).toBe('90000.00')
  })
})

describe('final pay — preconditions', () => {
  it('refuses an employee with no termination record', async () => {
    const h = await harness({ startDate: '2020-01-01' })
    await expect(h.service.assess(h.tx, EMPLOYEE, PERIOD)).rejects.toMatchObject({ code: 'PAY-061' })
  })

  it('refuses an employee with no start date — the severance tier cannot be determined', async () => {
    const h = await harness({ startDate: '2020-01-01', terminationDate: '2023-01-01' })
    await h.refs.upsertTimesheetLock(h.tx, { period: PERIOD, lockVersion: 1, locked: true, lockedBy: null })
    await h.tx.query('UPDATE payroll.payroll_employee_ref SET start_date = $2 WHERE employee_id = $1 RETURNING *', [EMPLOYEE, null])
    await expect(h.service.assess(h.tx, EMPLOYEE, PERIOD)).rejects.toMatchObject({ code: 'PAY-061' })
  })

  it('resolves the tiers AS OF THE TERMINATION DATE — a tier table amended afterwards does not rewrite history', async () => {
    const h = await harness({ startDate: '2020-01-01', terminationDate: '2023-01-01', noticeGiven: true })
    await h.service.assess(h.tx, EMPLOYEE, PERIOD)
    const tierRequests = h.config.requests.filter((r) => r.ruleKey === 'severance.tiers')
    expect(tierRequests).toHaveLength(1)
    expect(tierRequests[0]?.on).toBe('2023-01-01')
  })
})
