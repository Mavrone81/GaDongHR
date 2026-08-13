import { Body, Controller, Get, HttpException, Inject, Param, Post, Patch, Query, Req } from '@nestjs/common'
import { GadongError, Public, RequirePermission, buildHealth, outboxDepth, withTransaction } from '@gadong/kernel'
import type { AuthenticatedRequest, HealthPayload } from '@gadong/kernel'
import type { Pool } from 'pg'
import type { ApprovalDecision, ApprovalStepRow } from './approvals.repository'
import { ApprovalsService } from './approvals.service'
import type { ApproverAssignments } from './approvals.service'
import { BalancesService } from './balances.service'
import type { LeaveBalanceRow, LedgerEntryRow } from './balances.repository'
import { EssBalancesService } from './ess-balances.service'
import type { BalanceSummary } from './ess-balances.service'
import type { CreateLeaveTypeInput, UpdateLeaveTypeInput } from './leave-types.service'
import { LeaveTypesService } from './leave-types.service'
import type { LeaveTypeRow } from './leave-types.repository'
import { RequestsService } from './requests.service'
import type { HalfDayPeriod, LeaveRequestRow } from './requests.repository'

/** DI token for the `leave` schema's connection pool — the same `Symbol` token pattern every other service's `DB_POOL` established. */
export const DB_POOL = Symbol('DB_POOL')
/** DI token for the reachability check against `svc-crypto` — `leave_request.attachment_ref` (a medical-certificate pointer, health data under PDPA s.26) is envelope-encrypted through it before write. */
export const CRYPTO_HEALTH = Symbol('CRYPTO_HEALTH')
/** DI token for the reachability check against `svc-config` — every statutory figure this service compares against resolves from there at runtime. */
export const CONFIG_HEALTH = Symbol('CONFIG_HEALTH')

/** A dependency this controller can ask "are you up" — the same shape `svc-attendance`'s/this service's own `HealthCheckPort` established (see `app.module.ts`). */
export interface HealthCheckPort {
  check(): Promise<'up' | 'down'>
}

type CreateLeaveTypeBody = CreateLeaveTypeInput
type UpdateLeaveTypeBody = UpdateLeaveTypeInput

interface SubmitRequestBody {
  employeeId: string
  leaveTypeId: string
  startDate: string
  endDate: string
  halfDayPeriod?: HalfDayPeriod
  hours?: string
  attachmentPointer?: string
  /** Caller-supplied `{level: approverId}` map — this service has no org-chart data of its own; see `approvals.service.ts`'s `ApproverAssignments` doc. */
  approverAssignments?: ApproverAssignments
}

interface DecisionBody {
  decision: ApprovalDecision
  comment?: string
}

interface AdjustBalanceBody {
  leaveTypeId: string
  year: number
  delta: string
  reason: string
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * The HTTP boundary for `/types*`, `/my/balances`, `/balances/*`,
 * `/requests*`, `/approvals*` and `/health` (M5-LEAVE.md §3). Every route
 * but `/health` declares exactly one permission via the kernel's
 * `@RequirePermission` — deny-by-default is structural in `PermissionGuard`
 * (see `app.module.ts`), matching every other controller in this codebase.
 * No SQL, no floor-checking, no balance/encryption logic here — the five
 * services this controller composes own all of that; this file's only
 * DB-shaped responsibility is opening the transaction each write spans, via
 * kernel's `withTransaction`, so a write and its outbox row commit or roll
 * back together.
 */
@Controller()
export class LeaveController {
  constructor(
    private readonly leaveTypesService: LeaveTypesService,
    private readonly essBalancesService: EssBalancesService,
    private readonly balancesService: BalancesService,
    private readonly requestsService: RequestsService,
    private readonly approvalsService: ApprovalsService,
    @Inject(DB_POOL) private readonly pool: Pool,
    @Inject(CRYPTO_HEALTH) private readonly cryptoHealth: HealthCheckPort,
    @Inject(CONFIG_HEALTH) private readonly configHealth: HealthCheckPort,
  ) {}

  @Get('types')
  @RequirePermission('leave.request')
  async listTypes(): Promise<{ types: LeaveTypeRow[] }> {
    return { types: await this.leaveTypesService.list() }
  }

  /** Type CRUD; statutory floor check → 422 `LVE-030` with citation (M5-1's central interaction). */
  @Post('types')
  @RequirePermission('leave.admin')
  async createType(@Body() body: CreateLeaveTypeBody): Promise<LeaveTypeRow> {
    return this.runFailClosed(() => withTransaction(this.pool, (tx) => this.leaveTypesService.create(tx, body)))
  }

  @Patch('types/:id')
  @RequirePermission('leave.admin')
  async updateType(@Param('id') id: string, @Body() body: UpdateLeaveTypeBody): Promise<LeaveTypeRow> {
    return this.runFailClosed(() => withTransaction(this.pool, (tx) => this.leaveTypesService.update(tx, id, body)))
  }

  /** Own balances + projection `?asOf=date` (M5-5). Self-scoped by construction: `employeeId` is always `req.userId`, never a request-supplied value. */
  @Get('my/balances')
  @RequirePermission('leave.balance.read')
  async myBalances(@Req() req: AuthenticatedRequest, @Query('year') year?: string, @Query('asOf') asOf?: string): Promise<{ balances: BalanceSummary[] }> {
    const employeeId = this.requireUserId(req)
    const y = year !== undefined ? Number(year) : new Date().getUTCFullYear()
    const balances = await this.runFailClosed(() => this.essBalancesService.summarize(employeeId, y, asOf, today()))
    return { balances }
  }

