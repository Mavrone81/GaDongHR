import { CryptoClient, sodViolation, writeOutbox } from '@gadong/kernel'
import type { Queryable } from '@gadong/kernel'
import {
  adjustmentTargetNotCommitted,
  commitWithoutApproval,
  committedRunImmutable,
  invalidRunTransition,
  payProfileNotFound,
  runNotFound,
  timesheetLockStale,
  timesheetNotLocked,
} from './errors'
import { bahtToSatang, satangToBaht } from './money'
import type { Satang } from './money'
import { computeGrossToNet } from './engine/gross-to-net'
import { resolveEngineRules } from './engine/rules'
import { ZERO_TIMESHEET, ZERO_YTD } from './engine/types'
import type { GrossToNetResult, PayLineInput, TimesheetTotals, YearToDate } from './engine/types'
import { StatutoryResolver, RULE_KEYS } from './statutory'
import type { ConfigClient } from './config-client'
import { PayProfilesService } from './pay-profiles.service'
import type { DecryptedProfile } from './pay-profiles.service'
import { PayProfilesRepository } from './pay-profiles.repository'
import { PayInputsRepository } from './pay-inputs.repository'
import { PayslipsRepository } from './payslips.repository'
import { RefsRepository } from './refs.repository'
import { RunsRepository } from './runs.repository'
import type { PayrollRunRow, RunStatus, RunType } from './runs.repository'
import { buildPayslipView, renderPayslipHtml, toLocale } from './payslip-render'
import { decryptMoney, encryptMoneyFields, encryptTextFields } from './money-crypto'
import { TOPIC_PAYROLL_COMMITTED, TOPIC_PAYSLIP_ISSUED, buildPayrollCommittedPayload, buildPayslipIssuedPayload } from './events'
import type { DocsClient, ExportRecorder, TimesheetClient } from './ports'

/**
 * M7-3 — the payroll run lifecycle, and the two controls that make a
 * committed run usable as evidence.
 *
 *   draft → calculate → variance review → approve → commit → payment
 *
 * SEGREGATION OF DUTIES. `approve` refuses when the approver is the
 * preparer, with the kernel's `sodViolation()` (AUZ-409). The database
 * carries the same rule as `payroll_run_sod_check`. Both layers exist on
 * purpose: the DB constraint survives a future refactor of this file, and
 * the service check turns what would be an opaque 23514 into an error a
 * client can act on and an auditor can grep for. `runs.service.test.ts`
 * demonstrates the service half failing when its check is deleted — which
 * is the only way to know the test is testing the check rather than the
 * constraint.
 *
 * IMMUTABILITY. Every write path calls `assertMutable` first. Corrections
 * to a committed run go through `createAdjustmentRun`, which requires the
 * target to BE committed — a new run that references the old one, never an
 * edit to it.
 *
 * TIMESHEET BINDING. A run records the `lock_version` it was prepared
 * against. If `timesheet.unlocked` later bumps that version, `calculate`
 * and `approve` refuse with PAY-030 until the run is recalculated: hours
 * that moved after a run was reviewed are exactly the change nobody
 * notices.
 */

export interface CreateRunInput {
  period: string
  runType: RunType
  preparedBy: string
  periodStart: string
  periodEnd: string
  payDate: string
  adjustsRunId?: string | null
}

export interface VarianceLine {
  employeeId: string
  currentNetThb: string
  previousNetThb: string | null
  deltaThb: string
  /** `true` when the movement exceeds the configured threshold, or when there is no prior period to compare against. */
  flagged: boolean
  reason: 'above_threshold' | 'no_prior_period' | 'within_threshold'
}

export interface CalculationOutcome {
  run: PayrollRunRow
  payslipIds: string[]
}

const CALCULATE_PURPOSE = 'payroll.calculate'

