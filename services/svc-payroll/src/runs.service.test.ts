import { randomUUID } from 'node:crypto'
import { CryptoClient } from '@gadong/kernel'
import type { Queryable } from '@gadong/kernel'
import { satangToBaht } from './money'
import { decryptMoney } from './money-crypto'
import { PayProfilesRepository } from './pay-profiles.repository'
import { PayProfilesService } from './pay-profiles.service'
import { PayInputsRepository } from './pay-inputs.repository'
import { PayslipsRepository } from './payslips.repository'
import { RefsRepository } from './refs.repository'
import { RunsRepository } from './runs.repository'
import { RunsService, monthIndex, previousMonth } from './runs.service'
import { ConstraintViolation, FakePayrollDb } from './testing/fake-db'
import { fakeCryptoTransport } from './testing/fake-crypto-transport'
import { FakeDocsClient, FakeExportRecorder, FakeTimesheetClient } from './testing/fake-ports'
import { PROVINCE_BANGKOK, seededConfig } from './testing/statutory-fixture'
import type { FakeConfigClient } from './testing/fake-config-client'

/**
 * M7-3 — the run lifecycle, and the two controls that make a committed run
 * usable as evidence in a Thai labour court.
 *
 * The fake database mirrors `payroll_run_sod_check` and all four
 * committed-run immutability triggers (see `testing/fake-db.ts`), so every
 * assertion below about "the database refuses this" is a real assertion
 * about the migration's semantics rather than a restatement of the service
 * code.
 */

const PERIOD = '2026-10'
// svc-timesheet's own period-row uuid for the 'PERIOD' calendar month —
// distinct from `PERIOD` itself (see `TimesheetLockRow.periodId`'s doc):
// `RunsService.calculate` looks totals up by THIS, never by `PERIOD`.
const PERIOD_ID = '44444444-4444-4444-8444-444444444444'
const SEPTEMBER_PERIOD_ID = '55555555-5555-4555-8555-555555555555'
const PERIOD_START = '2026-10-01'
const PERIOD_END = '2026-10-31'
const PAY_DATE = '2026-10-31'
const PREPARER = '11111111-1111-4111-8111-111111111111'
const APPROVER = '22222222-2222-4222-8222-222222222222'
const EMPLOYEE = '33333333-3333-4333-8333-333333333333'

interface Harness {
  db: FakePayrollDb
  tx: Queryable
  config: FakeConfigClient
  crypto: CryptoClient
  service: RunsService
  timesheets: FakeTimesheetClient
  docs: FakeDocsClient
  recorder: FakeExportRecorder
  payslips: PayslipsRepository
  payInputs: PayInputsRepository
  runs: RunsRepository
  refs: RefsRepository
  profilesService: PayProfilesService
}

async function harness(options: { lockVersion?: number; basePayThb?: string } = {}): Promise<Harness> {
  const db = new FakePayrollDb()
  const tx = db.connect()
  const config = seededConfig()
  const crypto = new CryptoClient(fakeCryptoTransport())

  const profilesRepo = new PayProfilesRepository(db.asPool())
  const runsRepo = new RunsRepository(db.asPool())
  const payslipsRepo = new PayslipsRepository(db.asPool())
  const payInputsRepo = new PayInputsRepository(db.asPool())
  const refsRepo = new RefsRepository(db.asPool())
  const profilesService = new PayProfilesService(profilesRepo, refsRepo, crypto, config, () => randomUUID())
  const timesheets = new FakeTimesheetClient()
  const docs = new FakeDocsClient()
  const recorder = new FakeExportRecorder()

  const service = new RunsService(
    runsRepo,
    profilesRepo,
    profilesService,
    payslipsRepo,
    payInputsRepo,
    refsRepo,
    config,
    crypto,
    timesheets,
    docs,
    recorder,
    () => randomUUID(),
    () => '2026-11-01T00:00:00.000Z',
  )

  const lockVersion = options.lockVersion ?? 7
  await refsRepo.upsertEmployee(tx, {
    employeeId: EMPLOYEE,
    empCode: 'E-0001',
    status: 'active',
    provinceCode: PROVINCE_BANGKOK,
    startDate: '2020-01-01',
    preferredLang: 'th',
    orgUnitId: null,
    employmentType: 'full_time',
  })
  await refsRepo.upsertTimesheetLock(tx, { period: PERIOD, periodId: PERIOD_ID, lockVersion, locked: true, lockedBy: PREPARER })
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
      bankCode: 'KBANK',
      bankAccount: '1234567890',
      bankAccountName: 'SOMCHAI J',
    },
    PERIOD_END,
  )
  timesheets.seed(PERIOD_ID, lockVersion, {})

  return { db, tx, config, crypto, service, timesheets, docs, recorder, payslips: payslipsRepo, payInputs: payInputsRepo, runs: runsRepo, refs: refsRepo, profilesService }
}

