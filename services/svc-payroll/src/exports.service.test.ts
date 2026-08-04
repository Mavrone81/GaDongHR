import { randomUUID } from 'node:crypto'
import { CryptoClient } from '@gadong/kernel'
import { decryptText } from './money-crypto'
import { ExportsRepository } from './exports.repository'
import { ExportsService } from './exports.service'
import { PayProfilesRepository } from './pay-profiles.repository'
import { PayProfilesService } from './pay-profiles.service'
import { PayInputsRepository } from './pay-inputs.repository'
import { PayslipsRepository } from './payslips.repository'
import { RefsRepository } from './refs.repository'
import { RunsRepository } from './runs.repository'
import { RunsService } from './runs.service'
import { FakePayrollDb } from './testing/fake-db'
import { fakeCryptoTransport } from './testing/fake-crypto-transport'
import { FakeDirectoryClient, FakeDocsClient, FakeTimesheetClient } from './testing/fake-ports'
import { PROVINCE_BANGKOK, seededConfig } from './testing/statutory-fixture'

/**
 * M7-5 and M7-6, end to end from a COMMITTED run.
 *
 * The generation timing is forced by the schema and is the thing worth
 * asserting: `statutory_export` rows are written INSIDE the commit
 * transaction (the INSERT trigger refuses afterwards), and the download
 * endpoints RE-RENDER from the immutable payslips instead of mutating
 * anything. That re-rendering is also what makes an export reproducible for
 * an auditor years later, which the determinism test below pins.
 */

const PREPARER = '11111111-1111-4111-8111-111111111111'
const APPROVER = '22222222-2222-4222-8222-222222222222'
const EMPLOYEE_A = '33333333-3333-4333-8333-333333333333'
const EMPLOYEE_B = '44444444-4444-4444-8444-444444444444'
const PERIOD = '2026-10'

async function harness(options: { bankAccounts?: boolean } = {}) {
  const db = new FakePayrollDb()
  const tx = db.connect()
  const config = seededConfig()
  const crypto = new CryptoClient(fakeCryptoTransport())

  const profilesRepo = new PayProfilesRepository(db.asPool())
  const runsRepo = new RunsRepository(db.asPool())
  const payslipsRepo = new PayslipsRepository(db.asPool())
  const payInputsRepo = new PayInputsRepository(db.asPool())
  const refsRepo = new RefsRepository(db.asPool())
  const exportsRepo = new ExportsRepository(db.asPool())
  const profilesService = new PayProfilesService(profilesRepo, refsRepo, crypto, config, () => randomUUID())
  const directory = new FakeDirectoryClient()
  const exports = new ExportsService(runsRepo, payslipsRepo, profilesRepo, profilesService, refsRepo, exportsRepo, directory, config, crypto, () => randomUUID())
  const timesheets = new FakeTimesheetClient()
  const runs = new RunsService(
    runsRepo,
    profilesRepo,
    profilesService,
    payslipsRepo,
    payInputsRepo,
    refsRepo,
    config,
    crypto,
    timesheets,
    new FakeDocsClient(),
    exports,
    () => randomUUID(),
    () => '2026-11-01T00:00:00.000Z',
  )

  await refsRepo.upsertTimesheetLock(tx, { period: PERIOD, lockVersion: 7, locked: true, lockedBy: PREPARER })
  timesheets.seed(PERIOD, 7, {})

  const employees: Array<[string, string, string, string]> = [
    [EMPLOYEE_A, 'E-0001', 'สมชาย ใจดี', '1234567890123'],
    [EMPLOYEE_B, 'E-0002', 'มาลี สุข', '9876543210987'],
  ]
  for (const [id, code, name, nid] of employees) {
    await refsRepo.upsertEmployee(tx, {
      employeeId: id,
      empCode: code,
      status: 'active',
      provinceCode: PROVINCE_BANGKOK,
      startDate: '2020-01-01',
      preferredLang: 'th',
      orgUnitId: null,
      employmentType: 'full_time',
    })
    directory.seed(id, { fullName: name, nationalId: nid })
    await profilesService.upsert(
      tx,
      id,
      {
        basePayThb: '45000',
        payBasis: 'monthly',
        recurringItems: [],
        pfRatePercent: null,
        pfRateEmployerPercent: null,
        declaration: null,
        bankCode: options.bankAccounts === false ? null : 'KBANK',
        bankAccount: options.bankAccounts === false ? null : `12345678${code.slice(-2)}`,
        bankAccountName: options.bankAccounts === false ? null : name,
      },
      '2026-10-31',
    )
  }

  return { db, tx, config, crypto, runs, exports, exportsRepo, runsRepo, payslipsRepo, directory }
}