export class RunsService {
  constructor(
    private readonly runs: RunsRepository,
    private readonly profiles: PayProfilesRepository,
    private readonly profilesService: PayProfilesService,
    private readonly payslips: PayslipsRepository,
    private readonly payInputs: PayInputsRepository,
    private readonly refs: RefsRepository,
    private readonly config: ConfigClient,
    private readonly crypto: CryptoClient,
    private readonly timesheets: TimesheetClient,
    private readonly docs: DocsClient,
    private readonly exportRecorder: ExportRecorder,
    private readonly newId: () => string,
    private readonly now: () => string,
  ) {}

  // ---------------------------------------------------------------- draft

  async createRun(tx: Queryable, input: CreateRunInput): Promise<PayrollRunRow> {
    const lock = await this.refs.findTimesheetLock(input.period, tx)
    // A run must bind to real, locked hours. The one exception is a
    // final-pay run, which pays an individual leaving mid-period and cannot
    // wait for the period to close.
    if (lock === null || !lock.locked) {
      if (input.runType !== 'final_pay') throw timesheetNotLocked(input.period)
    }

    const adjustsRunId = input.adjustsRunId ?? null
    if (input.runType === 'adjustment') {
      if (adjustsRunId === null) throw adjustmentTargetNotCommitted(input.period, 'no target')
      const target = await this.runs.findById(adjustsRunId, tx)
      if (target === null) throw runNotFound(adjustsRunId)
      // An adjustment corrects history. Pointing one at a run that is still
      // being prepared would create two competing versions of a period
      // nobody has yet committed to.
      if (target.status !== 'committed') throw adjustmentTargetNotCommitted(adjustsRunId, target.status)
    }

    return this.runs.insert(tx, {
      id: this.newId(),
      period: input.period,
      runType: input.runType,
      timesheetLockVersion: lock?.lockVersion ?? 0,
      status: 'draft',
      preparedBy: input.preparedBy,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      payDate: input.payDate,
      adjustsRunId,
    })
  }

  /** Corrections to a committed run happen HERE and only here — never by editing the committed row. */
  async createAdjustmentRun(tx: Queryable, targetRunId: string, preparedBy: string, payDate: string): Promise<PayrollRunRow> {
    const target = await this.runs.findById(targetRunId, tx)
    if (target === null) throw runNotFound(targetRunId)
    if (target.status !== 'committed') throw adjustmentTargetNotCommitted(targetRunId, target.status)
    return this.runs.insert(tx, {
      id: this.newId(),
      period: target.period,
      runType: 'adjustment',
      timesheetLockVersion: target.timesheetLockVersion,
      status: 'draft',
      preparedBy,
      periodStart: target.periodStart ?? target.period,
      periodEnd: target.periodEnd ?? target.period,
      payDate,
      adjustsRunId: targetRunId,
    })
  }

  // ------------------------------------------------------------ calculate

  /**
   * Runs gross-to-net for every in-scope employee and writes a payslip
   * apiece. Recalculating a `calculated` run is legal (config or timesheet
   * moved); recalculating a committed one is not.
   */
  async calculate(tx: Queryable, runId: string, employeeIds: string[]): Promise<CalculationOutcome> {
    const run = await this.requireRun(runId, tx)
    this.assertMutable(run)
    if (run.status !== 'draft' && run.status !== 'calculated' && run.status !== 'reviewed') {
      throw invalidRunTransition(runId, run.status, 'calculated')
    }

    const periodEnd = run.periodEnd ?? run.period
    const lock = await this.refs.findTimesheetLock(run.period, tx)
    const boundVersion = lock?.lockVersion ?? run.timesheetLockVersion

    // ONE resolver for the whole run: every employee sees the same rule
    // versions, resolved as of the period END date. A rule that changes
    // mid-run cannot produce two answers inside one payroll.
    const resolver = new StatutoryResolver(this.config, periodEnd)

    const totals =
      run.runType === 'final_pay' ? new Map<string, TimesheetTotals>() : await this.timesheets.getLockedTotals(run.period, boundVersion)

    // A recalculation REPLACES this run's payslips. Both halves matter: the
    // old payslips go (the UNIQUE (run_id, employee_id) would refuse a
    // second set anyway, and two payslips means the bank file pays twice),
    // and the inputs this run had already consumed go back on the queue,
    // or the second calculation would silently drop a reimbursement.
    await this.payslips.deleteByRun(tx, run.id)
    await this.payInputs.releaseConsumedBy(tx, run.id, run.period)

    const payslipIds: string[] = []
    for (const employeeId of employeeIds) {
      const id = await this.calculateOne(tx, run, resolver, employeeId, totals.get(employeeId) ?? ZERO_TIMESHEET, periodEnd)
      payslipIds.push(id)
    }

    const updated = await this.runs.setCalculated(tx, runId, resolver.snapshot(), boundVersion)
    if (updated === null) throw runNotFound(runId)
    return { run: updated, payslipIds }
  }

