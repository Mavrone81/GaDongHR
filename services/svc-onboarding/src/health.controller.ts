import { Controller, Get, Inject } from '@nestjs/common'
import { Public, buildHealth } from '@gadong/kernel'
import type { HealthPayload } from '@gadong/kernel'
import type { Pool } from 'pg'
import { DB_POOL } from './employee.controller'

/**
 * Phase 2 (this task): re-exported from `employee.controller.ts` rather
 * than declared as a second `Symbol` here — `AppModule` now wires ONE
 * `onboarding` connection pool for the whole service (`EmployeeController`
 * and this controller share it), not one pool per controller. Re-exported
 * (not just imported) so nothing outside this module needs to know the
 * token moved.
 */
export { DB_POOL }

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
 * The HTTP boundary for `GET /health` only. Phase 2 (this task) mounts
 * `PermissionGuard` globally for the first time in this service (see
 * `app.module.ts`) — deny-by-default is structural there, with no code
 * path from "unannotated" to "allowed" (kernel `authz/guard.ts`), so
 * `@Public()` on this handler is no longer optional the way the Task 14
 * skeleton's comment (superseded below) once had it: without it, this
 * service's own healthcheck would now be denied with `AUZ-403` by its own
 * guard — exactly the Task 16e defect class `app.module.boot.test.ts`
 * exists to catch, caught here for real during this task's own build
 * rather than discovered on a live droplet.
 */
@Controller()
export class HealthController {
  constructor(
    @Inject(DB_POOL) private readonly pool: Pool,
    @Inject(CRYPTO_PROBE) private readonly cryptoProbe: CryptoProbe,
  ) {}

  @Get('health')
  @Public()
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
