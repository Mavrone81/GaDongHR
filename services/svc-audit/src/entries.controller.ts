import { Controller, Get, Inject, Query } from '@nestjs/common'
import { Public, RequirePermission, buildHealth } from '@gadong/kernel'
import type { HealthPayload } from '@gadong/kernel'
import type { Pool } from 'pg'
import { EntriesService } from './entries.service'
import type { ListEntriesResult } from './entries.service'
import type { VerifyResult } from './chain'

/** DI token for the `audit` schema's connection pool — the same `Symbol` token pattern `svc-config`'s `DB_POOL` and `svc-crypto`'s `VAULT_PORT` establish. `app.module.ts` binds it to a real `pg.Pool` via kernel's `createPool`. */
export const DB_POOL = Symbol('DB_POOL')

/**
 * The HTTP boundary for `/entries`, `/verify`, and `/health` (Task 9 brief
 * §"API"). There is deliberately no write route on this controller at all —
 * entries arrive only by consuming `audit.*` events (`consumer.ts`), never
 * over HTTP.
 *
 * Every route but `/health` declares `@RequirePermission('audit.read')` —
 * deny-by-default is structural in the kernel's `PermissionGuard`
 * (`app.module.ts` mounts it as `APP_GUARD`), not a convention this
 * controller could opt out of by omission.
 */
@Controller()
export class EntriesController {
  constructor(
    private readonly entriesService: EntriesService,
    @Inject(DB_POOL) private readonly pool: Pool,
  ) {}

  @Get('entries')
  @RequirePermission('audit.read')
  async list(
    @Query('entity') entity?: string,
    @Query('entityId') entityId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
  ): Promise<ListEntriesResult> {
    return this.entriesService.list({
      entity,
      entityId,
      from,
      to,
      page: page !== undefined ? Number(page) : undefined,
    })
  }

  @Get('verify')
  @RequirePermission('audit.read')
  async verify(): Promise<VerifyResult> {
    return this.entriesService.verify()
  }

  @Get('health')
  @Public()
  async health(): Promise<HealthPayload> {
    const db = await this.checkDb()
    return buildHealth('svc-audit', { db })
  }

  private async checkDb(): Promise<'up' | 'down'> {
    try {
      await this.pool.query('SELECT 1')
      return 'up'
    } catch {
      return 'down'
    }
  }
}