  /** HR/manager view of any employee's balances (data-scoping beyond the `leave.balance.read` permission is `svc-authz`'s job, matching every other cross-employee route in this codebase). */
  @Get('balances/:employeeId')
  @RequirePermission('leave.balance.read')
  async employeeBalances(@Param('employeeId') employeeId: string, @Query('year') year?: string, @Query('asOf') asOf?: string): Promise<{ balances: BalanceSummary[] }> {
    const y = year !== undefined ? Number(year) : new Date().getUTCFullYear()
    const balances = await this.runFailClosed(() => this.essBalancesService.summarize(employeeId, y, asOf, today()))
    return { balances }
  }

  @Get('balances/:employeeId/ledger')
  @RequirePermission('leave.balance.read')
  async ledger(@Param('employeeId') employeeId: string, @Query('leaveTypeId') leaveTypeId: string): Promise<{ ledger: LedgerEntryRow[] }> {
    return { ledger: await this.essBalancesService.ledger(employeeId, leaveTypeId) }
  }

  @Post('balances/:employeeId/adjust')
  @RequirePermission('leave.admin')
  async adjustBalance(@Param('employeeId') employeeId: string, @Body() body: AdjustBalanceBody): Promise<LeaveBalanceRow> {
    return this.runFailClosed(() =>
      withTransaction(this.pool, (tx) => this.balancesService.adjust(tx, employeeId, body.leaveTypeId, body.year, body.delta, body.reason)),
    )
  }

  /** Apply `{leaveTypeId, dates, days, attachment?}`; sick-cert rule and dates-overlap/insufficient-balance guards enforced. Creates the approval chain in the SAME transaction as the request, so a request is never left without its approval steps. */
  @Post('requests')
  @RequirePermission('leave.request')
  async submitRequest(@Req() req: AuthenticatedRequest, @Body() body: SubmitRequestBody): Promise<{ request: LeaveRequestRow; steps: ApprovalStepRow[] }> {
    const employeeId = this.requireUserId(req)
    return this.runFailClosed(() =>
      withTransaction(this.pool, async (tx) => {
        const request = await this.requestsService.submit(tx, { ...body, employeeId })
        const steps = await this.approvalsService.createChain(tx, request.id, request.leaveTypeId, request.days, body.approverAssignments)
        return { request, steps }
      }),
    )
  }

  /** Guarded cancel; publishes `leave.cancelled` when the cancelled request had already been approved. */
  @Post('requests/:id/cancel')
  @RequirePermission('leave.request')
  async cancelRequest(@Req() req: AuthenticatedRequest, @Param('id') id: string): Promise<LeaveRequestRow> {
    const employeeId = this.requireUserId(req)
    return this.runFailClosed(() => withTransaction(this.pool, (tx) => this.requestsService.cancel(tx, id, employeeId, today())))
  }

  /** Queue with delegation view — every undecided step this caller may act on. */
  @Get('approvals')
  @RequirePermission('leave.approve')
  async pendingApprovals(@Req() req: AuthenticatedRequest): Promise<{ steps: ApprovalStepRow[] }> {
    const approverId = this.requireUserId(req)
    const pendingRequestIds = await this.requestsService.listPendingRequestIds()
    const steps = await this.approvalsService.listPendingForApprover(approverId, today(), pendingRequestIds)
    return { steps }
  }

  /** `{decision, comment}`; final level publishes `leave.approved`. */
  @Post('approvals/:id/decision')
  @RequirePermission('leave.approve')
  async decide(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() body: DecisionBody): Promise<ApprovalStepRow> {
    const approverId = this.requireUserId(req)
    return this.runFailClosed(() =>
      withTransaction(this.pool, (tx) => this.approvalsService.decide(tx, id, approverId, body.decision, body.comment ?? null, today())),
    )
  }

  @Get('health')
  @Public()
  async health(): Promise<HealthPayload> {
    const db = await this.checkDb()
    const crypto = await this.cryptoHealth.check()
    const config = await this.configHealth.check()
    // "A stuck outbox must be observable" (event-bus task) — a
    // `leave.approved`/`leave.cancelled`/`leave.balance_payout` row the
    // relay has fallen behind on must surface here, the one place an
    // operator already looks. A failure reading the outbox itself
    // (distinct from `db` above, which only proves the pool can run
    // `SELECT 1`) degrades the response rather than being swallowed into a
    // healthy-looking zero — same fail-closed reasoning as every other
    // dependency check on this endpoint.
    let outbox: { pending: number; oldestAgeSeconds: number | null } | undefined
    let outboxQuery: 'up' | 'down' = 'up'
    try {
      outbox = await outboxDepth(this.pool, 'leave')
    } catch {
      outboxQuery = 'down'
    }
    return buildHealth('svc-leave', { db, crypto, config, ...(outboxQuery === 'down' ? { outboxQuery } : {}) }, process.env, outbox)
  }

  private async checkDb(): Promise<'up' | 'down'> {
    try {
      await this.pool.query('SELECT 1')
      return 'up'
    } catch {
      return 'down'
    }
  }

  private requireUserId(req: AuthenticatedRequest): string {
    if (!req.userId) throw new HttpException({ code: 'LVE-401', message_i18n_key: 'leave.error.unauthenticated', details: [] }, 401)
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
