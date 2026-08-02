import 'reflect-metadata'
import { Module } from '@nestjs/common'
import { createPool } from '@gadong/kernel'
import { DB_POOL, CRYPTO_PROBE, HealthController } from './health.controller'
import type { CryptoProbe } from './health.controller'

/**
 * Real HTTP implementation of `CryptoProbe`: a plain `GET /health` against
 * `svc-crypto`'s own `crypto.controller.ts` — any transport failure or
 * non-2xx response is `down`, never thrown, matching every dependency
 * check in this file's sibling services (`checkDb` below, and
 * `svc-config`/`svc-docs`'s identical `checkDb` methods).
 */
function createHttpCryptoProbe(baseUrl: string): CryptoProbe {
  return {
    async check() {
      try {
        const res = await fetch(`${baseUrl}/health`)
        return res.ok ? 'up' : 'down'
      } catch {
        return 'down'
      }
    },
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`svc-onboarding: ${name} is required`)
  return value
}

/**
 * Deliberately minimal compared to `svc-config`/`svc-docs`'s `AppModule`:
 * this task (Task 14 brief) is scoped to "the service exists, deploys,
 * and has a correct database shape" with exactly one route (`GET
 * /health`, which every sibling service's own `PermissionGuard` wiring
 * exempts anyway) — `PermissionGuard`/`OidcMiddleware`/`AuthzClient` guard
 * *other* routes, and there are none here yet. Wiring them in now would
 * only add three more `requiredEnv` calls (`OIDC_ISSUER`,
 * `OIDC_AUDIENCE`, `OIDC_JWKS_URI`) this container must have set just to
 * boot, for a guard that would have nothing to guard — and
 * `deploy/docker-compose.yml` does not define a `svc-onboarding` service
 * yet (its own header comment: "svc-onboarding..svc-payroll ... do not
 * exist yet"), so there is nowhere those envs would even be supplied from
 * today. Phase 2 — which adds the permissioned `/employees*` routes from
 * `docs/05-modules/M1-ONBOARDING.md` §3.1 — is the right place to add
 * this module's `APP_GUARD`/`OidcMiddleware`/`AuthzClient`/`CryptoClient`
 * wiring together with the compose entry, mirroring `svc-docs`'s
 * `app.module.ts` exactly at that point.
 */
@Module({
  controllers: [HealthController],
  providers: [
    {
      provide: DB_POOL,
      // `createPool` pins `search_path` to `onboarding` so every
      // unqualified table name (and the fully-qualified `onboarding.*`
      // names Phase 2's repositories will use) resolves in this service's
      // own schema and nowhere else (global-constraints: "every service
      // owns one schema").
      useFactory: () => createPool(requiredEnv('DATABASE_URL'), 'onboarding'),
    },
    {
      provide: CRYPTO_PROBE,
      useFactory: () => createHttpCryptoProbe(process.env['CRYPTO_URL'] ?? 'http://svc-crypto:3000'),
    },
  ],
})
export class AppModule {}
