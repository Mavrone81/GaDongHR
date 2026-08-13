import { Body, Controller, Get, HttpException, Inject, Param, Post, Put, Query, Req } from '@nestjs/common'
import { GadongError, Public, RequirePermission, buildHealth, outboxDepth, withTransaction } from '@gadong/kernel'
import type { AuthenticatedRequest, HealthPayload } from '@gadong/kernel'
import type { Pool } from 'pg'
import { unsupportedBankFormat } from './errors'
import type { BankFileResult } from './bank-files'
import { EXPORT_BUILDERS, isStatutoryExportKind } from './statutory-exports'
import type { GeneratedExport } from './statutory-exports'
import { PayProfilesService } from './pay-profiles.service'
import type { PayProfileInputDto, PayProfileView } from './pay-profiles.service'
import { RunsService } from './runs.service'
import type { CalculationOutcome, VarianceLine } from './runs.service'
import { FinalPayService } from './final-pay.service'
import type { FinalPayAssessment } from './final-pay.service'
import { ExportsService } from './exports.service'
import { PayslipsService } from './payslips.service'
import type { PayslipSummary } from './payslips.service'
import type { PayrollRunRow, RunType } from './runs.repository'

/** DI token for the `payroll` schema's connection pool. */
export const DB_POOL = Symbol('DB_POOL')
/** DI token for the reachability check against `svc-crypto` — every money column this service owns is envelope-encrypted through it before write. */
export const CRYPTO_HEALTH = Symbol('CRYPTO_HEALTH')
/** DI token for the reachability check against `svc-config` — every statutory figure resolves from there at runtime. */
export const CONFIG_HEALTH = Symbol('CONFIG_HEALTH')

export interface HealthCheckPort {
  check(): Promise<'up' | 'down'>
}

interface CreateRunBody {
  period: string
  runType: RunType
  periodStart: string
  periodEnd: string
  payDate: string
  adjustsRunId?: string
}

interface CalculateBody {
  employeeIds: string[]
}

interface AdjustmentRunBody {
  targetRunId: string
  payDate: string
}

interface FinalPayBody {
  period: string
}

interface BankFileBody {
  format: string
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * The HTTP boundary for M7 (`docs/05-modules/M7-PAYROLL.md` §3). Every
 * route but `GET /health` declares exactly one permission from the
 * roadmap's catalog; `/health` is `@Public()`.
 *
 * PERMISSION NAMING — a deliberate divergence from the module doc.
 * M7-PAYROLL.md §3 names `payroll.profile.manage`, `payroll.disburse`,
 * `payroll.statutory.export` and `payroll.report`; NONE of those four
 * exists in the roadmap's permission catalog, which is the list
 * `services/svc-authz/src/seed/roles.ts`'s `PERMISSION_CATALOG` is seeded
 * from and the list `web/ui-coverage.test.ts` validates against. A route
 * guarded by a permission no role can hold is a route nobody can reach. So
 * the catalog's nine payroll codes are used instead —
 * `payroll.profile.read/write`,
 * `payroll.run.prepare/calculate/approve/commit`, `payroll.export`,
 * `payslip.read.self/any` — and the divergence is recorded in this
 * module's report.
 *
 * SEGREGATION OF DUTIES IS NOT ENFORCED HERE. `payroll.run.approve` and
 * `payroll.run.commit` being separate permissions is access control;
 * preparer ≠ approver is a different question — about the identity of the
 * two humans on ONE run — and it lives in `RunsService.approve`, plus the
 * database's `payroll_run_sod_check`. A permission cannot express it.
 *
 * DATA SCOPING: `GET /my/payslips` is self-scoped BY CONSTRUCTION —
 * `employeeId` is always `req.userId`, never a request-supplied value. The
 * roadmap's open row-level-scoping gap ("the guard answers 'may this user
 * read payslips', never 'may this user read THIS payslip'") is why
 * cross-employee payslip access sits behind the separate
 * `payslip.read.any`, and why payroll documents stay behind a payroll
 * permission rather than the generic `document.read`.
 */
@Controller()
export class PayrollController {
  constructor(
    private readonly profiles: PayProfilesService,
    private readonly runs: RunsService,
    private readonly payslipsService: PayslipsService,
    private readonly finalPay: FinalPayService,
    private readonly exports: ExportsService,
    @Inject(DB_POOL) private readonly pool: Pool,
    @Inject(CRYPTO_HEALTH) private readonly cryptoHealth: HealthCheckPort,
    @Inject(CONFIG_HEALTH) private readonly configHealth: HealthCheckPort,
  ) {}

