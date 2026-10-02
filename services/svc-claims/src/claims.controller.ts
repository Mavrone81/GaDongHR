import { Body, Controller, Get, HttpException, Inject, Param, Patch, Post, Put, Query, Req } from '@nestjs/common'
import { GadongError, Public, RequirePermission, buildHealth, outboxDepth, scopeAllowsEmployee, withTransaction } from '@gadong/kernel'
import type { AuthenticatedRequest, HealthPayload } from '@gadong/kernel'
import type { Pool } from 'pg'
import { ClaimTypesService } from './claim-types.service'
import type { ClaimTypeInput } from './claim-types.service'
import type { ClaimTypeRow, LimitKind } from './claim-types.repository'
import { ApprovalBandsService } from './approval-bands.service'
import type { ApprovalBandRow, NewApprovalBandRow } from './approval-bands.repository'
import { ClaimsService } from './claims.service'
import type { ReceiptInput, ResubmitClaimInput, SubmitClaimInput, SubmitClaimResult } from './claims.service'
import type { ApprovalDecision, ClaimRow, ReimbursementRoute } from './claims.repository'
import { employeeOutOfScope } from './errors'

/** DI token for the `claims` schema's connection pool — the same `Symbol` token pattern `svc-config`'s/`svc-leave`'s `DB_POOL` established. `app.module.ts` binds it to a real `pg.Pool` via kernel's `createPool`. */
export const DB_POOL = Symbol('DB_POOL')
/** DI token for the reachability check against `svc-crypto` — `/health` reports `crypto` because `receipt.file_ref` (a MinIO-style pointer to a receipt photo/PDF that can incidentally contain medical information) is envelope-encrypted through it before write. */
export const CRYPTO_HEALTH = Symbol('CRYPTO_HEALTH')

export interface HealthCheckPort {
  check(): Promise<'up' | 'down'>
}

/** Minimal shape every OIDC-authenticated request carries once `OidcMiddleware`/`PermissionGuard` run — matches `services/svc-onboarding`'s `employee.controller.ts`'s use of the same kernel type. */
type Req = AuthenticatedRequest

interface ClaimTypeBody {
  code: string
  name: string
  perClaimLimit?: string | null
  perClaimLimitKind?: LimitKind | null
  monthlyLimit?: string | null
  monthlyLimitKind?: LimitKind | null
  annualLimit?: string | null
  annualLimitKind?: LimitKind | null
  receiptRequired: boolean
  requiredFields?: string[]
  mileageRate?: string | null
  active?: boolean
}

interface ApprovalBandsBody {
  bands: NewApprovalBandRow[]
}

interface SubmitClaimBody {
  /** Optional: the claim's employee is taken from the signed-in session
   * (`resolveEmployeeId`). A caller whose `claim.submit` grant carries a
   * scope wider than `'self'` may supply a different value here; an
   * ordinary employee's request simply omits it. */
  employeeId?: string
  claimTypeCode: string
  claimDate: string
  vendor: string
  amountThb?: string
  mileageKm?: string
  receipts?: ReceiptInput[]
  fields?: Record<string, unknown>
}

interface ResubmitClaimBody {
  /** Same optional-override semantics as `SubmitClaimBody.employeeId` — see there. */
  employeeId?: string
  claimDate?: string
  vendor?: string
  amountThb?: string
  mileageKm?: string
  receipts?: ReceiptInput[]
  fields?: Record<string, unknown>
}

interface DecisionBody {
  decision: ApprovalDecision
  comment?: string
}

interface RouteBody {
  route: ReimbursementRoute
}

/**
 * The HTTP boundary for `/types`, `/approval-bands`, `/claims*` and
 * `/health` (Task 14 brief P0: M6-1..M6-5). Every route but `/health`
 * declares exactly one permission via the kernel's `@RequirePermission` —
 * deny-by-default is structural in `PermissionGuard`, not a convention this
 * controller could opt out of by omission (matching `services/svc-config`).
 *
 * No SQL, no business logic here — `ClaimTypesService`/`ApprovalBandsService`/
 * `ClaimsService` own that (matching `services/svc-config`'s controller/
 * service split). This controller's only DB-shaped responsibility is
 * opening the transaction each write spans, via kernel's `withTransaction`,
 * so a state change and its outbox row commit or roll back together.
 *
 * Actor identity (`employeeId` for submit/myClaims/resubmit, `approverId`
 * for the decision routes) is derived from the authenticated session
 * (`requireUserId`, `resolveEmployeeId` below), the same pattern
 * `services/svc-leave`'s `leave.controller.ts` and
 * `services/svc-onboarding`'s `employee.controller.ts` use. `employeeId`
 * additionally accepts an explicit value in the request, gated on the
 * caller's OWN `claim.submit` authz scope (not just permission presence)
 * via kernel's `scopeAllowsEmployee` — the same mechanism
 * `employee.read` uses for onboarding's profile scoping — so a role
 * whose grant is wider than `'self'` may specify a different employee;
 * an ordinary `'self'`-scoped grant's request is always resolved to the
 * caller's own id regardless of what it supplies. The decision routes
 * take no such override: `approverId` is always the signed-in caller.
 */
