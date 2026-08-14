import { Body, Controller, Get, HttpException, Inject, Param, Post, Query, Req } from '@nestjs/common'
import { GadongError, Public, RequirePermission, buildHealth, outboxDepth, withTransaction } from '@gadong/kernel'
import type { AuthenticatedRequest, HealthPayload } from '@gadong/kernel'
import type { Pool } from 'pg'
import { RulesService } from './rules.service'
import type { ProposeRuleInput } from './rules.service'
import { PacksService } from './packs.service'
import type { SignedPack, PackImportResult } from './packs.service'
import type { StatutoryRuleRow } from './rules.repository'

/** DI token for the `config` schema's connection pool — the same `Symbol` token pattern `svc-crypto`'s `VAULT_PORT` established. `app.module.ts` binds it to a real `pg.Pool` via kernel's `createPool`. */
export const DB_POOL = Symbol('DB_POOL')

interface ApproveRuleBody {
  approvedBy: string
}

/**
 * The HTTP boundary for `/rules*`, `/packs/import` and `/health` (Task 7
 * brief §2). Every route but `/health` declares exactly one permission via
 * the kernel's `@RequirePermission` — deny-by-default is structural in
 * `PermissionGuard`, not a convention this controller could opt out of by
 * omission (unlike `svc-crypto`, which is deliberately exempt because it is
 * called service-to-service only; `svc-config` is reached by HR admins and
 * every other service, so it mounts the guard — see `app.module.ts`).
 *
 * No SQL, no governance logic here — `RulesService`/`PacksService` own
 * that (matching `services/svc-crypto`'s controller/service split). This
 * controller's only DB-shaped responsibility is opening the transaction
 * each write spans, via kernel's `withTransaction`, so a propose/approve/
 * import and its outbox row commit or roll back together.
 */
@Controller()
export class RulesController {
  constructor(
    private readonly rulesService: RulesService,
    private readonly packsService: PacksService,
    @Inject(DB_POOL) private readonly pool: Pool,
  ) {}

  @Get('rules/:key')
  @RequirePermission('config.rule.read')
  async getOne(@Param('key') key: string, @Query('on') on?: string): Promise<StatutoryRuleRow> {
    return this.runFailClosed(() => this.rulesService.getEffective(key, on))
  }

  @Get('rules')
  @RequirePermission('config.rule.read')
  async list(@Query('prefix') prefix?: string): Promise<{ rules: StatutoryRuleRow[] }> {
    const rows = await this.runFailClosed(() => this.rulesService.listCurrent(prefix ?? ''))
    return { rules: rows }
  }

  @Post('rules')
  @RequirePermission('config.rule.propose')
  async propose(@Req() req: AuthenticatedRequest, @Body() body: ProposeRuleInput): Promise<StatutoryRuleRow> {
    return this.runFailClosed(() =>
      withTransaction(this.pool, (tx) => this.rulesService.propose(tx, { ...body, proposedByRole: body.proposedByRole ?? actorRole(req) })),
    )
  }

  @Post('rules/:id/approve')
  @RequirePermission('config.rule.approve')
  async approve(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() body: ApproveRuleBody): Promise<StatutoryRuleRow> {
    return this.runFailClosed(() =>
      withTransaction(this.pool, (tx) => this.rulesService.approve(tx, id, body.approvedBy, actorRole(req))),
    )
  }

  @Post('packs/import')
  @RequirePermission('config.pack.import')
  async importPack(@Body() body: SignedPack): Promise<PackImportResult> {
    return this.runFailClosed(() => withTransaction(this.pool, (tx) => this.packsService.importPack(tx, body)))
  }

  @Get('health')
  @Public()
  async health(): Promise<HealthPayload> {
    const db = await this.checkDb()
    // "A stuck outbox must be observable" (event-bus task) — there is no
    // alerting anywhere in this system, so a `rules.updated` row the relay
    // has fallen behind on must surface here, the one place an operator
    // already looks. A failure reading the outbox itself (distinct from
    // `db` above, which only proves the pool can run `SELECT 1`) degrades
    // the response rather than being swallowed into a healthy-looking zero
    // — same fail-closed reasoning as every dependency check on this
    // endpoint.
    let outbox: { pending: number; oldestAgeSeconds: number | null } | undefined
    let outboxQuery: 'up' | 'down' = 'up'
    try {
      outbox = await outboxDepth(this.pool, 'config')
    } catch {
      outboxQuery = 'down'
    }
    return buildHealth('svc-config', { db, ...(outboxQuery === 'down' ? { outboxQuery } : {}) }, process.env, outbox)
  }

  private async checkDb(): Promise<'up' | 'down'> {
    try {
      await this.pool.query('SELECT 1')
      return 'up'
    } catch {
      return 'down'
    }
  }

  /**
   * The same translation `crypto.controller.ts` performs: a thrown
   * `GadongError` becomes the `{code, message_i18n_key, details}` envelope
   * at its declared HTTP status; anything else is a genuine bug and is
   * left to propagate.
   */
  private async runFailClosed<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (err) {
      if (err instanceof GadongError) throw new HttpException(err.toEnvelope(), err.httpStatus)
      throw err
    }
  }
}

/** Same fallback every other controller's own audit wiring uses (`svc-onboarding`, `svc-payroll`, `svc-docs`): an imprecise role beats a 500 on every audited governance action. */
function actorRole(req: AuthenticatedRequest): string {
  return req.actorRole ?? 'unknown'
}
