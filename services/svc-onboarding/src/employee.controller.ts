import { Body, Controller, Delete, Get, HttpCode, HttpException, Inject, Param, Post, Patch, Query, Req } from '@nestjs/common'
import { GadongError, RequirePermission, withTransaction } from '@gadong/kernel'
import type { AuthenticatedRequest } from '@gadong/kernel'
import type { Pool } from 'pg'
import { EmployeeService } from './employee.service'
import type { CreateEmployeeInput, EmployeeListFilter, EmployeeProfile, EmployeeSummary } from './employee.service'
import { ChecklistService } from './checklist.service'
import type { TaskWithEscalation } from './checklist.service'
import { ConsentService } from './consent.service'
import type { ConsentDecisionInput } from './consent.service'
import { ProbationService } from './probation.service'
import type { ProbationDecisionInput, ProbationDecisionResult } from './probation.service'
import { ContractService } from './contract.service'
import type { GenerateContractInput, GeneratedContract } from './contract.service'
import { SelfServiceService } from './self-service.service'
import type { EmployeeStatus } from './employee.repository'
import type { ConsentRecordRow } from './consent.repository'
import { checklistTaskNotFound, employeeOutOfScope } from './onboarding-errors'

/** DI token for the `onboarding` schema's connection pool — the same `Symbol` token pattern every sibling controller (`svc-config`, `svc-docs`) established. */
export const DB_POOL = Symbol('DB_POOL')

/** Minimal shape every OIDC-authenticated request carries once `OidcMiddleware` runs — matches `svc-config`/`svc-docs`'s use of the same kernel type. Missing `actorRole` falls back to `'unknown'` for the audit trail rather than throwing — an audit entry with an imprecise role is far better than a 500 on every write. */
interface Req extends AuthenticatedRequest {
  actorRole?: string
}

interface TransitionBody {
  to: EmployeeStatus
  reason?: string
}

interface SensitiveReadQuery {
  fields?: string
  purpose?: string
}

interface CompleteTaskBody {
  ssoNumberPresent?: boolean
}

interface SelfServiceSubmitBody {
  submissionId: string
  patch: Partial<CreateEmployeeInput>
}

/**
 * The HTTP boundary for `/employees*` and `/self-service/:token`
 * (M1-ONBOARDING §3.1). `GET /health` is deliberately NOT here — it stays
 * on the pre-existing `HealthController` from the schema-only Phase 1
 * build (`health.controller.ts`), still the one `@Public()` route in this
 * service, now also registered in `AppModule` alongside this controller.
 * Every route on THIS controller declares exactly one permission via the
 * kernel's `@RequirePermission` — deny-by-default is structural in
 * `PermissionGuard`, not a convention this controller could opt out of by
 * omission (matching `svc-config`/`svc-docs`). No business logic here —
 * `EmployeeService`/`ChecklistService`/`ConsentService`/`ProbationService`/
 * `ContractService`/`SelfServiceService` own that.
 */
@Controller()
export class EmployeeController {
  constructor(
    private readonly employees: EmployeeService,
    private readonly checklist: ChecklistService,
    private readonly consents: ConsentService,
    private readonly probation: ProbationService,
    private readonly contracts: ContractService,
    private readonly selfService: SelfServiceService,
    @Inject(DB_POOL) private readonly pool: Pool,
  ) {}

  // --- M1-1: employee master record ---

  @Post('employees')
  @RequirePermission('employee.create')
  async create(@Body() body: CreateEmployeeInput, @Req() req: Req): Promise<{ id: string; empCode: string }> {
    return this.runFailClosed(async () => {
      const prepared = await this.employees.prepareCreate(body)
      return withTransaction(this.pool, (tx) => this.employees.commitCreate(tx, prepared, actorId(req), actorRole(req)))
    })
  }

  @Get('employees')
  @RequirePermission('employee.read')
  async list(@Req() req: Req, @Query('org_unit') orgUnit?: string, @Query('status') status?: EmployeeStatus): Promise<{ employees: EmployeeSummary[] }> {
    return this.runFailClosed(async () => {
      const filter: EmployeeListFilter = {}
      if (orgUnit !== undefined) filter.orgUnitId = orgUnit
      if (status !== undefined) filter.status = status
      return { employees: await this.employees.list(filter, this.requireUserId(req), this.requireScope(req)) }
    })
  }

  @Get('employees/:id')
  @RequirePermission('employee.read')
  async getOne(@Param('id') id: string, @Req() req: Req): Promise<EmployeeProfile> {
    return this.runFailClosed(() => this.employees.getProfile(id, this.requireUserId(req), this.requireScope(req)))
  }

