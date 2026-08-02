import { Controller, Get, Inject } from '@nestjs/common'
import { buildHealth } from '@gadong/kernel'
import type { HealthPayload, Queryable } from '@gadong/kernel'

/** DI token for the `scheduler` schema's connection pool — matches `services/svc-config`'s `DB_POOL` pattern. `app.module.ts` binds it to a real `pg.Pool` via kernel's `createPool`. */
export const DB_POOL = Symbol('DB_POOL')

/**
 * The HTTP boundary for `GET /health` — the only route this task builds
 * (Task 14 brief: schema, migrations, and health, not rostering/OT/holiday
 * business logic — that is Phase 3). Deliberately no `@RequirePermission`
 * and no `PermissionGuard` mounted in `AppModule`: `/health` is exempt from
 * the guard on every other service too (`services/svc-config`'s
 * `RulesController.health`), and there are no other routes here yet for the
 * guard to protect — Phase 3's controllers add it when they add routes.
 */
@Controller()
export class HealthController {
  constructor(@Inject(DB_POOL) private readonly pool: Queryable) {}

  @Get('health')
  async health(): Promise<HealthPayload> {
    const db = await this.checkDb()
    return buildHealth('svc-scheduler', { db })
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