@Controller()
export class ClaimsController {
  constructor(
    private readonly claimTypesService: ClaimTypesService,
    private readonly approvalBandsService: ApprovalBandsService,
    private readonly claimsService: ClaimsService,
    @Inject(DB_POOL) private readonly pool: Pool,
    @Inject(CRYPTO_HEALTH) private readonly cryptoHealth: HealthCheckPort,
  ) {}

  // ---------------- claim types (M6-1) ----------------

  @Get('types')
  @RequirePermission('claim.submit')
  async listTypes(): Promise<{ types: ClaimTypeRow[] }> {
    const types = await this.runFailClosed(() => this.claimTypesService.list())
    return { types }
  }

  @Get('types/:code')
  @RequirePermission('claim.submit')
  async getType(@Param('code') code: string): Promise<ClaimTypeRow> {
    return this.runFailClosed(() => this.claimTypesService.get(code))
  }

  @Post('types')
  @RequirePermission('claim.admin')
  async createType(@Body() body: ClaimTypeBody): Promise<ClaimTypeRow> {
    const input: ClaimTypeInput = body
    return this.runFailClosed(() => withTransaction(this.pool, (tx) => this.claimTypesService.create(tx, input)))
  }

  @Patch('types/:code')
  @RequirePermission('claim.admin')
  async updateType(@Param('code') code: string, @Body() body: Omit<ClaimTypeBody, 'code'>): Promise<ClaimTypeRow> {
    return this.runFailClosed(() => withTransaction(this.pool, (tx) => this.claimTypesService.update(tx, code, body)))
  }

  // ---------------- approval bands (M6-3) ----------------

  @Get('approval-bands')
  @RequirePermission('claim.admin')
  async listApprovalBands(): Promise<{ bands: ApprovalBandRow[] }> {
    const bands = await this.runFailClosed(() => this.approvalBandsService.list())
    return { bands }
  }

  @Put('approval-bands')
  @RequirePermission('claim.admin')
  async replaceApprovalBands(@Body() body: ApprovalBandsBody): Promise<{ bands: ApprovalBandRow[] }> {
    const bands = await this.runFailClosed(() =>
      withTransaction(this.pool, (tx) => this.approvalBandsService.replace(tx, body.bands)),
    )
    return { bands }
  }

  // ---------------- claims (M6-2/M6-3/M6-4/M6-5) ----------------

  @Post('claims')
  @RequirePermission('claim.submit')
  async submit(@Body() body: SubmitClaimBody, @Req() req: Req): Promise<SubmitClaimResult> {
    return this.runFailClosed(async () => {
      const employeeId = this.resolveEmployeeId(req, body.employeeId)
      const input: SubmitClaimInput = { ...body, employeeId, receipts: body.receipts ?? [] }
      return withTransaction(this.pool, (tx) => this.claimsService.submit(tx, input))
    })
  }

  @Get('my/claims')
  @RequirePermission('claim.submit')
  async myClaims(@Req() req: Req, @Query('employeeId') employeeId?: string, @Query('status') status?: string): Promise<{ claims: ClaimRow[] }> {
    // Read-only — goes through a repository method reachable off the
    // service's injected pool, matching every other read route in this
    // controller (no transaction needed for a read).
    return this.runFailClosed(async () => {
      const resolvedEmployeeId = this.resolveEmployeeId(req, employeeId)
      const claims = await this.claimsService.listForEmployee(resolvedEmployeeId, status)
      return { claims }
    })
  }

  @Post('claims/:id/resubmit')
  @RequirePermission('claim.submit')
  async resubmit(@Param('id') id: string, @Body() body: ResubmitClaimBody, @Req() req: Req): Promise<SubmitClaimResult> {
    return this.runFailClosed(async () => {
      const { employeeId: requestedEmployeeId, ...rest } = body
      const employeeId = this.resolveEmployeeId(req, requestedEmployeeId)
      const input: ResubmitClaimInput = rest
      return withTransaction(this.pool, (tx) => this.claimsService.resubmit(tx, id, employeeId, input))
    })
  }

  @Post('claims/:id/decisions/manager')
  @RequirePermission('claim.approve')
  async decideManager(@Param('id') id: string, @Body() body: DecisionBody, @Req() req: Req): Promise<ClaimRow> {
    return this.runFailClosed(async () => {
      const approverId = this.requireUserId(req)
      return withTransaction(this.pool, (tx) =>
        this.claimsService.decide(tx, id, 'manager', approverId, body.decision, body.comment ?? null),
      )
    })
  }