async function committedRun(h: Awaited<ReturnType<typeof harness>>) {
  const run = await h.runs.createRun(h.tx, {
    period: PERIOD,
    runType: 'regular',
    preparedBy: PREPARER,
    periodStart: '2026-10-01',
    periodEnd: '2026-10-31',
    payDate: '2026-10-31',
  })
  await h.runs.calculate(h.tx, run.id, [EMPLOYEE_A, EMPLOYEE_B])
  await h.runs.review(h.tx, run.id, PREPARER)
  await h.runs.approve(h.tx, run.id, APPROVER)
  await h.runs.commit(h.tx, run.id)
  return run
}

describe('exports are RECORDED inside the commit transaction', () => {
  it('one immutable row per export kind, with an ENCRYPTED MinIO reference', async () => {
    const h = await harness()
    const run = await committedRun(h)

    const recorded = await h.exportsRepo.listByRun(run.id, h.tx)
    expect(recorded.map((r) => r.kind).sort()).toEqual(
      ['50bis', 'bank_bbl', 'bank_csv', 'bank_kbank', 'bank_krungsri', 'bank_scb', 'pnd1', 'sso_1_10'].filter((k) =>
        ['sso_1_10', 'pnd1', 'bank_csv', 'bank_kbank', 'bank_scb', 'bank_bbl', 'bank_krungsri'].includes(k),
      ).sort(),
    )

    const first = recorded[0]
    if (first === undefined) throw new Error('nothing recorded')
    expect(await decryptText(h.crypto, first.id, 'file_ref', first.fileRef, 'test')).toContain(`payroll/${PERIOD}/${run.id}/`)

    const raw = Buffer.concat(Object.values(h.db.debugTable('statutory_export')[0] ?? {}).filter((v): v is Buffer => Buffer.isBuffer(v))).toString('utf8')
    expect(raw).not.toContain('payroll/2026-10')
  })

  it('...and the schema refuses a NEW export against the already-committed run', async () => {
    const h = await harness()
    const run = await committedRun(h)
    await expect(
      h.exportsRepo.insert(h.tx, { id: randomUUID(), runId: run.id, kind: 'pnd1', fileRef: Buffer.alloc(200) }),
    ).rejects.toMatchObject({ constraint: 'statutory_export_immutable_when_run_committed' })
  })
})