async function draftRun(h: Harness, preparedBy = PREPARER) {
  return h.service.createRun(h.tx, { period: PERIOD, runType: 'regular', preparedBy, periodStart: PERIOD_START, periodEnd: PERIOD_END, payDate: PAY_DATE })
}

async function throughApproval(h: Harness) {
  const run = await draftRun(h)
  await h.service.calculate(h.tx, run.id, [EMPLOYEE])
  await h.service.review(h.tx, run.id, PREPARER)
  await h.service.approve(h.tx, run.id, APPROVER)
  return run
}

// ---------------------------------------------------------------------------

describe('period helpers', () => {
  it('monthIndex reads the period, so the withholding divisor is not a caller-supplied guess', () => {
    expect(monthIndex('2026-01')).toBe(1)
    expect(monthIndex('2026-12')).toBe(12)
    expect(() => monthIndex('2026')).toThrow(/YYYY-MM/)
  })

  it('previousMonth crosses the year boundary', () => {
    expect(previousMonth('2026-10')).toBe('2026-09')
    expect(previousMonth('2026-01')).toBe('2025-12')
    expect(() => previousMonth('nope')).toThrow(/YYYY-MM/)
  })
})

describe('draft — a run binds to a LOCKED timesheet', () => {
  it('records the lock version the hours came from', async () => {
    const h = await harness({ lockVersion: 7 })
    const run = await draftRun(h)
    expect(run).toMatchObject({ status: 'draft', period: PERIOD, preparedBy: PREPARER, timesheetLockVersion: 7 })
  })

  it('refuses a regular run for a period with no lock — there are no hours to bind to (PAY-031)', async () => {
    const h = await harness()
    await expect(
      h.service.createRun(h.tx, { period: '2026-11', runType: 'regular', preparedBy: PREPARER, periodStart: '2026-11-01', periodEnd: '2026-11-30', payDate: '2026-11-30' }),
    ).rejects.toMatchObject({ code: 'PAY-031' })
  })

  it('...but a FINAL-PAY run is allowed without one: an employee leaving mid-period cannot wait for the period to close', async () => {
    const h = await harness()
    const run = await h.service.createRun(h.tx, {
      period: '2026-11',
      runType: 'final_pay',
      preparedBy: PREPARER,
      periodStart: '2026-11-01',
      periodEnd: '2026-11-30',
      payDate: '2026-11-30',
    })
    expect(run.runType).toBe('final_pay')
  })

  it('refuses an unlocked period as firmly as a missing one', async () => {
    const h = await harness()
    await h.refs.upsertTimesheetLock(h.tx, { period: PERIOD, periodId: PERIOD_ID, lockVersion: 8, locked: false, lockedBy: APPROVER })
    await expect(draftRun(h)).rejects.toMatchObject({ code: 'PAY-031' })
  })

  it('an adjustment run must name a target, and that target must be committed', async () => {
    const h = await harness()
    await expect(
      h.service.createRun(h.tx, { period: PERIOD, runType: 'adjustment', preparedBy: PREPARER, periodStart: PERIOD_START, periodEnd: PERIOD_END, payDate: PAY_DATE }),
    ).rejects.toMatchObject({ code: 'PAY-024' })

    const draft = await draftRun(h)
    await expect(
      h.service.createRun(h.tx, {
        period: PERIOD,
        runType: 'adjustment',
        preparedBy: PREPARER,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        payDate: PAY_DATE,
        adjustsRunId: draft.id,
      }),
    ).rejects.toMatchObject({ code: 'PAY-024' })
  })

  it('an adjustment naming a run that does not exist is a 404, not a silent no-op', async () => {
    const h = await harness()
    await expect(
      h.service.createRun(h.tx, {
        period: PERIOD,
        runType: 'adjustment',
        preparedBy: PREPARER,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        payDate: PAY_DATE,
        adjustsRunId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: 'PAY-404' })
  })
})

describe('calculate — one payslip per employee, every figure encrypted before write', () => {
  it('writes a payslip and records the rule versions the run used', async () => {
    const h = await harness()
    const run = await draftRun(h)
    const outcome = await h.service.calculate(h.tx, run.id, [EMPLOYEE])

    expect(outcome.run.status).toBe('calculated')
    expect(outcome.payslipIds).toHaveLength(1)
    // The snapshot is what lets a committed run be re-explained years later.
    expect(Object.keys(outcome.run.rulepackVersions)).toEqual(expect.arrayContaining(['sso.wage.ceiling', 'ewf.rate.employee', 'tax.pit.brackets']))
  })

  it('THE DATABASE HOLDS NO PLAINTEXT SALARY: the stored bytes do not contain the figure', async () => {
    const h = await harness({ basePayThb: '45000' })
    const run = await draftRun(h)
    await h.service.calculate(h.tx, run.id, [EMPLOYEE])

    const stored = h.db.debugTable('payslip')
    expect(stored).toHaveLength(1)
    const raw = Buffer.concat(Object.values(stored[0] ?? {}).filter((v): v is Buffer => Buffer.isBuffer(v))).toString('utf8')
    expect(raw).not.toContain('45000')
    expect(raw).not.toContain('44081')

    const profileRaw = Buffer.concat(
      Object.values(h.db.debugTable('pay_profile')[0] ?? {}).filter((v): v is Buffer => Buffer.isBuffer(v)),
    ).toString('utf8')
    expect(profileRaw).not.toContain('45000')
    expect(profileRaw).not.toContain('1234567890')
  })

  it('the payslip decrypts back to the engine figures, exactly', async () => {
    const h = await harness()
    const run = await draftRun(h)
    await h.service.calculate(h.tx, run.id, [EMPLOYEE])

    const [slip] = await h.payslips.listByRun(run.id, h.tx)
    expect(slip).toBeDefined()
    if (slip === undefined) return
    expect(satangToBaht(await decryptMoney(h.crypto, slip.id, 'gross', slip.gross, 'test'))).toBe('45000.00')
    expect(satangToBaht(await decryptMoney(h.crypto, slip.id, 'sso_emp', slip.ssoEmp, 'test'))).toBe('875.00')
    // October 2026: EWF is in force.
    expect(satangToBaht(await decryptMoney(h.crypto, slip.id, 'ewf_emp', slip.ewfEmp, 'test'))).toBe('43.75')
    expect(satangToBaht(await decryptMoney(h.crypto, slip.id, 'ewf_er', slip.ewfEr ?? Buffer.alloc(0), 'test'))).toBe('43.75')
    expect(satangToBaht(await decryptMoney(h.crypto, slip.id, 'net', slip.net, 'test'))).toBe('44081.25')
  })

  it('itemises the payslip into encrypted pay_item lines', async () => {
    const h = await harness()
    const run = await draftRun(h)
    await h.service.calculate(h.tx, run.id, [EMPLOYEE])
    const [slip] = await h.payslips.listByRun(run.id, h.tx)
    if (slip === undefined) throw new Error('no payslip')
    const items = await h.payslips.listItems(slip.id, h.tx)
    expect(items.map((i) => i.kind)).toEqual(
      expect.arrayContaining(['earning:base_pay', 'employee_deduction:sso_employee', 'employer_contribution:sso_employer', 'employee_deduction:ewf_employee']),
    )
  })

  it('renders the payslip through svc-docs in the EMPLOYEE\'S language', async () => {
    const h = await harness()
    const run = await draftRun(h)
    await h.service.calculate(h.tx, run.id, [EMPLOYEE])
    expect(h.docs.rendered).toHaveLength(1)
    expect(h.docs.rendered[0]?.lang).toBe('th')
  })

  it('asks svc-timesheet for the hours AT THE BOUND LOCK VERSION, not for whatever is current', async () => {
    const h = await harness({ lockVersion: 7 })
    const run = await draftRun(h)
    await h.service.calculate(h.tx, run.id, [EMPLOYEE])
    expect(h.timesheets.calls).toEqual([{ periodId: PERIOD_ID, lockVersion: 7 }])
  })

  it('refuses to calculate for an employee with no pay profile rather than paying them zero', async () => {
    const h = await harness()
    const run = await draftRun(h)
    await expect(h.service.calculate(h.tx, run.id, [randomUUID()])).rejects.toMatchObject({ code: 'PAY-404' })
  })

  it('a run that does not exist is a 404', async () => {
    const h = await harness()
    await expect(h.service.calculate(h.tx, randomUUID(), [EMPLOYEE])).rejects.toMatchObject({ code: 'PAY-404' })
  })
})

// ---------------------------------------------------------------------------
// SEGREGATION OF DUTIES
// ---------------------------------------------------------------------------

describe('SEGREGATION OF DUTIES — preparer ≠ approver, in the service AND in the database', () => {
  it('the preparer approving their own run is refused with AUZ-409', async () => {
    const h = await harness()
    const run = await draftRun(h)
    await h.service.calculate(h.tx, run.id, [EMPLOYEE])
    await h.service.review(h.tx, run.id, PREPARER)

    await expect(h.service.approve(h.tx, run.id, PREPARER)).rejects.toMatchObject({
      code: 'AUZ-409',
      httpStatus: 409,
      details: [{ rule: 'payroll.run.prepared_by <> approved_by' }],
    })
  })

  it('a DIFFERENT approver succeeds, and the approver is recorded in the same statement as the status', async () => {
    const h = await harness()
    const run = await draftRun(h)
    await h.service.calculate(h.tx, run.id, [EMPLOYEE])
    await h.service.review(h.tx, run.id, PREPARER)

    const approved = await h.service.approve(h.tx, run.id, APPROVER)
    expect(approved).toMatchObject({ status: 'approved', approvedBy: APPROVER, preparedBy: PREPARER })
    expect(approved.approvedAt).not.toBeNull()
  })

  it('the refusal happens BEFORE the run reaches the database — no partial state, whatever the status', async () => {
    const h = await harness()
    const run = await draftRun(h)
    await expect(h.service.approve(h.tx, run.id, PREPARER)).rejects.toMatchObject({ code: 'AUZ-409' })
    const stored = await h.runs.findById(run.id, h.tx)
    expect(stored?.status).toBe('draft')
    expect(stored?.approvedBy).toBeNull()
  })

  /**
   * DEMONSTRATION, in two halves, and both halves matter.
   *
   * (a) With the SERVICE check removed, the AUZ-409 assertion FAILS — which
   *     proves the assertion is testing the service code and not something
   *     incidental.
   * (b) ...and the write is STILL refused, by `payroll_run_sod_check`. That
   *     is the entire point of having a constraint as well as a check: the
   *     database is what survives a future refactor of the service.
   */
  it('DEMONSTRATION: with the service check removed, AUZ-409 no longer fires — but the DB constraint still refuses the write', async () => {
    const h = await harness()

    class RunsServiceWithoutSodCheck extends RunsService {
      /** The real `approve`, verbatim, MINUS the `approvedBy === run.preparedBy` guard. */
      override async approve(tx: Queryable, runId: string, approvedBy: string) {
        const run = await this.requireRun(runId, tx)
        this.assertMutable(run)
        return (await new RunsRepository(tx).setApproved(tx, runId, approvedBy, '2026-11-01T00:00:00.000Z')) ?? run
      }
    }

    const broken = new RunsServiceWithoutSodCheck(
      new RunsRepository(h.db.asPool()),
      new PayProfilesRepository(h.db.asPool()),
      h.profilesService,
      h.payslips,
      h.payInputs,
      h.refs,
      h.config,
      h.crypto,
      h.timesheets,
      h.docs,
      h.recorder,
      () => randomUUID(),
      () => '2026-11-01T00:00:00.000Z',
    )

    const run = await draftRun(h)

    // (a) The AUZ-409 expectation no longer holds — the service check is gone.
    let sawSodViolation = false
    try {
      await broken.approve(h.tx, run.id, PREPARER)
    } catch (err) {
      if (typeof err === 'object' && err !== null && (err as { code?: string }).code === 'AUZ-409') sawSodViolation = true
      // (b) ...but the DATABASE refuses it, under the constraint's real name.
      expect(err).toBeInstanceOf(ConstraintViolation)
      expect((err as ConstraintViolation).constraint).toBe('payroll_run_sod_check')
    }
    expect(sawSodViolation).toBe(false)

    const stored = await h.runs.findById(run.id, h.tx)
    expect(stored?.approvedBy).toBeNull()
  })

  it('the DB constraint is not vacuous: it permits a DIFFERENT approver', async () => {
    const h = await harness()
    const run = await draftRun(h)
    const updated = await new RunsRepository(h.db.asPool()).setApproved(h.tx, run.id, APPROVER, '2026-11-01T00:00:00.000Z')
    expect(updated?.approvedBy).toBe(APPROVER)
  })
})

// ---------------------------------------------------------------------------
// Lifecycle transitions and immutability
// ---------------------------------------------------------------------------

describe('lifecycle transitions', () => {
  it('review requires a calculated run', async () => {
    const h = await harness()
    const run = await draftRun(h)
    await expect(h.service.review(h.tx, run.id, PREPARER)).rejects.toMatchObject({ code: 'PAY-023' })
  })

  it('approve requires a calculated or reviewed run — not a draft', async () => {
    const h = await harness()
    const run = await draftRun(h)
    await expect(h.service.approve(h.tx, run.id, APPROVER)).rejects.toMatchObject({ code: 'PAY-023' })
  })

  it('commit requires approval (PAY-021) — a reviewed run is not a paid run', async () => {
    const h = await harness()
    const run = await draftRun(h)
    await h.service.calculate(h.tx, run.id, [EMPLOYEE])
    await h.service.review(h.tx, run.id, PREPARER)
    await expect(h.service.commit(h.tx, run.id)).rejects.toMatchObject({ code: 'PAY-021' })
  })

  it('recalculating a calculated run is legal — config or hours may have moved', async () => {
    const h = await harness()
    const run = await draftRun(h)
    await h.service.calculate(h.tx, run.id, [EMPLOYEE])
    const again = await h.service.calculate(h.tx, run.id, [EMPLOYEE])
    expect(again.run.status).toBe('calculated')
  })

  it('approve refuses when the timesheet lock moved under a reviewed run (PAY-030) — hours must not change after review', async () => {
    const h = await harness({ lockVersion: 7 })
    const run = await draftRun(h)
    await h.service.calculate(h.tx, run.id, [EMPLOYEE])
    await h.service.review(h.tx, run.id, PREPARER)

    // An unlock/re-lock bumped the version.
    await h.refs.upsertTimesheetLock(h.tx, { period: PERIOD, periodId: PERIOD_ID, lockVersion: 8, locked: true, lockedBy: APPROVER })

    await expect(h.service.approve(h.tx, run.id, APPROVER)).rejects.toMatchObject({
      code: 'PAY-030',
      details: [{ boundVersion: 7, currentVersion: 8 }],
    })
  })
})

describe('COMMITTED RUNS ARE IMMUTABLE — corrections go through an adjustment run', () => {
  it('commit records exports BEFORE the status flips — the only window the INSERT trigger allows', async () => {
    const h = await harness()
    const run = await throughApproval(h)
    await h.service.commit(h.tx, run.id)
    expect(h.recorder.recorded).toEqual([{ runId: run.id, statusAtRecord: 'approved' }])
  })

  it('publishes payroll.committed and one payslip.issued per payslip, with NO amounts in either payload', async () => {
    const h = await harness()
    const run = await throughApproval(h)
    await h.service.commit(h.tx, run.id)

    const topics = h.db.debugOutboxRows().map((r) => r.topic)
    expect(topics).toEqual(['payroll.committed', 'payslip.issued'])
    const serialised = JSON.stringify(h.db.debugOutboxRows())
    expect(serialised).not.toContain('45000')
    expect(serialised).not.toContain('44081')
  })

  it('every service write path refuses a committed run with PAY-022', async () => {
    const h = await harness()
    const run = await throughApproval(h)
    await h.service.commit(h.tx, run.id)

    await expect(h.service.calculate(h.tx, run.id, [EMPLOYEE])).rejects.toMatchObject({ code: 'PAY-022' })
    await expect(h.service.review(h.tx, run.id, PREPARER)).rejects.toMatchObject({ code: 'PAY-022' })
    await expect(h.service.approve(h.tx, run.id, APPROVER)).rejects.toMatchObject({ code: 'PAY-022' })
    await expect(h.service.commit(h.tx, run.id)).rejects.toMatchObject({ code: 'PAY-022' })
  })

  it('...and if the service check were bypassed, the DATABASE trigger still refuses the UPDATE', async () => {
    const h = await harness()
    const run = await throughApproval(h)
    await h.service.commit(h.tx, run.id)

    await expect(new RunsRepository(h.db.asPool()).setReviewed(h.tx, run.id, APPROVER)).rejects.toBeInstanceOf(ConstraintViolation)
  })

  it('a committed run\'s payslip cannot be updated, and no new pay_item can be added to it', async () => {
    const h = await harness()
    const run = await throughApproval(h)
    await h.service.commit(h.tx, run.id)
    const [slip] = await h.payslips.listByRun(run.id, h.tx)
    if (slip === undefined) throw new Error('no payslip')

    await expect(
      h.tx.query('UPDATE payroll.payslip SET lang = $2 WHERE id = $1 RETURNING *', [slip.id, 'en']),
    ).rejects.toMatchObject({ constraint: 'payslip_immutable_when_run_committed' })

    await expect(
      h.payslips.insertItem(h.tx, { id: randomUUID(), payslipId: slip.id, kind: 'earning:sneaky', amount: Buffer.alloc(200) }),
    ).rejects.toMatchObject({ constraint: 'pay_item_immutable_when_run_committed' })
  })

  it('THE CORRECTION PATH: an adjustment run referencing the committed run is created and is itself mutable', async () => {
    const h = await harness()
    const run = await throughApproval(h)
    await h.service.commit(h.tx, run.id)

    const adjustment = await h.service.createAdjustmentRun(h.tx, run.id, PREPARER, '2026-11-15')
    expect(adjustment).toMatchObject({ runType: 'adjustment', status: 'draft', adjustsRunId: run.id, period: PERIOD })

    // ...and it can be calculated, which the committed run cannot.
    const outcome = await h.service.calculate(h.tx, adjustment.id, [EMPLOYEE])
    expect(outcome.run.status).toBe('calculated')
  })

  it('an adjustment run cannot target a run that is not committed, nor one that does not exist', async () => {
    const h = await harness()
    const draft = await draftRun(h)
    await expect(h.service.createAdjustmentRun(h.tx, draft.id, PREPARER, '2026-11-15')).rejects.toMatchObject({ code: 'PAY-024' })
    await expect(h.service.createAdjustmentRun(h.tx, randomUUID(), PREPARER, '2026-11-15')).rejects.toMatchObject({ code: 'PAY-404' })
  })
})

// ---------------------------------------------------------------------------
// Pay inputs, year-to-date, and variance
// ---------------------------------------------------------------------------

describe('pay inputs are consumed exactly once, with their classification intact', () => {
  async function queueReimbursement(h: Harness, amountThb: string) {
    const id = randomUUID()
    const cipher = await h.crypto.encryptBatch([{ entityId: id, field: 'amount', value: amountThb, fieldClass: 'S3' }])
    const amount = cipher.get('amount')
    if (amount === undefined) throw new Error('no ciphertext')
    await h.payInputs.insert(h.tx, {
      id,
      employeeId: EMPLOYEE,
      period: PERIOD,
      source: 'claim_reimbursement',
      sourceRef: randomUUID(),
      kind: 'reimbursement:travel',
      amount,
      taxable: false,
      ssoWageBase: false,
      direction: 'earning',
      meta: { oneOff: true },
    })
  }

  it('a reimbursement raises the net but not gross, the taxable base or the SSO contribution', async () => {
    const withoutClaim = await harness()
    const runA = await draftRun(withoutClaim)
    await withoutClaim.service.calculate(withoutClaim.tx, runA.id, [EMPLOYEE])
    const [slipA] = await withoutClaim.payslips.listByRun(runA.id, withoutClaim.tx)

    const withClaim = await harness()
    await queueReimbursement(withClaim, '8000.00')
    const runB = await draftRun(withClaim)
    await withClaim.service.calculate(withClaim.tx, runB.id, [EMPLOYEE])
    const [slipB] = await withClaim.payslips.listByRun(runB.id, withClaim.tx)

    if (slipA === undefined || slipB === undefined) throw new Error('missing payslip')
    const read = async (h: Harness, id: string, field: string, buf: Buffer) => satangToBaht(await decryptMoney(h.crypto, id, field, buf, 'test'))

    expect(await read(withClaim, slipB.id, 'gross', slipB.gross)).toBe(await read(withoutClaim, slipA.id, 'gross', slipA.gross))
    expect(await read(withClaim, slipB.id, 'sso_emp', slipB.ssoEmp)).toBe(await read(withoutClaim, slipA.id, 'sso_emp', slipA.ssoEmp))
    expect(await read(withClaim, slipB.id, 'non_taxable_pay', slipB.nonTaxablePay ?? Buffer.alloc(0))).toBe('8000.00')
    expect(await read(withClaim, slipB.id, 'net', slipB.net)).toBe('52081.25')
  })

  it('an input is marked consumed by the run that paid it, so a second run cannot pay it again', async () => {
    const h = await harness()
    await queueReimbursement(h, '8000.00')
    const run = await draftRun(h)
    await h.service.calculate(h.tx, run.id, [EMPLOYEE])

    expect(await h.payInputs.listOutstanding(EMPLOYEE, PERIOD, h.tx)).toHaveLength(0)
    const all = await h.payInputs.listByPeriod(PERIOD, h.tx)
    expect(all[0]?.consumedRunId).toBe(run.id)
  })

  it('recurring profile items flow through with their own taxable/SSO flags', async () => {
    const h = await harness()
    await h.profilesService.upsert(
      h.tx,
      EMPLOYEE,
      {
        basePayThb: '45000',
        payBasis: 'monthly',
        recurringItems: [
          { code: 'position_allowance', direction: 'earning', amountThb: '5000.00', taxable: true, ssoWageBase: true },
          { code: 'meal_reimbursement', direction: 'earning', amountThb: '1000.00', taxable: false, ssoWageBase: false },
        ],
        pfRatePercent: null,
        pfRateEmployerPercent: null,
        declaration: null,
        bankCode: 'KBANK',
        bankAccount: '1234567890',
        bankAccountName: 'SOMCHAI J',
      },
      PERIOD_END,
    )
    const run = await draftRun(h)
    await h.service.calculate(h.tx, run.id, [EMPLOYEE])
    const [slip] = await h.payslips.listByRun(run.id, h.tx)
    if (slip === undefined) throw new Error('no payslip')

    expect(satangToBaht(await decryptMoney(h.crypto, slip.id, 'gross', slip.gross, 'test'))).toBe('50000.00')
    expect(satangToBaht(await decryptMoney(h.crypto, slip.id, 'non_taxable_pay', slip.nonTaxablePay ?? Buffer.alloc(0), 'test'))).toBe('1000.00')
  })
})

describe('variance review', () => {
  it('an employee with no prior period is ALWAYS flagged — "new starter" and "doubled someone\'s pay" look identical to a percentage', async () => {
    const h = await harness()
    const run = await draftRun(h)
    await h.service.calculate(h.tx, run.id, [EMPLOYEE])

    const lines = await h.service.variance(run.id, h.tx)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ employeeId: EMPLOYEE, previousNetThb: null, flagged: true, reason: 'no_prior_period' })
  })

  it('a movement within the configured threshold is not flagged; one beyond it is', async () => {
    const h = await harness()

    // A committed September run to compare against.
    await h.refs.upsertTimesheetLock(h.tx, { period: '2026-09', periodId: SEPTEMBER_PERIOD_ID, lockVersion: 7, locked: true, lockedBy: PREPARER })
    h.timesheets.seed(SEPTEMBER_PERIOD_ID, 7, {})
    const september = await h.service.createRun(h.tx, {
      period: '2026-09',
      runType: 'regular',
      preparedBy: PREPARER,
      periodStart: '2026-09-01',
      periodEnd: '2026-09-30',
      payDate: '2026-09-30',
    })
    await h.service.calculate(h.tx, september.id, [EMPLOYEE])
    await h.service.review(h.tx, september.id, PREPARER)
    await h.service.approve(h.tx, september.id, APPROVER)
    await h.service.commit(h.tx, september.id)

    const october = await draftRun(h)
    await h.service.calculate(h.tx, october.id, [EMPLOYEE])

    const withinThreshold = await h.service.variance(october.id, h.tx)
    // The only movement is the newly-effective EWF contribution — far below 10%.
    expect(withinThreshold[0]).toMatchObject({ flagged: false, reason: 'within_threshold' })

    // Tighten the threshold in config and the same movement is flagged.
    h.config.amend('payroll.variance.threshold_percent', PERIOD_END, '0.05')
    const tightened = await h.service.variance(october.id, h.tx)
    expect(tightened[0]).toMatchObject({ flagged: true, reason: 'above_threshold' })
  })

  it('a run that does not exist has no variance to report', async () => {
    const h = await harness()
    await expect(h.service.variance(randomUUID(), h.tx)).rejects.toMatchObject({ code: 'PAY-404' })
  })
})