  @Post('claims/:id/decisions/finance')
  @RequirePermission('claim.approve.finance')
  async decideFinance(@Param('id') id: string, @Body() body: DecisionBody, @Req() req: Req): Promise<ClaimRow> {
    return this.runFailClosed(async () => {
      const approverId = this.requireUserId(req)
      return withTransaction(this.pool, (tx) =>
        this.claimsService.decide(tx, id, 'finance', approverId, body.decision, body.comment ?? null),
      )
    })
  }

  @Post('claims/:id/route')
  @RequirePermission('claim.approve.finance')
  async route(@Param('id') id: string, @Body() body: RouteBody): Promise<ClaimRow> {
    return this.runFailClosed(() => withTransaction(this.pool, (tx) => this.claimsService.route(tx, id, body.route)))
  }

  // ---------------- health ----------------

  @Get('health')
  @Public()
  async health(): Promise<HealthPayload> {
    const db = await this.checkDb()
    const crypto = await this.cryptoHealth.check()
    // "A stuck outbox must be observable" (event-bus task) — there is no
    // alerting anywhere in this system, so `claim.approved_for_payroll`/
    // `claim.paid_offcycle` rows the relay has fallen behind on must
    // surface here, the one place an operator already looks. A failure
    // reading the outbox itself (distinct from `db` above, which only
    // proves the pool can run `SELECT 1`) degrades the response rather
    // than being swallowed into a healthy-looking zero — same fail-closed
    // reasoning as every dependency check on this endpoint.
    let outbox: { pending: number; oldestAgeSeconds: number | null } | undefined
    let outboxQuery: 'up' | 'down' = 'up'
    try {
      outbox = await outboxDepth(this.pool, 'claims')
    } catch {
      outboxQuery = 'down'
    }
    return buildHealth('svc-claims', { db, crypto, ...(outboxQuery === 'down' ? { outboxQuery } : {}) }, process.env, outbox)
  }

  private async checkDb(): Promise<'up' | 'down'> {
    try {
      await this.pool.query('SELECT 1')
      return 'up'
    } catch {
      return 'down'
    }
  }

  /** `PermissionGuard` already denied any request with no authenticated principal before any handler on this controller runs (no route here is `@Public()` except `/health`) — this narrows the type, it does not add a new check. Same shape as `services/svc-leave`'s `leave.controller.ts` and `services/svc-onboarding`'s `employee.controller.ts`. */
  private requireUserId(req: Req): string {
    if (!req.userId) throw new HttpException({ code: 'CLM-401', message_i18n_key: 'claims.error.unauthenticated', details: [] }, 401)
    return req.userId
  }

  /**
   * `PermissionGuard` sets `request.authzScope` on every ALLOWED decision
   * (kernel `guard.ts`) — reaching a handler that calls this at all means
   * the guard already granted the route's permission, so this is only
   * absent if a future refactor removed that assignment; fails closed
   * rather than silently treating a missing scope as `'*'`. Same shape as
   * `employee.controller.ts`'s own `requireScope`.
   */
  private requireScope(req: Req): NonNullable<Req['authzScope']> {
    if (req.authzScope === undefined) {
      throw new HttpException({ code: 'CLM-500', message_i18n_key: 'claims.error.scope_missing', details: [] }, 500)
    }
    return req.authzScope
  }

  /**
   * Shared by `submit`/`myClaims`/`resubmit`. An ordinary employee's
   * `claim.submit` grant resolves to `authzScope: 'self'` (kernel
   * `authz.service.ts`'s "no org_scope_unit_id → 'self'" default — the
   * same mechanism `employee.read` relies on for onboarding's profile
   * scoping), so `requested` resolves to the caller's own id unless it
   * already equals it. A caller whose grant is wider (an org-unit list or
   * `'*'`) may supply a different `requested` within that scope —
   * `scopeAllowsEmployee`'s third argument (`targetOrgUnitId`) is always
   * `null` here because this service's local employee read-model
   * (`employee-ref.repository.ts`) tracks only `employeeId`/`status`, no
   * org unit; per that function's own doc, `null` resolves closed for an
   * org-unit-scoped grant and correctly for `'self'`/`'*'`, the two
   * scopes `claim.submit` grants use today.
   */
  private resolveEmployeeId(req: Req, requested: string | undefined): string {
    const callerId = this.requireUserId(req)
    if (!requested || requested === callerId) return callerId
    const scope = this.requireScope(req)
    if (!scopeAllowsEmployee(scope, callerId, requested, null)) throw employeeOutOfScope(requested)
    return requested
  }

  /** The same translation `crypto.controller.ts`/`rules.controller.ts` perform: a thrown `GadongError` becomes the `{code, message_i18n_key, details}` envelope at its declared HTTP status; anything else is a genuine bug and is left to propagate. */
  private async runFailClosed<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (err) {
      if (err instanceof GadongError) throw new HttpException(err.toEnvelope(), err.httpStatus)
      throw err
    }
  }
}