  @Get('employees/:id/sensitive')
  @RequirePermission('employee.sensitive.read')
  async getSensitive(@Param('id') id: string, @Query() query: SensitiveReadQuery, @Req() req: Req): Promise<Record<string, string | null>> {
    return this.runFailClosed(async () => {
      const fields = (query.fields ?? '').split(',').map((f) => f.trim()).filter((f) => f.length > 0)
      const purpose = query.purpose ?? ''
      const values = await this.employees.prepareSensitiveRead(id, fields, purpose, this.requireUserId(req), this.requireScope(req))
      await withTransaction(this.pool, (tx) => this.employees.commitSensitiveReadAudit(tx, id, fields, purpose, actorId(req), actorRole(req)))
      return values
    })
  }

  @Patch('employees/:id')
  @RequirePermission('employee.update')
  async update(@Param('id') id: string, @Body() body: Partial<CreateEmployeeInput>, @Req() req: Req): Promise<{ id: string; empCode: string }> {
    return this.runFailClosed(async () => {
      const prepared = await this.employees.prepareUpdate(id, body)
      return withTransaction(this.pool, (tx) => this.employees.commitUpdate(tx, prepared, actorId(req), actorRole(req)))
    })
  }

  @Post('employees/:id/transition')
  @RequirePermission('employee.lifecycle')
  async transition(@Param('id') id: string, @Body() body: TransitionBody, @Req() req: Req): Promise<{ id: string; status: EmployeeStatus }> {
    return this.runFailClosed(() =>
      withTransaction(this.pool, (tx) => this.employees.transition(tx, id, body.to, body.reason, actorId(req), actorRole(req))),
    )
  }

  // --- M1-2: guided onboarding checklist ---

  @Get('employees/:id/checklist')
  @RequirePermission('onboarding.manage')
  async getChecklist(@Param('id') id: string): Promise<{ tasks: TaskWithEscalation[] }> {
    return this.runFailClosed(async () => ({ tasks: await this.checklist.listForEmployee(id) }))
  }

  @Post('checklist/tasks/:taskId/complete')
  @RequirePermission('onboarding.manage')
  async completeTask(@Param('taskId') taskId: string, @Body() body: CompleteTaskBody): Promise<{ id: string; status: string }> {
    return this.runFailClosed(async () => {
      // Only decrypts sso_number when the caller didn't already assert
      // presence — the common case (an ESS/HR console that already has the
      // employee loaded) supplies `ssoNumberPresent` directly and never
      // triggers this extra crypto round trip.
      let ssoNumberPresent = body.ssoNumberPresent
      if (ssoNumberPresent === undefined) {
        const task = await this.checklist.findTask(taskId)
        if (!task) throw checklistTaskNotFound(taskId)
        ssoNumberPresent = await this.employees.hasSsoNumber(task.employeeId)
      }
      return withTransaction(this.pool, (tx) => this.checklist.completeTask(tx, taskId, ssoNumberPresent!))
    })
  }

  // --- M1-3: PDPA consent capture ---

  @Post('employees/:id/consents')
  @RequirePermission('consent.self')
  async submitConsent(@Param('id') id: string, @Body() body: ConsentDecisionInput, @Req() req: Req): Promise<{ records: ConsentRecordRow[] }> {
    return this.runFailClosed(async () => {
      const prepared = await this.consents.prepareDecision(id, body)
      const records = await withTransaction(this.pool, (tx) => this.consents.commitDecision(tx, prepared, actorId(req), actorRole(req)))
      return { records }
    })
  }

  /** One-tap withdrawal (PDPA §4.4). `202 Accepted` per M1-ONBOARDING §3.1 row 10 — the template deletion SLA (attendance's face-template hard-delete) is asynchronous, so this response acknowledges the withdrawal rather than claiming the downstream deletion already completed. */
  @Delete('employees/:id/consents/biometric')
  @HttpCode(202)
  @RequirePermission('consent.self')
  async withdrawBiometricConsent(@Param('id') id: string, @Req() req: Req): Promise<{ record: ConsentRecordRow; slaDays: number }> {
    return this.runFailClosed(async () => {
      const prepared = await this.consents.prepareWithdraw(id)
      const record = await withTransaction(this.pool, (tx) => this.consents.commitWithdraw(tx, prepared, actorId(req), actorRole(req)))
      // PDPA-BIOMETRIC-COMPLIANCE.md §7: face template hard-delete default
      // SLA is 7 days — informational only here; the actual deletion is
      // svc-attendance's job on receiving `consent.withdrawn`.
      return { record, slaDays: 7 }
    })
  }

  // --- M1-4: contract generation ---

