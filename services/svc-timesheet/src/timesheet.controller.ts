import { Body, Controller, Get, HttpException, Inject, Param, Post, Query, Req } from '@nestjs/common'
import { AuthzClient, GadongError, Public, RequirePermission, buildHealth, outboxDepth, withTransaction } from '@gadong/kernel'
import type { AuthenticatedRequest, HealthPayload } from '@gadong/kernel'
import type { Pool } from 'pg'
import type { ProposeInput } from './exceptions.service'
import { ExceptionsService } from './exceptions.service'
import type { OrgScope } from './org-scope'
import type { LockResult, UnlockResult } from './period.service'
import { PeriodService } from './period.service'
import { ViewsService } from './views.service'
import { minutesToHoursString } from './hours'

/** DI token for the `timesheet` schema's connection pool — the same `Symbol` token pattern every other service's `DB_POOL` established. */
export const DB_POOL = Symbol('DB_POOL')

interface ProposeBody {
  actualIn?: string | null
  actualOut?: string | null
  resolutionNote: string
  reason: string
}

interface ManualPunchBody {
  employeeId: string
  punchedAt: string
  direction: 'in' | 'out'
}

interface CreatePeriodBody {
  from: string
  to: string
}

interface UnlockBody {
  reason: string
}

/**
 * The HTTP boundary for `svc-timesheet` (M3-TIMESHEET.md §3 API manual).
 * Every route but `GET /health` declares exactly one `@RequirePermission`
 * (brief CONSTRAINTS) — deny-by-default is `PermissionGuard`'s job
 * (`app.module.ts`), this controller's only auth-shaped responsibility is
 * the SECOND `AuthzClient.decide()` call each cross-employee route makes to
 * recover `Decision.scopeOrgUnitIds` for row scoping (`org-scope.ts`'s doc
 * explains why a second call is necessary — `PermissionGuard` computes and
 * discards this same `Decision` on its own first call).
 */
