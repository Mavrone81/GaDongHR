import { Controller, Get, Inject } from '@nestjs/common'
import { Public, buildHealth } from '@gadong/kernel'
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
 * `GET /health` — this service's only unauthenticated route.
 *
 * The `@Public()` below is what let `svc-attendance` converge on the
 * standard guard mounting (2026-08-04). M4 avoided adding it, and mounted
 * `PermissionGuard` per-controller instead, so that this route could stay
 * exactly as unguarded as the Task 14 skeleton left it. The cost of that
 * choice was that a controller added to this service later would ship with
 * no permission check and nothing would fail — the one failure mode
 * per-controller mounting has and global mounting does not.
 *
 * `@Public()` is not a weaker exemption than being unguarded: it is a
 * stronger one, because it is checked. `public-routes.audit.test.ts` holds
 * a reviewed list of every `@Public()` route in the system and fails if
 * this set changes without that list changing, and each entry must also
 * carry an exemption with a reason in `web/ui-coverage.json`.
 */
@Controller()
export class AttendanceController {
  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    @Inject(CRYPTO_HEALTH) private readonly cryptoHealth: HealthCheckPort,
    @Inject(FACE_ENGINE_HEALTH) private readonly faceEngineHealth: HealthCheckPort,
  ) {}

  @Get('health')
  @Public()
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
