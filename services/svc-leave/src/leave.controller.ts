import { Controller, Get, Inject } from '@nestjs/common'
import { buildHealth } from '@gadong/kernel'
import type { HealthPayload } from '@gadong/kernel'
import type { Pool } from 'pg'

/** DI token for the `leave` schema's connection pool — the same `Symbol` token pattern `svc-config`'s/`svc-attendance`'s `DB_POOL` established. `app.module.ts` binds it to a real `pg.Pool` via kernel's `createPool`. */
export const DB_POOL = Symbol('DB_POOL')
/** DI token for the reachability check against `svc-crypto` — Task 14 brief: `/health` reports `crypto` because `leave_request.attachment_ref` (a medical-certificate pointer, health data under PDPA s.26) is envelope-encrypted through it before write. */
export const CRYPTO_HEALTH = Symbol('CRYPTO_HEALTH')

/** A dependency this controller can ask "are you up" — the same shape `svc-attendance`'s `HealthCheckPort` established, so `app.module.ts` can bind a real HTTP-backed implementation in production and tests can bind a trivial fake. */
export interface HealthCheckPort {
  check(): Promise<'up' | 'down'>
}

/**
 * The HTTP boundary for this service — today, ONLY `GET /health` (Task 14
 * brief: "Do NOT implement accrual, balance calculation, approval chains
 * or carry-over. Phase 4 owns those"). No `@RequirePermission`-guarded
 * routes exist yet, so `app.module.ts` deliberately does not mount the
 * kernel's `PermissionGuard`/`OidcMiddleware` either — wiring auth
 * infrastructure for zero protected routes would be dead code no test
 * could justify. Phase 4 adds both alongside its first real route,
 * matching how `services/svc-config`/`services/svc-docs` mount them.
 *
 * `/health` itself is exempt from auth everywhere in this codebase (every
 * other service's controller leaves it unguarded too), so that convention
 * needs no guard to hold here either.
 */
@Controller()
export class LeaveController {
  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    @Inject(CRYPTO_HEALTH) private readonly cryptoHealth: HealthCheckPort,
  ) {}

  @Get('health')
  async health(): Promise<HealthPayload> {
    const db = await this.checkDb()
    const crypto = await this.cryptoHealth.check()
    return buildHealth('svc-leave', { db, crypto })
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