  @Post('employees/:id/contracts')
  @RequirePermission('document.generate')
  async generateContract(@Param('id') id: string, @Body() body: GenerateContractInput): Promise<GeneratedContract> {
    return this.runFailClosed(() => this.contracts.generate(id, body))
  }

  // --- M1-5: probation tracking ---

  @Post('employees/:id/probation/decision')
  @RequirePermission('onboarding.manage')
  async probationDecision(@Param('id') id: string, @Body() body: ProbationDecisionInput, @Req() req: Req): Promise<ProbationDecisionResult> {
    return this.runFailClosed(() => withTransaction(this.pool, (tx) => this.probation.decide(tx, id, body, actorId(req), actorRole(req))))
  }

  // --- self-service submission ---

  /**
   * `POST /self-service/:token`. Guarded by `employee.update` — `employee-
   * ess` (the self-service role, `svc-authz`'s `seed/roles.ts`) holds
   * exactly that permission, granted with `self` org-scope, so an
   * authenticated employee can only ever update their own record; `token`
   * (this build: the employee's own id — see `self-service.service.ts`'s
   * header on signed-link generation being out of scope) is trusted no
   * further than any other `:id` path param elsewhere on this controller.
   *
   * **That comment described the INTENT, not the code — until this fix.**
   * The row-scoping audit found nothing here actually checked `token`
   * against the caller's identity: an authenticated employee A holding
   * `employee.update` could submit `POST /self-service/{B's id}` and patch
   * B's record, because `PermissionGuard` only ever asked "does this
   * caller hold `employee.update`", never "on this employee". Same defect
   * shape as `GET /documents/:id` (roadmap "🔴 Open security gap"), found
   * in a route whose own comment already claimed the protection existed.
   * `scopeAllowsEmployee` is used directly against `req.userId`/`token`
   * rather than fetching the row first (unlike `getProfile`) — a
   * self-service submission has no org-unit-level concept at all (per the
   * comment above, this route's whole design is "self, never an org
   * subtree"), so there is nothing an org-unit lookup would add here that
   * a direct identity comparison does not already give for `'self'`/`'*'`
   * scope, and an array (org-subtree) scope is correctly refused
   * unconditionally — a manager-scoped grant of `employee.update` was
   * never meant to reach a signed self-service link.
   */
  @Post('self-service/:token')
  @RequirePermission('employee.update')
  async selfServiceSubmit(@Param('token') token: string, @Body() body: SelfServiceSubmitBody, @Req() req: Req): Promise<{ id: string; empCode: string } | { duplicate: true }> {
    return this.runFailClosed(async () => {
      const callerId = this.requireUserId(req)
      const scope = this.requireScope(req)
      const allowed = scope === '*' || (scope === 'self' ? callerId === token : false)
      if (!allowed) throw employeeOutOfScope(token)

      const result = await withTransaction(this.pool, (tx) =>
        this.selfService.submit(tx, body.submissionId, token, body.patch, actorId(req), actorRole(req)),
      )
      return result === 'duplicate' ? { duplicate: true } : result
    })
  }

  /** `PermissionGuard` already denied any request with no authenticated principal before any handler on this controller runs (no route here is `@Public()`) — this narrows the type, it does not add a new check. */
  private requireUserId(req: Req): string {
    if (!req.userId) throw new HttpException({ code: 'ONB-401', message_i18n_key: 'onboarding.error.unauthenticated', details: [] }, 401)
    return req.userId
  }

  /**
   * `PermissionGuard` sets `request.authzScope` on every ALLOWED decision
   * (kernel `guard.ts`) — reaching a handler that calls this at all means
   * the guard already granted the route's permission, so this is only
   * absent if a future refactor removed that assignment; fails closed
   * rather than silently treating a missing scope as `'*'`.
   */
  private requireScope(req: Req): NonNullable<Req['authzScope']> {
    if (req.authzScope === undefined) {
      throw new HttpException({ code: 'ONB-500', message_i18n_key: 'onboarding.error.scope_missing', details: [] }, 500)
    }
    return req.authzScope
  }

  /** The same translation `svc-config`/`svc-docs`'s controllers perform: a thrown `GadongError` becomes the `{code, message_i18n_key, details}` envelope at its declared HTTP status; anything else is a genuine bug and is left to propagate. */
  private async runFailClosed<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (err) {
      if (err instanceof GadongError) throw new HttpException(err.toEnvelope(), err.httpStatus)
      throw err
    }
  }
}

function actorId(req: Req): string {
  return req.userId ?? 'unknown'
}
function actorRole(req: Req): string {
  return req.actorRole ?? 'unknown'
}
