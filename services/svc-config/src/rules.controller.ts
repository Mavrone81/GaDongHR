import { Body, Controller, Get, HttpException, Inject, Param, Post, Query } from '@nestjs/common'
import { GadongError, RequirePermission, buildHealth, withTransaction } from '@gadong/kernel'
import type { HealthPayload } from '@gadong/kernel'
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
  async propose(@Body() body: ProposeRuleInput): Promise<StatutoryRuleRow> {
    return this.runFailClosed(() => withTransaction(this.pool, (tx) => this.rulesService.propose(tx, body)))
  }

  @Post('rules/:id/approve')
  @RequirePermission('config.rule.approve')
  async approve(@Param('id') id: string, @Body() body: ApproveRuleBody): Promise<StatutoryRuleRow> {
    return this.runFailClosed(() =>
      withTransaction(this.pool, (tx) => this.rulesService.approve(tx, id, body.approvedBy)),
    )
  }

  @Post('packs/import')
  @RequirePermission('config.pack.import')
  async importPack(@Body() body: SignedPack): Promise<PackImportResult> {
    return this.runFailClosed(() => withTransaction(this.pool, (tx) => this.packsService.importPack(tx, body)))
  }

  @Get('health')
  async health(): Promise<HealthPayload> {
    const db = await this.checkDb()
    return buildHealth('svc-config', { db })
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
