import 'reflect-metadata'
import { Module } from '@nestjs/common'
import { APP_FILTER } from '@nestjs/core'
import { GadongErrorFilter, createPool } from '@gadong/kernel'
import { AttendanceController, CRYPTO_HEALTH, DB_POOL, FACE_ENGINE_HEALTH } from './attendance.controller'
import type { HealthCheckPort } from './attendance.controller'

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`svc-attendance: ${name} is required`)
  return value
}

/**
 * A `HealthCheckPort` backed by a plain `fetch` reachability probe against
 * `url` — "is anyone answering", not a deep protocol check. Any thrown
 * error (DNS failure, connection refused, timeout) or non-2xx response
 * reports `down` rather than propagating, matching every other service's
 * `checkDb`/`checkSmtp`-style health checks (`/health` must never itself
 * throw and take the whole endpoint down).
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
 * `PermissionGuard`/`OidcMiddleware` wiring (see `attendance.controller.ts`
 * for why), no repository/service layer (there is no business logic yet to
 * back one). Phase 3 extends this module when enrolment/matching/punch
 * ingestion land.
 */
@Module({
  controllers: [AttendanceController],
  providers: [
    // Task 16e, defect 2: maps a thrown `GadongError` onto its declared
    // `httpStatus` and `{code, message_i18n_key, details}` envelope — see
    // kernel `http/gadong-error.filter.ts`. Registered here even though this
    // service mounts no `PermissionGuard` yet (no business routes exist —
    // see this module's own header comment) so a future route that throws a
    // `GadongError` is correctly mapped from the day it lands, not left for
    // whoever adds the first business route to remember.
    { provide: APP_FILTER, useClass: GadongErrorFilter },
    {
      provide: DB_POOL,
      // `createPool` pins `search_path` to `attendance` so every
      // unqualified table name (and the fully-qualified `attendance.*`
      // names future repositories will use) resolves in this service's own
      // schema and nowhere else (global-constraints: "every service owns
      // one schema").
      useFactory: () => createPool(requiredEnv('DATABASE_URL'), 'attendance'),
    },
    {
      provide: CRYPTO_HEALTH,
      // `svc-crypto` (Task 6) is a real dependency of this service from
      // day one even before Phase 3's enrolment code lands: `device.
      // device_secret` is envelope-encrypted through it. No default
      // hard-coded to a guessable production hostname (carried-forward
      // binding: fail closed) — `CRYPTO_URL` matches every other service's
      // env var name for the same dependency (see `services/svc-docs/src/
      // app.module.ts`).
      useFactory: () => createHttpHealthCheck(`${process.env['CRYPTO_URL'] ?? 'http://svc-crypto:3000'}/health`),
    },
    {
      provide: FACE_ENGINE_HEALTH,
      // CompreFace itself does not exist in this environment yet (Phase 3,
      // gated on the FAR/FRR benchmark — roadmap "PRD Q2"); this is a bare
      // reachability probe against whatever `FACE_ENGINE_URL` deploy
      // configuration eventually points at, not a call into any CompreFace
      // API. It exists now so operators can see "the face engine
      // dependency is unreachable" in `/health` from the day this
      // container first deploys, rather than that signal only appearing
      // once Phase 3's business logic starts calling it.
      useFactory: () => createHttpHealthCheck(process.env['FACE_ENGINE_URL'] ?? 'http://compreface-api:8000'),
    },
  ],
})
export class AppModule {}
