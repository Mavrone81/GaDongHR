import { Controller, Get, Inject } from '@nestjs/common'
import { buildHealth } from '@gadong/kernel'
import type { HealthPayload } from '@gadong/kernel'
import type { Pool } from 'pg'

/** DI token for the `timesheet` schema's connection pool — the same `Symbol` token pattern `svc-config`'s `DB_POOL` and `svc-audit`'s `DB_POOL` establish. `app.module.ts` binds it to a real `pg.Pool` via kernel's `createPool`. */
export const DB_POOL = Symbol('DB_POOL')

/**
 * The HTTP boundary for `svc-timesheet` (Task 14 brief). Today this
 * controller exposes only `GET /health` — day-record consolidation, OT
 * classification, exception workflow and period lock/unlock (M3-TIMESHEET.md
 * API #1-11) are explicitly Phase 3's job, not this task's. This controller,
 * `app.module.ts`'s `PermissionGuard`/`OidcMiddleware` wiring, and the
 * `DB_POOL` token exist now so Phase 3 adds routes to an already-correct
 * skeleton instead of rewiring it — mirroring `services/svc-config`'s
 * `RulesController` and `services/svc-audit`'s `EntriesController`, where
 * `/health` is likewise the one route with no `@RequirePermission`.
 */
@Controller()
export class TimesheetController {
  constructor(@Inject(DB_POOL) private readonly pool: Pool) {}

  @Get('health')
  async health(): Promise<HealthPayload> {
    const db = await this.checkDb()
    return buildHealth('svc-timesheet', { db })
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