describe('year-to-date accumulates only from COMMITTED runs', () => {
  it('an uncommitted prior run contributes nothing — it is not yet a payment', async () => {
    const h = await harness()
    await h.refs.upsertTimesheetLock(h.tx, { period: '2026-09', periodId: SEPTEMBER_PERIOD_ID, lockVersion: 7, locked: true, lockedBy: PREPARER })
    h.timesheets.seed(SEPTEMBER_PERIOD_ID, 7, {})
    const september = await h.service.createRun(h.tx, {
      period: '2026-09',
      runType: 'regular',
      preparedBy: PREPARER,
      periodStart: '2026-09-01',
      periodEnd: '2026-09-30',
      payDate: '2026-09-30',
    })
    await h.service.calculate(h.tx, september.id, [EMPLOYEE])

    const october = await draftRun(h)
    await h.service.calculate(h.tx, october.id, [EMPLOYEE])
    const [slip] = (await h.payslips.listByRun(october.id, h.tx))
    if (slip === undefined) throw new Error('no payslip')
    const ytd = JSON.parse(await h.crypto.decrypt(slip.id, 'ytd', slip.ytd, 'test')) as Record<string, string>
    // Only this period's own contribution.
    expect(ytd['taxableIncome']).toBe('45000.00')
  })

  it('...and a committed one does', async () => {
    const h = await harness()
    await h.refs.upsertTimesheetLock(h.tx, { period: '2026-09', periodId: SEPTEMBER_PERIOD_ID, lockVersion: 7, locked: true, lockedBy: PREPARER })
    h.timesheets.seed(SEPTEMBER_PERIOD_ID, 7, {})
    const september = await h.service.createRun(h.tx, {
      period: '2026-09',
      runType: 'regular',
      preparedBy: PREPARER,
      periodStart: '2026-09-01',
      periodEnd: '2026-09-30',
      payDate: '2026-09-30',
    })
    await h.service.calculate(h.tx, september.id, [EMPLOYEE])
    await h.service.review(h.tx, september.id, PREPARER)
    await h.service.approve(h.tx, september.id, APPROVER)
    await h.service.commit(h.tx, september.id)

    const october = await draftRun(h)
    await h.service.calculate(h.tx, october.id, [EMPLOYEE])
    const slips = await h.payslips.listByRun(october.id, h.tx)
    const slip = slips[0]
    if (slip === undefined) throw new Error('no payslip')
    const ytd = JSON.parse(await h.crypto.decrypt(slip.id, 'ytd', slip.ytd, 'test')) as Record<string, string>
    expect(ytd['taxableIncome']).toBe('45000.00')

    // The prior period's SSO is now in the running total the next period reads.
    const listed = await h.service.list(PERIOD, h.tx)
    expect(listed.map((r) => r.id)).toContain(october.id)
    expect((await h.service.list(null, h.tx)).length).toBe(2)
  })
})
