import { Controller, Get, Inject } from '@nestjs/common'
import { buildHealth } from '@gadong/kernel'
import type { HealthPayload } from '@gadong/kernel'
import type { Pool } from 'pg'

/** DI token for the `claims` schema's connection pool — the same `Symbol` token pattern `svc-config`'s/`svc-leave`'s `DB_POOL` established. `app.module.ts` binds it to a real `pg.Pool` via kernel's `createPool`. */
export const DB_POOL = Symbol('DB_POOL')
/** DI token for the reachability check against `svc-crypto` — Task 14 brief: `/health` reports `crypto` because `receipt.file_ref` (a MinIO pointer to a receipt photo/PDF that can incidentally contain medical information) is envelope-encrypted through it before write. */
export const CRYPTO_HEALTH = Symbol('CRYPTO_HEALTH')

/** A dependency this controller can ask "are you up" — the same shape `svc-leave`'s `HealthCheckPort` established, so `app.module.ts` can bind a real HTTP-backed implementation in production and tests can bind a trivial fake. */
export interface HealthCheckPort {
  check(): Promise<'up' | 'down'>
}

/**
 * The HTTP boundary for this service — today, ONLY `GET /health` (Task 14
 * brief: "Do NOT implement submission, approval banding, limit
 * enforcement or reimbursement routing. Phase 4 owns those"). No
 * `@RequirePermission`-guarded routes exist yet, so `app.module.ts`
 * deliberately does not mount the kernel's `PermissionGuard`/
 * `OidcMiddleware` either — wiring auth infrastructure for zero protected
 * routes would be dead code no test could justify. Phase 4 adds both
 * alongside its first real route, matching how `services/svc-config`/
 * `services/svc-leave` mount them.
 *
 * `/health` itself is exempt from auth everywhere in this codebase (every
 * other service's controller leaves it unguarded too), so that convention
 * needs no guard to hold here either.
 */
@Controller()
export class ClaimsController {
  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    @Inject(CRYPTO_HEALTH) private readonly cryptoHealth: HealthCheckPort,
  ) {}

  @Get('health')
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
}