  @Get('health')
  @Public()
  async health(): Promise<HealthPayload> {
    const db = await this.checkDb()
    const [crypto, config] = await Promise.all([this.cryptoHealth.check(), this.configHealth.check()])
    // "A stuck outbox must be observable" (event-bus task) — there is no
    // alerting anywhere in this system, so `payroll.committed`/
    // `payslip.issued` rows the relay has fallen behind on must surface
    // here, the one place an operator already looks. A failure reading
    // the outbox itself (distinct from `db` above, which only proves the
    // pool can run `SELECT 1`) degrades the response rather than being
    // swallowed into a healthy-looking zero — same fail-closed reasoning
    // as every dependency check on this endpoint.
    let outbox: { pending: number; oldestAgeSeconds: number | null } | undefined
    let outboxQuery: 'up' | 'down' = 'up'
    try {
      outbox = await outboxDepth(this.pool, 'payroll')
    } catch {
      outboxQuery = 'down'
    }
    return buildHealth('svc-payroll', { db, crypto, config, ...(outboxQuery === 'down' ? { outboxQuery } : {}) }, process.env, outbox)
  }

  // ------------------------------------------------------- M7-1 profiles

  @Get('profiles/:employeeId')
  @RequirePermission('payroll.profile.read')
  async getProfile(@Param('employeeId') employeeId: string): Promise<PayProfileView> {
    return this.runFailClosed(() => this.profiles.view(employeeId, 'payroll.profile.read'))
  }

  /** Rejects a base pay below the employee's provincial minimum with PAY-010, citing the province, the floor and the notification. */
  @Put('profiles/:employeeId')
  @RequirePermission('payroll.profile.write')
  async putProfile(@Param('employeeId') employeeId: string, @Body() body: PayProfileInputDto): Promise<PayProfileView> {
    return this.runFailClosed(() => withTransaction(this.pool, (tx) => this.profiles.upsert(tx, employeeId, body, today())))
  }

  // ---------------------------------------------------- M7-3 run lifecycle

  @Post('runs')
  @RequirePermission('payroll.run.prepare')
  async createRun(@Req() req: AuthenticatedRequest, @Body() body: CreateRunBody): Promise<PayrollRunRow> {
    const preparedBy = this.requireUserId(req)
    return this.runFailClosed(() =>
      withTransaction(this.pool, (tx) =>
        this.runs.createRun(tx, {
          period: body.period,
          runType: body.runType,
          preparedBy,
          periodStart: body.periodStart,
          periodEnd: body.periodEnd,
          payDate: body.payDate,
          adjustsRunId: body.adjustsRunId ?? null,
        }),
      ),
    )
  }

  @Get('runs')
  @RequirePermission('payroll.run.prepare')
  async listRuns(@Query('period') period?: string): Promise<{ runs: PayrollRunRow[] }> {
    return this.runFailClosed(async () => ({ runs: await this.runs.list(period ?? null, this.pool) }))
  }

  @Post('runs/:id/calculate')
  @RequirePermission('payroll.run.calculate')
  async calculate(@Param('id') id: string, @Body() body: CalculateBody): Promise<CalculationOutcome> {
    return this.runFailClosed(() => withTransaction(this.pool, (tx) => this.runs.calculate(tx, id, body.employeeIds)))
  }

  /** Line-level movement against the previous period's committed run; the threshold is config, and an employee with no prior period is always flagged. */
  @Get('runs/:id/variance')
  @RequirePermission('payroll.run.approve')
  async variance(@Param('id') id: string): Promise<{ lines: VarianceLine[] }> {
    return this.runFailClosed(async () => ({ lines: await this.runs.variance(id, this.pool) }))
  }

  @Post('runs/:id/review')
  @RequirePermission('payroll.run.prepare')
  async review(@Req() req: AuthenticatedRequest, @Param('id') id: string): Promise<PayrollRunRow> {
    const reviewedBy = this.requireUserId(req)
    return this.runFailClosed(() => withTransaction(this.pool, (tx) => this.runs.review(tx, id, reviewedBy)))
  }

