import { Controller, Get, Inject } from '@nestjs/common'
import { buildHealth } from '@gadong/kernel'
import type { HealthPayload } from '@gadong/kernel'
import type { Pool } from 'pg'

/** DI token for the `onboarding` schema's connection pool — the same `Symbol` token pattern `svc-config`'s `DB_POOL` established. `app.module.ts` binds it to a real `pg.Pool` via kernel's `createPool`. */
export const DB_POOL = Symbol('DB_POOL')

/** DI token for the crypto reachability probe. Injectable (rather than this controller calling `fetch` directly) so `health.controller.test.ts` can prove `ok`/`degraded` without touching the network — the same reason kernel's `OidcMiddleware` takes an injectable `JwksFetcher` instead of calling `fetch` inline. */
export const CRYPTO_PROBE = Symbol('CRYPTO_PROBE')

/**
 * Reachability check against `svc-crypto`, distinct from kernel's
 * `CryptoClient` (which speaks `POST /encrypt|/decrypt|/bidx` — the actual
 * envelope-encryption calls Phase 2's write path will make). `/health`
 * only needs "is svc-crypto answering at all", not a real crypto
 * operation, so this is its own small port rather than a misuse of
 * `CryptoClient` for something it was never built to answer.
 */
export interface CryptoProbe {
  check(): Promise<'up' | 'down'>
}

/**
 * The HTTP boundary for `GET /health` only (Task 14 brief: "Business
 * logic comes in Phase 2 ... Do NOT implement business endpoints"). No
 * `@RequirePermission` here, matching every other service's `/health` —
 * it is the one route every service's `PermissionGuard` wiring explicitly
 * exempts (`svc-config`, `svc-docs`) — and this service does not yet mount
 * that guard at all (see `app.module.ts`'s header comment for why that is
 * deliberate for this task, not an oversight).
 */
@Controller()
export class HealthController {
  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    @Inject(CRYPTO_PROBE) private readonly cryptoProbe: CryptoProbe,
  ) {}

  @Get('health')
  async health(): Promise<HealthPayload> {
    const db = await this.checkDb()
    const crypto = await this.cryptoProbe.check()
    return buildHealth('svc-onboarding', { db, crypto })
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