@Controller()
export class TimesheetController {
  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    private readonly authzClient: AuthzClient,
    private readonly views: ViewsService,
    private readonly exceptionsService: ExceptionsService,
    private readonly periodService: PeriodService,
  ) {}

  // ---------- views (M3-5) ----------

  @Get('my/days')
  @RequirePermission('timesheet.read')
  async myDays(@Req() req: AuthenticatedRequest, @Query('from') from: string, @Query('to') to: string) {
    const employeeId = this.requireUserId(req)
    const days = await this.runFailClosed(() => this.views.myDays(employeeId, from, to))
    return { days }
  }

  @Get('teams/:orgUnit/days')
  @RequirePermission('timesheet.read')
  async teamDays(@Req() req: AuthenticatedRequest, @Param('orgUnit') orgUnit: string, @Query('from') from: string, @Query('to') to: string) {
    const scope = await this.scopeFor(req, 'timesheet.read')
    const days = await this.runFailClosed(() => this.views.teamDays(orgUnit, from, to, scope))
    return { days }
  }

  @Get('days/:employeeId')
  @RequirePermission('timesheet.read')
  async employeeDays(@Req() req: AuthenticatedRequest, @Param('employeeId') employeeId: string, @Query('from') from: string, @Query('to') to: string) {
    const callerId = this.requireUserId(req)
    const scope = await this.scopeFor(req, 'timesheet.read')
    const days = await this.runFailClosed(() => this.views.employeeDays(employeeId, from, to, callerId, scope))
    return { days }
  }

  @Get('exceptions')
  @RequirePermission('timesheet.read')
  async exceptions(@Req() req: AuthenticatedRequest, @Query('status') status: 'open' | 'resolved' = 'open', @Query('org_unit') orgUnit?: string) {
    const callerId = this.requireUserId(req)
    const scope = await this.scopeFor(req, 'timesheet.read')
    const exceptions = await this.runFailClosed(() => this.views.exceptionsQueue(status, orgUnit ?? null, callerId, scope))
    return { exceptions }
  }

  // ---------- exception correction (M3-3) ----------

  @Post('exceptions/:id/propose')
  @RequirePermission('timesheet.correct')
  async proposeException(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() body: ProposeBody) {
    const proposedBy = this.requireUserId(req)
    const input: ProposeInput = { actualIn: body.actualIn, actualOut: body.actualOut, resolutionNote: body.resolutionNote, reason: body.reason }
    return this.runFailClosed(() => withTransaction(this.pool, (tx) => this.exceptionsService.propose(tx, id, proposedBy, input)))
  }

  @Post('exceptions/:id/confirm')
  @RequirePermission('timesheet.correct')
  async confirmException(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    const confirmedBy = this.requireUserId(req)
    return this.runFailClosed(() => withTransaction(this.pool, (tx) => this.exceptionsService.confirm(tx, id, confirmedBy)))
  }

  @Post('manual-punch')
  @RequirePermission('timesheet.correct')
  async manualPunch(@Body() body: ManualPunchBody) {
    const day = await this.runFailClosed(() =>
      withTransaction(this.pool, (tx) => this.exceptionsService.manualPunch(tx, body.employeeId, body.punchedAt, body.direction)),
    )
    return { day }
  }

  // ---------- period locking (M3-4) ----------

  @Get('periods')
  @RequirePermission('timesheet.lock')
  async listPeriods() {
    const periods = await this.runFailClosed(() => this.periodService.list())
    return { periods }
  }

  @Post('periods')
  @RequirePermission('timesheet.lock')
  async createPeriod(@Body() body: CreatePeriodBody) {
    const period = await this.runFailClosed(() => withTransaction(this.pool, (tx) => this.periodService.create(tx, body.from, body.to)))
    return { period }
  }

  @Post('periods/:id/lock')
  @RequirePermission('timesheet.lock')
  async lockPeriod(@Req() req: AuthenticatedRequest, @Param('id') id: string): Promise<LockResult> {
    const lockedBy = this.requireUserId(req)
    return this.runFailClosed(() => withTransaction(this.pool, (tx) => this.periodService.lock(tx, id, lockedBy)))
  }

  /** `timesheet.unlock` — a DIFFERENT permission from `timesheet.lock`, granted only to `payroll-approver` (roadmap: "timesheet unlock: requires timesheet.unlock (Payroll Approver only) + reason"); an HR Officer holding only `timesheet.lock` is denied by `PermissionGuard` itself (TC-M3-014), before this handler ever runs. */
  @Post('periods/:id/unlock')
  @RequirePermission('timesheet.unlock')
  async unlockPeriod(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() body: UnlockBody): Promise<UnlockResult> {
    const unlockedBy = this.requireUserId(req)
    return this.runFailClosed(() => withTransaction(this.pool, (tx) => this.periodService.unlock(tx, id, unlockedBy, body.reason)))
  }

  /** Locked-version snapshot export (M3-TIMESHEET.md API #10) — scoped identically to the org view (`timesheet.read`'s `Decision.scopeOrgUnitIds`; the roadmap's canonical permission catalog has no separate `timesheet.export` code), a plain row export of every in-scope day_record within the period's range. */
  @Get('periods/:id/export')
  @RequirePermission('timesheet.read')
  async exportPeriod(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    const period = await this.runFailClosed(async () => {
      const found = (await this.periodService.list()).find((p) => p.id === id)
      if (!found) throw new GadongError('TSH-050', 'timesheet.error.period_not_found', 404, [{ periodId: id }])
      return found
    })
    const scope = await this.scopeFor(req, 'timesheet.read')
    const rows = await this.runFailClosed(() => this.exportRows(period.from, period.to, scope))
    return { periodId: id, lockVersion: period.lockVersion, rows }
  }

  /** `GET /ot/summary?period&org_unit` (M3-TIMESHEET.md API #11) — OT hours by rate class for the scoped employees within `[from, to]`. */
  @Get('ot/summary')
  @RequirePermission('timesheet.read')
  async otSummary(@Req() req: AuthenticatedRequest, @Query('from') from: string, @Query('to') to: string, @Query('org_unit') orgUnit?: string) {
    const scope = await this.scopeFor(req, 'timesheet.read')
    const days = await this.runFailClosed(() => (orgUnit ? this.views.teamDays(orgUnit, from, to, scope) : this.exportAllInScope(from, to, scope)))
    const totals = days.reduce(
      (acc, d) => ({
        ot15x: acc.ot15x + Number.parseFloat(d.ot15x),
        ot2x: acc.ot2x + Number.parseFloat(d.ot2x),
        ot3x: acc.ot3x + Number.parseFloat(d.ot3x),
      }),
      { ot15x: 0, ot2x: 0, ot3x: 0 },
    )
    return {
      from,
      to,
      totals: {
        ot15x: minutesToHoursString(Math.round(totals.ot15x * 60)),
        ot2x: minutesToHoursString(Math.round(totals.ot2x * 60)),
        ot3x: minutesToHoursString(Math.round(totals.ot3x * 60)),
      },
      employeeCount: new Set(days.map((d) => d.employeeId)).size,
    }
  }

  @Get('health')
  @Public()
  async health(): Promise<HealthPayload> {
    const db = await this.checkDb()
    // "A stuck outbox must be observable" (event-bus task) — see
    // `svc-payroll`'s identical wiring/reasoning in `payroll.controller.ts`.
    let outbox: { pending: number; oldestAgeSeconds: number | null } | undefined
    let outboxQuery: 'up' | 'down' = 'up'
    try {
      outbox = await outboxDepth(this.pool, 'timesheet')
    } catch {
      outboxQuery = 'down'
    }
    return buildHealth('svc-timesheet', { db, ...(outboxQuery === 'down' ? { outboxQuery } : {}) }, process.env, outbox)
  }

  // ---------- helpers ----------

  private async exportRows(from: string, to: string, scope: OrgScope): Promise<Array<{ employeeId: string; workDate: string; workedHours: string; ot15x: string; ot2x: string; ot3x: string; status: string }>> {
    const days = await this.exportAllInScope(from, to, scope)
    return days.map((d) => ({ employeeId: d.employeeId, workDate: d.workDate, workedHours: d.workedHours, ot15x: d.ot15x, ot2x: d.ot2x, ot3x: d.ot3x, status: d.status }))
  }

  private async exportAllInScope(from: string, to: string, scope: OrgScope) {
    if (scope === '*') return this.views.allDays(from, to)
    if (scope === 'self') throw new GadongError('AUZ-403', 'authz.error.denied', 403, [{ reason: 'self_scope_cannot_export' }])
    return this.views.orgUnitsDays(scope, from, to)
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
    if (!req.userId) throw new HttpException({ code: 'TSH-401', message_i18n_key: 'timesheet.error.unauthenticated', details: [] }, 401)
    return req.userId
  }

  /**
   * The second `AuthzClient.decide()` call `org-scope.ts`'s doc explains —
   * `PermissionGuard` already made this same call and DISCARDED the
   * `Decision`, keeping only `.allowed`. Fails closed (denies) if this
   * second call somehow disagrees with the guard's (e.g. a grant revoked in
   * the gap between the two calls) rather than trusting a stale allow.
   */
  private async scopeFor(req: AuthenticatedRequest, permission: string): Promise<OrgScope> {
    const userId = this.requireUserId(req)
    const decision = await this.authzClient.decide(userId, permission)
    if (!decision.allowed) throw new HttpException({ code: 'AUZ-403', message_i18n_key: 'authz.error.denied', details: [{ permission }] }, 403)
    return decision.scopeOrgUnitIds
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
