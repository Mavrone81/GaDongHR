import 'reflect-metadata'
import { Module } from '@nestjs/common'
import type { MiddlewareConsumer, NestModule } from '@nestjs/common'
import { APP_FILTER, APP_GUARD } from '@nestjs/core'
import { AuthzClient, GadongErrorFilter, PermissionGuard, createOidcMiddlewareHandler, createPool } from '@gadong/kernel'
import type { OidcMiddlewareHandler } from '@gadong/kernel'
import type { AuthzTransport, Queryable } from '@gadong/kernel'
import { DB_POOL, EntriesController } from './entries.controller'
import { EntriesService } from './entries.service'
import { EntriesRepository } from './entries.repository'
import { AuditConsumer } from './consumer'

/**
 * Real HTTP wiring for `svc-authz` (Task 8), matching `services/svc-config`'s
 * `app.module.ts` exactly: `AuthzClient.decide` treats an unreachable
 * transport as a denial (kernel `authz/client.ts`), the correct fail-closed
 * behaviour.
 */
function createHttpAuthzTransport(baseUrl: string): AuthzTransport {
  return {
    async post(path, body) {
      const res = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const text = await res.text()
      return text.length > 0 ? (JSON.parse(text) as unknown) : {}
    },
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`svc-audit: ${name} is required`)
  return value
}

/**
 * Task 13c: closes the gap where `PermissionGuard` reads `request.userId`
 * but nothing ever set it — see `services/svc-config/src/app.module.ts`'s
 * `createOidcMiddleware` comment for the full story; identical wiring here.
 */
function createOidcMiddleware(): OidcMiddlewareHandler {
  return createOidcMiddlewareHandler({
    issuer: requiredEnv('OIDC_ISSUER'),
    audience: requiredEnv('OIDC_AUDIENCE'),
    jwksUri: requiredEnv('OIDC_JWKS_URI'),
  })
}

/**
 * `svc-audit` is reached by HR admins, auditors, and the DPO console
 * (`audit.read`), so — like `svc-config` and unlike `svc-crypto` — it
 * mounts the kernel's `PermissionGuard` as `APP_GUARD`: every route not
 * explicitly exempted (only `GET /health`) must declare a permission or the
 * guard denies it.
 *
 * No `AuditEmitter`/outbox providers here: this service consumes `audit.*`
 * events (`consumer.ts`, wired onto the real bus by `main.ts`'s
 * `wireEventBus` via kernel's `startEventBus`, wildcard-bound to `audit.#`
 * — see that function's doc comment), it never produces its own. Only the
 * `AuditConsumer` provider itself lives here; the bus plumbing is
 * constructed in `main.ts`, not this module, matching every other
 * service's `app.module.ts`/`main.ts` split.
 */
@Module({
  controllers: [EntriesController],
  providers: [
    { provide: APP_GUARD, useClass: PermissionGuard },
    // Task 16e, defect 2: maps a thrown `GadongError` (most importantly the
    // ones `PermissionGuard` above throws directly, before any controller's
    // own `try`/`catch` ever runs) onto its declared `httpStatus` and
    // `{code, message_i18n_key, details}` envelope — see kernel
    // `http/gadong-error.filter.ts`. Global (`APP_FILTER`), not a per-route
    // `@UseFilters`, for the same reason `PermissionGuard` is global: a
    // route-scoped filter would never see an exception thrown by a
    // globally-mounted guard.
    { provide: APP_FILTER, useClass: GadongErrorFilter },
    {
      provide: AuthzClient,
      useFactory: () => new AuthzClient(createHttpAuthzTransport(process.env['AUTHZ_URL'] ?? 'http://svc-authz:3000')),
    },
    {
      provide: DB_POOL,
      // `createPool` pins `search_path` to `audit` so every unqualified
      // table name resolves in this service's own schema and nowhere else
      // (global-constraints: "every service owns one schema").
      useFactory: () => createPool(requiredEnv('DATABASE_URL'), 'audit'),
    },
    {
      provide: EntriesRepository,
      useFactory: (pool: Queryable) => new EntriesRepository(pool),
      inject: [DB_POOL],
    },
    {
      provide: EntriesService,
      useFactory: (repo: EntriesRepository) => new EntriesService(repo),
      inject: [EntriesRepository],
    },
    {
      provide: AuditConsumer,
      useFactory: (repo: EntriesRepository) => new AuditConsumer(repo),
      inject: [EntriesRepository],
    },
  ],
})
export class AppModule implements NestModule {
  // Functional middleware, not the `OidcMiddleware` class — see kernel
  // `authz/oidc.middleware.ts`'s `createOidcMiddlewareHandler` doc for why
  // `consumer.apply(OidcMiddleware)` fails with
  // `UnknownDependenciesException` (Task 16d incident).
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(createOidcMiddleware()).forRoutes('*')
  }
}