  private async calculateOne(
    tx: Queryable,
    run: PayrollRunRow,
    resolver: StatutoryResolver,
    employeeId: string,
    timesheet: TimesheetTotals,
    periodEnd: string,
  ): Promise<string> {
    const employee = await this.refs.findEmployee(employeeId, tx)
    const profileRow = await this.profiles.findByEmployee(employeeId, tx)
    if (profileRow === null) throw payProfileNotFound(employeeId)
    const profile = await this.profilesService.decryptRow(profileRow, CALCULATE_PURPOSE)

    const rules = await resolveEngineRules(resolver, employee?.provinceCode ?? '')
    const lines = await this.gatherLines(tx, run, employeeId, profile)
    const ytd = await this.yearToDate(tx, employeeId, run.period)

    const result = computeGrossToNet(
      {
        employee: { id: employeeId, provinceCode: employee?.provinceCode ?? '' },
        period: {
          code: run.period,
          start: run.periodStart ?? run.period,
          end: periodEnd,
          payDate: run.payDate ?? periodEnd,
          indexInYear: monthIndex(run.period),
        },
        profile: {
          basis: profile.basis,
          basePay: profile.basePay,
          pfRatePercent: profile.pfRatePercent,
          pfRateEmployerPercent: profile.pfRateEmployerPercent,
          declaration: profile.declaration,
        },
        timesheet,
        lines,
        ytd,
      },
      rules,
    )

    return this.writePayslip(tx, run, employeeId, employee?.empCode ?? null, employee?.preferredLang ?? null, result, ytd, periodEnd)
  }

  /**
   * Every non-profile amount for this employee and period: recurring items
   * from the profile, plus the outstanding `pay_input` rows fed by
   * `leave.balance_payout`, `claim.approved_for_payroll` and one-off manual
   * entries.
   *
   * `taxable`/`ssoWageBase` are copied straight through from the stored
   * row. They are never re-derived from `kind` — that is the mechanism by
   * which a reimbursement stays out of the tax and SSO wage base.
   */
  private async gatherLines(tx: Queryable, run: PayrollRunRow, employeeId: string, profile: DecryptedProfile): Promise<PayLineInput[]> {
    const lines: PayLineInput[] = profile.recurringItems.map((item) => ({
      code: item.code,
      direction: item.direction,
      amount: bahtToSatang(item.amountThb),
      taxable: item.taxable,
      ssoWageBase: item.ssoWageBase,
      oneOff: false,
    }))

    const inputs = await this.payInputs.listOutstanding(employeeId, run.period, tx)
    for (const input of inputs) {
      const amount = await decryptMoney(this.crypto, input.id, 'amount', input.amount, CALCULATE_PURPOSE)
      lines.push({
        code: input.kind,
        direction: input.direction,
        amount,
        taxable: input.taxable,
        ssoWageBase: input.ssoWageBase,
        oneOff: input.meta['oneOff'] === true,
      })
      await this.payInputs.markConsumed(tx, input.id, run.id)
    }

    return lines
  }

