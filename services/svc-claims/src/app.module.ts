import 'reflect-metadata'
import { Module } from '@nestjs/common'
import { createPool } from '@gadong/kernel'
import { CRYPTO_HEALTH, DB_POOL, ClaimsController } from './claims.controller'
import type { HealthCheckPort } from './claims.controller'

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`svc-claims: ${name} is required`)
  return value
}

/**
 * A `HealthCheckPort` backed by a plain `fetch` reachability probe against
 * `url` — "is anyone answering", not a deep protocol check. Any thrown
 * error (DNS failure, connection refused, timeout) or non-2xx response
 * reports `down` rather than propagating, matching every other service's
 * `checkDb`/`checkSmtp`-style health checks (`/health` must never itself
 * throw and take the whole endpoint down). Same shape as
 * `services/svc-leave/src/app.module.ts`'s `createHttpHealthCheck`.
 */
function createHttpHealthCheck(url: string): HealthCheckPort {
  return {
    async check() {
      try {
        const res = await fetch(url)
        return res.ok ? 'up' : 'down'
      } catch {
        return 'down'
      }
    },
  }
}

/**
 * `AppModule` for Task 14: schema, migrations, and `GET /health` only — no
 * `PermissionGuard`/`OidcMiddleware` wiring (see `claims.controller.ts`
 * for why), no repository/service layer (there is no business logic yet
 * to back one). Phase 4 extends this module when claim submission,
 * approval-banding, limit-enforcement and reimbursement-routing endpoints
 * land.
 */
@Module({
  controllers: [ClaimsController],
  providers: [
    {
      provide: DB_POOL,
      // `createPool` pins `search_path` to `claims` so every unqualified
      // table name (and the fully-qualified `claims.*` names future
      // repositories will use) resolves in this service's own schema and
      // nowhere else (global-constraints: "every service owns one
      // schema").
      useFactory: () => createPool(requiredEnv('DATABASE_URL'), 'claims'),
    },
    {
      provide: CRYPTO_HEALTH,
      // `svc-crypto` is a real dependency of this service from day one
      // even before Phase 4's submission code lands: `receipt.file_ref`
      // (a MinIO pointer to uncontrolled user content that can
      // incidentally contain medical information) is envelope-encrypted
      // through it. No default hard-coded to a guessable production
      // hostname (carried-forward binding: fail closed) — `CRYPTO_URL`
      // matches every other service's env var name for the same
      // dependency.
      useFactory: () => createHttpHealthCheck(`${process.env['CRYPTO_URL'] ?? 'http://svc-crypto:3000'}/health`),
    },
  ],
})
export class AppModule {}