describe('statutory exports render from the committed payslips', () => {
  it('สปส.1-10 reports the capped wage and the contributions, per employee, with real names and national IDs', async () => {
    const h = await harness()
    const run = await committedRun(h)
    const out = await h.exports.renderStatutory(run.id, 'sso_1_10', h.tx)

    expect(out.rows).toHaveLength(2)
    expect(out.rows[0]).toMatchObject({ national_id: '1234567890123', full_name: 'สมชาย ใจดี', wage_thb: '17500.00', employee_contribution_thb: '875.00' })
    expect(out.totals).toMatchObject({ employee_count: '2', total_employee_thb: '1750.00', total_employer_thb: '1750.00' })
  })

  it('ภ.ง.ด.1 reports the taxable gross, not the SSO-capped wage — two different bases, one payslip', async () => {
    const h = await harness()
    const run = await committedRun(h)
    const out = await h.exports.renderStatutory(run.id, 'pnd1', h.tx)
    expect(out.rows[0]).toMatchObject({ income_thb: '45000.00', income_type: '40(1)' })
  })

  it('the annual forms render from the same committed data, in Buddhist Era', async () => {
    const h = await harness()
    const run = await committedRun(h)
    expect((await h.exports.renderStatutory(run.id, 'pnd1kor', h.tx)).totals['tax_year_be']).toBe('2569')
    expect((await h.exports.renderStatutory(run.id, '50bis', h.tx)).rows[0]?.['issued_on_be']).toBe('31/10/2569')
    expect((await h.exports.renderStatutory(run.id, 'kor_ror_11', h.tx)).totals['headcount_active']).toBe('2')
  })

  it('RE-RENDERING IS DETERMINISTIC — the same committed run produces byte-identical output, which is what makes it auditable', async () => {
    const h = await harness()
    const run = await committedRun(h)
    const first = await h.exports.renderStatutory(run.id, 'sso_1_10', h.tx)
    const second = await h.exports.renderStatutory(run.id, 'sso_1_10', h.tx)
    expect(second.csv).toBe(first.csv)
    expect(second.totals).toEqual(first.totals)
  })

  it('an UNCOMMITTED run cannot be exported (PAY-050) — a filing of figures that may still change', async () => {
    const h = await harness()
    const run = await h.runs.createRun(h.tx, {
      period: PERIOD,
      runType: 'regular',
      preparedBy: PREPARER,
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      payDate: '2026-10-31',
    })
    await h.runs.calculate(h.tx, run.id, [EMPLOYEE_A])
    await expect(h.exports.renderStatutory(run.id, 'sso_1_10', h.tx)).rejects.toMatchObject({ code: 'PAY-050' })
  })

  it('an unknown run is a 404, not an empty filing', async () => {
    const h = await harness()
    await expect(h.exports.renderStatutory(randomUUID(), 'pnd1', h.tx)).rejects.toMatchObject({ code: 'PAY-404' })
  })

  it('an employee the directory does not know leaves the identity columns blank rather than filing a wrong national ID', async () => {
    const h = await harness()
    const run = await committedRun(h)
    const bare = new ExportsService(
      h.runsRepo,
      h.payslipsRepo,
      new PayProfilesRepository(h.db.asPool()),
      new PayProfilesService(new PayProfilesRepository(h.db.asPool()), new RefsRepository(h.db.asPool()), h.crypto, h.config, () => randomUUID()),
      new RefsRepository(h.db.asPool()),
      h.exportsRepo,
      new FakeDirectoryClient(),
      h.config,
      h.crypto,
      () => randomUUID(),
    )
    const out = await bare.renderStatutory(run.id, 'sso_1_10', h.tx)
    expect(out.rows[0]).toMatchObject({ national_id: '', full_name: '' })
  })
})

describe('bank files render from the committed payslips', () => {
  it('the generic CSV carries every employee\'s net pay and the employer originator from config', async () => {
    const h = await harness()
    const run = await committedRun(h)
    const out = await h.exports.renderBankFile(run.id, 'generic', h.tx)

    expect(out.recordCount).toBe(2)
    // 2 x 44,081.25 — the October net, with EWF in force.
    expect(out.totalSatang).toBe(8_816_250n)
    expect(out.content).toContain('44081.25')
  })

  it('a fixed-width bank file carries the same total, encoded as satang digits', async () => {
    const h = await harness()
    const run = await committedRun(h)
    const out = await h.exports.renderBankFile(run.id, 'kbank', h.tx)
    expect(out.content.split('\n')).toHaveLength(4)
    expect(out.content).toContain('8816250'.padStart(15, '0'))
  })

  it('REFUSES the whole file when an employee has no bank account (PAY-052) — paying some and skipping others is worse', async () => {
    const h = await harness({ bankAccounts: false })
    const run = await committedRun(h)
    await expect(h.exports.renderBankFile(run.id, 'generic', h.tx)).rejects.toMatchObject({ code: 'PAY-052' })
  })

  it('an uncommitted run has no bank file (PAY-050)', async () => {
    const h = await harness()
    const run = await h.runs.createRun(h.tx, {
      period: PERIOD,
      runType: 'regular',
      preparedBy: PREPARER,
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      payDate: '2026-10-31',
    })
    await expect(h.exports.renderBankFile(run.id, 'generic', h.tx)).rejects.toMatchObject({ code: 'PAY-050' })
  })

  it('an unknown format is PAY-051', async () => {
    const h = await harness()
    const run = await committedRun(h)
    await expect(h.exports.renderBankFile(run.id, 'citibank', h.tx)).rejects.toMatchObject({ code: 'PAY-051' })
  })
})