  /** Year-to-date from this employee's payslips on COMMITTED runs in the same calendar year — an uncommitted run is not yet a payment. */
  private async yearToDate(tx: Queryable, employeeId: string, period: string): Promise<YearToDate> {
    const year = period.slice(0, 4)
    const slips = await this.payslips.listByEmployee(employeeId, tx)
    let ytd: YearToDate = ZERO_YTD
    for (const slip of slips) {
      const run = await this.runs.findById(slip.runId, tx)
      if (run === null || run.status !== 'committed') continue
      if (!run.period.startsWith(year)) continue
      if (run.period >= period) continue
      const stored = await this.readYtdBlock(slip.id, slip.ytd)
      ytd = {
        taxableIncome: ytd.taxableIncome + stored.taxableIncome,
        ssoEmployee: ytd.ssoEmployee + stored.ssoEmployee,
        pfEmployee: ytd.pfEmployee + stored.pfEmployee,
        whtPaid: ytd.whtPaid + stored.whtPaid,
      }
    }
    return ytd
  }

  /**
   * `payslip.ytd` stores THIS period's contribution to the running totals,
   * encrypted as a small JSON block. Summing per-period contributions
   * rather than storing a cumulative snapshot means an adjustment run
   * contributes its delta and the year still adds up, without any row
   * having to be rewritten — which it could not be, since it is immutable.
   */
  private async readYtdBlock(payslipId: string, ciphertext: Buffer): Promise<YearToDate> {
    const json = await this.crypto.decrypt(payslipId, 'ytd', ciphertext, CALCULATE_PURPOSE)
    let parsed: unknown
    try {
      parsed = JSON.parse(json)
    } catch {
      return ZERO_YTD
    }
    if (typeof parsed !== 'object' || parsed === null) return ZERO_YTD
    const rec = parsed as Record<string, unknown>
    const read = (key: string): Satang => (typeof rec[key] === 'string' ? bahtToSatang(rec[key]) : 0n)
    return {
      taxableIncome: read('taxableIncome'),
      ssoEmployee: read('ssoEmployee'),
      pfEmployee: read('pfEmployee'),
      whtPaid: read('whtPaid'),
    }
  }

  private async writePayslip(
    tx: Queryable,
    run: PayrollRunRow,
    employeeId: string,
    empCode: string | null,
    lang: string | null,
    result: GrossToNetResult,
    priorYtd: YearToDate,
    periodEnd: string,
  ): Promise<string> {
    const id = this.newId()

    const view = buildPayslipView({
      payslipId: id,
      employeeId,
      empCode,
      period: run.period,
      periodStart: run.periodStart ?? periodEnd,
      periodEnd,
      payDate: run.payDate ?? periodEnd,
      lang,
      result,
      ytd: {
        taxableIncome: priorYtd.taxableIncome + result.taxableGross,
        ssoEmployee: priorYtd.ssoEmployee + result.ssoEmployee,
        pfEmployee: priorYtd.pfEmployee + result.pfEmployee,
        whtPaid: priorYtd.whtPaid + result.wht,
        net: result.net,
      },
    })

    const rendered = await this.docs.renderPayslip({ payslipId: id, lang: view.lang, html: renderPayslipHtml(view) })

    // Every money column encrypted before write, in one batch.
    const money = await encryptMoneyFields(this.crypto, id, {
      gross: result.gross,
      sso_emp: result.ssoEmployee,
      ewf_emp: result.ewfEmployee,
      pf_emp: result.pfEmployee,
      tax_wht: result.wht,
      net: result.net,
      sso_er: result.ssoEmployer,
      ewf_er: result.ewfEmployer,
      pf_er: result.pfEmployer,
      taxable_gross: result.taxableGross,
      non_taxable_pay: result.nonTaxablePay,
    })
    const texts = await encryptTextFields(this.crypto, id, {
      ytd: JSON.stringify({
        taxableIncome: satangToBaht(result.taxableGross),
        ssoEmployee: satangToBaht(result.ssoEmployee),
        pfEmployee: satangToBaht(result.pfEmployee),
        whtPaid: satangToBaht(result.wht),
      }),
      pdf_ref: rendered.fileRef,
    })

    const need = (map: Map<string, Buffer>, field: string): Buffer => {
      const buf = map.get(field)
      if (buf === undefined) throw new Error(`RunsService: svc-crypto did not return ciphertext for ${field}`)
      return buf
    }

    await this.payslips.insert(tx, {
      id,
      runId: run.id,
      employeeId,
      gross: need(money, 'gross'),
      ssoEmp: need(money, 'sso_emp'),
      ewfEmp: need(money, 'ewf_emp'),
      pfEmp: need(money, 'pf_emp'),
      taxWht: need(money, 'tax_wht'),
      net: need(money, 'net'),
      ytd: need(texts, 'ytd'),
      pdfRef: need(texts, 'pdf_ref'),
      ssoEr: need(money, 'sso_er'),
      ewfEr: need(money, 'ewf_er'),
      pfEr: need(money, 'pf_er'),
      taxableGross: need(money, 'taxable_gross'),
      nonTaxablePay: need(money, 'non_taxable_pay'),
      lang: view.lang,
    })

    // The itemised breakdown — one encrypted `pay_item` per line, which is
    // what makes a payslip explainable line by line years later.
    for (const line of result.lines) {
      const itemId = this.newId()
      const itemCipher = await encryptMoneyFields(this.crypto, itemId, { amount: line.amount })
      await this.payslips.insertItem(tx, {
        id: itemId,
        payslipId: id,
        kind: `${line.category}:${line.code}`,
        amount: need(itemCipher, 'amount'),
      })
    }

    return id
  }

