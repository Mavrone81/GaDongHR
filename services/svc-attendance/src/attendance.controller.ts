import { Controller, Get, Inject } from '@nestjs/common'
import { buildHealth } from '@gadong/kernel'
import type { HealthPayload } from '@gadong/kernel'
import type { Pool } from 'pg'

/** DI token for the `attendance` schema's connection pool — the same `Symbol` token pattern `svc-config`'s `DB_POOL` established. `app.module.ts` binds it to a real `pg.Pool` via kernel's `createPool`. */
export const DB_POOL = Symbol('DB_POOL')
/** DI token for the reachability check against `svc-crypto` — Task 14 brief: `/health` reports `crypto` because `device.device_secret` (and every future S3/S2 field this service writes) is envelope-encrypted through it before write. */
export const CRYPTO_HEALTH = Symbol('CRYPTO_HEALTH')
/** DI token for the reachability check against the CompreFace container ("face engine") — Task 14 brief: `/health` reports `face_engine` even though no enrolment/matching code exists yet (that is Phase 3, gated on the CompreFace benchmark — roadmap "PRD Q2"), because the container itself is a dependency this service's operators need to see go down. */
export const FACE_ENGINE_HEALTH = Symbol('FACE_ENGINE_HEALTH')

/** A dependency this controller can ask "are you up" — the same shape `svc-notify`'s injected `EmailTransport.verify()` and `svc-docs`'s `ObjectStorage.health()` use, so `app.module.ts` can bind a real HTTP-backed implementation in production and tests can bind a trivial fake. */
export interface HealthCheckPort {
  check(): Promise<'up' | 'down'>
}

/**
 * The HTTP boundary for this service — today, ONLY `GET /health` (Task 14
 * brief: "Do NOT implement enrolment, matching, liveness or punch
 * ingestion. Phase 3 owns those"). No `@RequirePermission`-guarded routes
 * exist yet, so `app.module.ts` deliberately does not mount the kernel's
 * `PermissionGuard`/`OidcMiddleware` either — wiring auth infrastructure
 * for zero protected routes would be dead code no test could justify.
 * Phase 3 adds both alongside its first real route, matching how
 * `services/svc-config`/`services/svc-docs` mount them.
 *
 * `/health` itself is exempt from auth everywhere in this codebase (every
 * other service's controller leaves it unguarded too), so that convention
 * needs no guard to hold here either.
 */
@Controller()
export class AttendanceController {
  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    @Inject(CRYPTO_HEALTH) private readonly cryptoHealth: HealthCheckPort,
    @Inject(FACE_ENGINE_HEALTH) private readonly faceEngineHealth: HealthCheckPort,
  ) {}

  @Get('health')
  async health(): Promise<HealthPayload> {
    const db = await this.checkDb()
    const crypto = await this.cryptoHealth.check()
    const face_engine = await this.faceEngineHealth.check()
    return buildHealth('svc-attendance', { db, crypto, face_engine })
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
