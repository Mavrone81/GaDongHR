import { Controller, Get, Inject } from '@nestjs/common'
import { Public, buildHealth, outboxDepth } from '@gadong/kernel'
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
    // "A stuck outbox must be observable" (event-bus task) — a
    // `attendance.punch`/`attendance.liveness_failed` row the relay has
    // fallen behind on must surface here, the one place an operator already
    // looks. A failure reading the outbox itself (distinct from `db` above,
    // which only proves the pool can run `SELECT 1`) degrades the response
    // rather than being swallowed into a healthy-looking zero — same
    // fail-closed reasoning as every dependency check on this endpoint.
    let outbox: { pending: number; oldestAgeSeconds: number | null } | undefined
    let outboxQuery: 'up' | 'down' = 'up'
    try {
      outbox = await outboxDepth(this.pool, 'attendance')
    } catch {
      outboxQuery = 'down'
    }
    return buildHealth('svc-attendance', { db, crypto, face_engine, ...(outboxQuery === 'down' ? { outboxQuery } : {}) }, process.env, outbox)
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