  /** Preparer ≠ approver: a preparer approving their own run gets AUZ-409 from `RunsService`, and the DB CHECK refuses it too. */
  @Post('runs/:id/approve')
  @RequirePermission('payroll.run.approve')
  async approve(@Req() req: AuthenticatedRequest, @Param('id') id: string): Promise<PayrollRunRow> {
    const approvedBy = this.requireUserId(req)
    return this.runFailClosed(() => withTransaction(this.pool, (tx) => this.runs.approve(tx, id, approvedBy)))
  }

  @Post('runs/:id/commit')
  @RequirePermission('payroll.run.commit')
  async commit(@Param('id') id: string): Promise<PayrollRunRow> {
    return this.runFailClosed(() => withTransaction(this.pool, (tx) => this.runs.commit(tx, id)))
  }

  /** Corrections to a committed run: a NEW run that references it, never an edit. */
  @Post('adjustment-runs')
  @RequirePermission('payroll.run.prepare')
  async adjustmentRun(@Req() req: AuthenticatedRequest, @Body() body: AdjustmentRunBody): Promise<PayrollRunRow> {
    const preparedBy = this.requireUserId(req)
    return this.runFailClosed(() =>
      withTransaction(this.pool, (tx) => this.runs.createAdjustmentRun(tx, body.targetRunId, preparedBy, body.payDate)),
    )
  }

  // ------------------------------------------------------- M7-4 payslips

  @Get('runs/:id/payslips')
  @RequirePermission('payslip.read.any')
  async runPayslips(@Param('id') id: string): Promise<{ payslips: PayslipSummary[] }> {
    return this.runFailClosed(async () => ({ payslips: await this.payslipsService.listForRun(id, this.pool) }))
  }

  /** Self-scoped by construction — `employeeId` is `req.userId`, never a request parameter. */
  @Get('my/payslips')
  @RequirePermission('payslip.read.self')
  async myPayslips(@Req() req: AuthenticatedRequest, @Query('lang') lang?: string): Promise<{ payslips: PayslipSummary[] }> {
    const employeeId = this.requireUserId(req)
    return this.runFailClosed(async () => ({ payslips: await this.payslipsService.listForEmployee(employeeId, lang ?? null, this.pool) }))
  }

  // -------------------------------- M7-5 bank files · M7-6 statutory data

  @Post('runs/:id/bank-file')
  @RequirePermission('payroll.export')
  async bankFile(@Param('id') id: string, @Body() body: BankFileBody): Promise<BankFileResult> {
    return this.runFailClosed(() => this.exports.renderBankFile(id, body.format, this.pool))
  }

  @Post('runs/:id/exports/:kind')
  @RequirePermission('payroll.export')
  async statutoryExport(@Param('id') id: string, @Param('kind') kind: string): Promise<GeneratedExport> {
    if (!isStatutoryExportKind(kind)) {
      throw new HttpException(unsupportedBankFormat(kind, Object.keys(EXPORT_BUILDERS)).toEnvelope(), 422)
    }
    return this.runFailClosed(() => this.exports.renderStatutory(id, kind, this.pool))
  }

  // ------------------------------------------------------ M7-7 final pay

  /** Severance by the s.118 tiers, notice in lieu, and the s.119 cause when severance is withheld — queued as inputs the final-pay run then pays. */
  @Post('final-pay/:employeeId')
  @RequirePermission('payroll.run.prepare')
  async finalPayAssessment(@Param('employeeId') employeeId: string, @Body() body: FinalPayBody): Promise<FinalPayAssessment> {
    return this.runFailClosed(() => withTransaction(this.pool, (tx) => this.finalPay.assess(tx, employeeId, body.period)))
  }

  // --------------------------------------------------------------- guts

  private async checkDb(): Promise<'up' | 'down'> {
    try {
      await this.pool.query('SELECT 1')
      return 'up'
    } catch {
      return 'down'
    }
  }

  private requireUserId(req: AuthenticatedRequest): string {
    if (!req.userId) throw new HttpException({ code: 'PAY-401', message_i18n_key: 'payroll.error.unauthenticated', details: [] }, 401)
    return req.userId
  }

  private async runFailClosed<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (err) {
      if (err instanceof GadongError) throw new HttpException(err.toEnvelope(), err.httpStatus)
      throw err
    }
  }
}