  // --------------------------------------------------------- variance

  /**
   * Line-level movement against the previous period's committed run
   * (M7-3). The threshold is a config figure, not a constant here, and an
   * employee with no prior period is ALWAYS flagged: "new starter" and
   * "silently doubled someone's pay" look identical to a percentage test.
   */
  async variance(runId: string, db: Queryable): Promise<VarianceLine[]> {
    const run = await this.requireRun(runId, db)
    const periodEnd = run.periodEnd ?? run.period
    const resolver = new StatutoryResolver(this.config, periodEnd)
    const threshold = await resolver.requiredPercent(RULE_KEYS.varianceThresholdPercent)

    const previousPeriod = previousMonth(run.period)
    const previousRuns = await this.runs.listByPeriod(previousPeriod, db)
    const previousCommitted = previousRuns.find((r) => r.status === 'committed') ?? null

    const previousNets = new Map<string, Satang>()
    if (previousCommitted !== null) {
      for (const slip of await this.payslips.listByRun(previousCommitted.id, db)) {
        previousNets.set(slip.employeeId, await decryptMoney(this.crypto, slip.id, 'net', slip.net, 'payroll.variance_review'))
      }
    }

    const out: VarianceLine[] = []
    for (const slip of await this.payslips.listByRun(runId, db)) {
      const current = await decryptMoney(this.crypto, slip.id, 'net', slip.net, 'payroll.variance_review')
      const previous = previousNets.get(slip.employeeId) ?? null
      if (previous === null) {
        out.push({
          employeeId: slip.employeeId,
          currentNetThb: satangToBaht(current),
          previousNetThb: null,
          deltaThb: satangToBaht(current),
          flagged: true,
          reason: 'no_prior_period',
        })
        continue
      }
      const delta = current - previous
      const magnitude = delta < 0n ? -delta : delta
      const previousMagnitude = previous < 0n ? -previous : previous
      // |delta|/|previous| > threshold, by cross-multiplication — exact,
      // and safe when `previous` is zero (any movement is then flagged).
      const flagged = magnitude * threshold.value.den > threshold.value.num * previousMagnitude
      out.push({
        employeeId: slip.employeeId,
        currentNetThb: satangToBaht(current),
        previousNetThb: satangToBaht(previous),
        deltaThb: satangToBaht(delta),
        flagged,
        reason: flagged ? 'above_threshold' : 'within_threshold',
      })
    }
    return out
  }

  // --------------------------------------------------- review / approve

  async review(tx: Queryable, runId: string, reviewedBy: string): Promise<PayrollRunRow> {
    const run = await this.requireRun(runId, tx)
    this.assertMutable(run)
    if (run.status !== 'calculated') throw invalidRunTransition(runId, run.status, 'reviewed')
    const updated = await this.runs.setReviewed(tx, runId, reviewedBy)
    if (updated === null) throw runNotFound(runId)
    return updated
  }

