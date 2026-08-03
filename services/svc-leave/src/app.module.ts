import 'reflect-metadata'
import { Module } from '@nestjs/common'
import { APP_FILTER } from '@nestjs/core'
import { GadongErrorFilter, createPool } from '@gadong/kernel'
import { CRYPTO_HEALTH, DB_POOL, LeaveController } from './leave.controller'
import type { HealthCheckPort } from './leave.controller'

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`svc-leave: ${name} is required`)
  return value
}

/**
 * A `HealthCheckPort` backed by a plain `fetch` reachability probe against
 * `url` — "is anyone answering", not a deep protocol check. Any thrown
 * error (DNS failure, connection refused, timeout) or non-2xx response
 * reports `down` rather than propagating, matching every other service's
 * `checkDb`/`checkSmtp`-style health checks (`/health` must never itself
 * throw and take the whole endpoint down). Same shape as
 * `services/svc-attendance/src/app.module.ts`'s `createHttpHealthCheck`.
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
 * `PermissionGuard`/`OidcMiddleware` wiring (see `leave.controller.ts` for
 * why), no repository/service layer (there is no business logic yet to
 * back one). Phase 4 extends this module when leave-type/balance/request/
 * approval-chain endpoints land.
 */
@Module({
  controllers: [LeaveController],
  providers: [
    // Task 16e, defect 2: see `services/svc-attendance/src/app.module.ts`'s
    // identical comment — maps a thrown `GadongError` onto its declared HTTP
    // status/envelope from day one, ahead of this service's first business
    // route.
    { provide: APP_FILTER, useClass: GadongErrorFilter },
    {
      provide: DB_POOL,
      // `createPool` pins `search_path` to `leave` so every unqualified
      // table name (and the fully-qualified `leave.*` names future
      // repositories will use) resolves in this service's own schema and
      // nowhere else (global-constraints: "every service owns one
      // schema").
      useFactory: () => createPool(requiredEnv('DATABASE_URL'), 'leave'),
    },
    {
      provide: CRYPTO_HEALTH,
      // `svc-crypto` is a real dependency of this service from day one
      // even before Phase 4's request-submission code lands:
      // `leave_request.attachment_ref` (a medical-certificate pointer,
      // health data under PDPA s.26) is envelope-encrypted through it. No
      // default hard-coded to a guessable production hostname
      // (carried-forward binding: fail closed) — `CRYPTO_URL` matches
      // every other service's env var name for the same dependency.
      useFactory: () => createHttpHealthCheck(`${process.env['CRYPTO_URL'] ?? 'http://svc-crypto:3000'}/health`),
    },
  ],
})
export class AppModule {}
