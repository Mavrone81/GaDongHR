import { Body, Controller, Get, HttpException, Inject, Param, Patch, Post, Put, Query } from '@nestjs/common'
import { GadongError, Public, RequirePermission, buildHealth, withTransaction } from '@gadong/kernel'
import type { HealthPayload } from '@gadong/kernel'
import type { Pool } from 'pg'
import { ClaimTypesService } from './claim-types.service'
import type { ClaimTypeInput } from './claim-types.service'
import type { ClaimTypeRow, LimitKind } from './claim-types.repository'
import { ApprovalBandsService } from './approval-bands.service'
import type { ApprovalBandRow, NewApprovalBandRow } from './approval-bands.repository'
import { ClaimsService } from './claims.service'
import type { ReceiptInput, ResubmitClaimInput, SubmitClaimInput, SubmitClaimResult } from './claims.service'
import type { ApprovalDecision, ClaimRow, ReimbursementRoute } from './claims.repository'

/** DI token for the `claims` schema's connection pool — the same `Symbol` token pattern `svc-config`'s/`svc-leave`'s `DB_POOL` established. `app.module.ts` binds it to a real `pg.Pool` via kernel's `createPool`. */
export const DB_POOL = Symbol('DB_POOL')
/** DI token for the reachability check against `svc-crypto` — `/health` reports `crypto` because `receipt.file_ref` (a MinIO-style pointer to a receipt photo/PDF that can incidentally contain medical information) is envelope-encrypted through it before write. */
export const CRYPTO_HEALTH = Symbol('CRYPTO_HEALTH')

export interface HealthCheckPort {
  check(): Promise<'up' | 'down'>
}

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
  employeeId: string
  claimTypeCode: string
  claimDate: string
  vendor: string
  amountThb?: string
  mileageKm?: string
  receipts?: ReceiptInput[]
  fields?: Record<string, unknown>
}

interface ResubmitClaimBody {
  employeeId: string
  claimDate?: string
  vendor?: string
  amountThb?: string
  mileageKm?: string
  receipts?: ReceiptInput[]
  fields?: Record<string, unknown>
}

interface DecisionBody {
  approverId: string
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
 * Actor identity (`employeeId`/`approverId`) is carried explicitly in each
 * request body/query rather than derived from the authenticated principal —
 * the same precedent `services/svc-config`'s `RulesController` sets with
 * `approvedBy` in `POST /rules/:id/approve`'s body: no employee-identity
 * resolution service is wired into the kernel yet for any service to derive
 * "the calling employee" from `request.userId`.
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
  async submit(@Body() body: SubmitClaimBody): Promise<SubmitClaimResult> {
    const input: SubmitClaimInput = { ...body, receipts: body.receipts ?? [] }
    return this.runFailClosed(() => withTransaction(this.pool, (tx) => this.claimsService.submit(tx, input)))
  }

  @Get('my/claims')
  @RequirePermission('claim.submit')
  async myClaims(@Query('employeeId') employeeId: string, @Query('status') status?: string): Promise<{ claims: ClaimRow[] }> {
    // Read-only — goes through a repository method reachable off the
    // service's injected pool, matching every other read route in this
    // controller (no transaction needed for a read).
    const claims = await this.runFailClosed(() => this.claimsService.listForEmployee(employeeId, status))
    return { claims }
  }

  @Post('claims/:id/resubmit')
  @RequirePermission('claim.submit')
  async resubmit(@Param('id') id: string, @Body() body: ResubmitClaimBody): Promise<SubmitClaimResult> {
    const { employeeId, ...rest } = body
    const input: ResubmitClaimInput = rest
    return this.runFailClosed(() => withTransaction(this.pool, (tx) => this.claimsService.resubmit(tx, id, employeeId, input)))
  }

  @Post('claims/:id/decisions/manager')
  @RequirePermission('claim.approve')
  async decideManager(@Param('id') id: string, @Body() body: DecisionBody): Promise<ClaimRow> {
    return this.runFailClosed(() =>
      withTransaction(this.pool, (tx) =>
        this.claimsService.decide(tx, id, 'manager', body.approverId, body.decision, body.comment ?? null),
      ),
    )
  }

  @Post('claims/:id/decisions/finance')
  @RequirePermission('claim.approve.finance')
  async decideFinance(@Param('id') id: string, @Body() body: DecisionBody): Promise<ClaimRow> {
    return this.runFailClosed(() =>
      withTransaction(this.pool, (tx) =>
        this.claimsService.decide(tx, id, 'finance', body.approverId, body.decision, body.comment ?? null),
      ),
    )
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
    return buildHealth('svc-claims', { db, crypto })
  }

  private async checkDb(): Promise<'up' | 'down'> {
    try {
      await this.pool.query('SELECT 1')
      return 'up'
    } catch {
      return 'down'
    }
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
