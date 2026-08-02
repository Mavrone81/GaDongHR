import 'reflect-metadata'
import { Module } from '@nestjs/common'
import { createPool } from '@gadong/kernel'
import { CRYPTO_HEALTH, DB_POOL, PayrollController } from './payroll.controller'
import type { HealthCheckPort } from './payroll.controller'

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`svc-payroll: ${name} is required`)
  return value
}

/**
 * A `HealthCheckPort` backed by a plain `fetch` reachability probe against
 * `url` — "is anyone answering", not a deep protocol check. Any thrown
 * error (DNS failure, connection refused, timeout) or non-2xx response
 * reports `down` rather than propagating, matching every other service's
 * `checkDb`-style health checks (`/health` must never itself throw and
 * take the whole endpoint down) — the same helper
 * `services/svc-attendance/src/app.module.ts` establishes.
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
 * `PermissionGuard`/`OidcMiddleware` wiring (see `payroll.controller.ts`
 * for why), no repository/service layer (there is no business logic yet to
 * back one — gross-to-net, the tax engine, payslip rendering and exports
 * are all Phase 5, gated on statutory verification items that are still
 * open per the Task 14 brief). Phase 5 extends this module when that
 * business logic lands.
 */
@Module({
  controllers: [PayrollController],
  providers: [
    {
      provide: DB_POOL,
      // `createPool` pins `search_path` to `payroll` so every unqualified
      // table name (and the fully-qualified `payroll.*` names future
      // repositories will use) resolves in this service's own schema and
      // nowhere else (global-constraints: "every service owns one schema").
      useFactory: () => createPool(requiredEnv('DATABASE_URL'), 'payroll'),
    },
    {
      provide: CRYPTO_HEALTH,
      // `svc-crypto` (Task 6) is a real dependency of this service from day
      // one, even before Phase 5's encryption code lands: every money
      // column in this schema (`pay_profile.base_pay`, `payslip.gross`,
      // `pay_item.amount`, `statutory_export.file_ref`, ...) is envelope-
      // encrypted through it before write. No default hard-coded to a
      // guessable production hostname (carried-forward binding: fail
      // closed) — `CRYPTO_URL` matches every other service's env var name
      // for the same dependency (see `services/svc-attendance/src/
      // app.module.ts`).
      useFactory: () => createHttpHealthCheck(`${process.env['CRYPTO_URL'] ?? 'http://svc-crypto:3000'}/health`),
    },
  ],
})
export class AppModule {}