  /**
   * SEGREGATION OF DUTIES. The line below is the service half of a
   * two-layer control; `payroll_run_sod_check` is the other half. Deleting
   * this check makes `runs.service.test.ts`'s SoD test fail — demonstrated
   * in that file, because a test that would still pass without the code it
   * claims to test is not evidence of anything.
   */
  async approve(tx: Queryable, runId: string, approvedBy: string): Promise<PayrollRunRow> {
    const run = await this.requireRun(runId, tx)
    this.assertMutable(run)

    if (approvedBy === run.preparedBy) {
      throw sodViolation('payroll.run.prepared_by <> approved_by')
    }

    if (run.status !== 'reviewed' && run.status !== 'calculated') throw invalidRunTransition(runId, run.status, 'approved')

    // The hours a reviewed run was based on must not have moved under it.
    const lock = await this.refs.findTimesheetLock(run.period, tx)
    if (lock !== null && lock.lockVersion !== run.timesheetLockVersion) {
      throw timesheetLockStale(runId, run.timesheetLockVersion, lock.lockVersion)
    }

    const updated = await this.runs.setApproved(tx, runId, approvedBy, this.now())
    if (updated === null) throw runNotFound(runId)
    return updated
  }

  // ------------------------------------------------------------- commit

  async commit(tx: Queryable, runId: string): Promise<PayrollRunRow> {
    const run = await this.requireRun(runId, tx)
    this.assertMutable(run)
    if (run.status !== 'approved') throw commitWithoutApproval(runId, run.status)

    const slips = await this.payslips.listByRun(runId, tx)

    // Exports are RECORDED before the status flips. Afterwards the
    // `statutory_export` INSERT trigger correctly refuses — adding a filing
    // to a committed period changes what its evidence says. The download
    // endpoints re-render deterministically from the immutable payslips.
    await this.exportRecorder.recordAll(tx, run)

    const committed = await this.runs.setCommitted(tx, runId, this.now())
    if (committed === null) throw runNotFound(runId)

    // The state change and its events commit or roll back together — the
    // outbox row is written through the CALLER's transaction.
    await writeOutbox(tx, 'payroll', TOPIC_PAYROLL_COMMITTED, buildPayrollCommittedPayload(committed, slips.length))
    for (const slip of slips) {
      await writeOutbox(tx, 'payroll', TOPIC_PAYSLIP_ISSUED, buildPayslipIssuedPayload(slip.id, runId, slip.employeeId, toLocale(slip.lang)))
    }

    return committed
  }

  // ------------------------------------------------------------ helpers

  /** Runs for one period, or every run when `period` is null. */
  async list(period: string | null, db: Queryable): Promise<PayrollRunRow[]> {
    return period === null ? this.runs.listAll(db) : this.runs.listByPeriod(period, db)
  }

  async requireRun(runId: string, db: Queryable): Promise<PayrollRunRow> {
    const run = await this.runs.findById(runId, db)
    if (run === null) throw runNotFound(runId)
    return run
  }

  /** The service-layer half of committed-run immutability. Called at the top of every write path. */
  assertMutable(run: { id: string; status: RunStatus }): void {
    if (run.status === 'committed') throw committedRunImmutable(run.id)
  }
}

/** 'YYYY-MM' → 1..12. The annualised withholding method needs to know which period of the tax year this is. */
export function monthIndex(period: string): number {
  const match = /^(\d{4})-(\d{2})$/.exec(period)
  if (match === null || match[2] === undefined) throw new Error(`RunsService: period must be 'YYYY-MM', got ${JSON.stringify(period)}`)
  return Number(match[2])
}

export function previousMonth(period: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(period)
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new Error(`RunsService: period must be 'YYYY-MM', got ${JSON.stringify(period)}`)
  }
  const year = Number(match[1])
  const month = Number(match[2])
  const prevMonth = month === 1 ? 12 : month - 1
  const prevYear = month === 1 ? year - 1 : year
  return `${prevYear.toString().padStart(4, '0')}-${prevMonth.toString().padStart(2, '0')}`
}
