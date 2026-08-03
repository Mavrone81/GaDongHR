import 'reflect-metadata'
import { Module } from '@nestjs/common'
import type { MiddlewareConsumer, NestModule } from '@nestjs/common'
import { AuthzClient, PermissionGuard, createOidcMiddlewareHandler, createPool } from '@gadong/kernel'
import type { OidcMiddlewareHandler } from '@gadong/kernel'
import type { AuthzTransport, Queryable } from '@gadong/kernel'
import { DB_POOL, AuthzController } from './authz.controller'
import { AuthzService } from './authz.service'
import { AuthzRepository } from './authz.repository'

/**
 * `svc-authz` is reached by BOTH other services (`POST /decide`,
 * service-to-service, unguardable — see `authz.controller.ts`) AND human HR
 * admins (`GET /roles`, the grant/revoke routes). That mix is why this
 * module does NOT follow either of the two guard-mounting patterns already
 * in this codebase:
 *
 *  - NOT `svc-config`'s `{ provide: APP_GUARD, useClass: PermissionGuard }`
 *    — that would guard `/decide` too, which is structurally circular
 *    (`/decide` cannot ask `/decide` whether it may be called).
 *  - NOT `svc-crypto`'s "no guard at all" — `GET /roles` and the grant
 *    routes genuinely need deny-by-default.
 *
 * Instead `PermissionGuard` is registered as an ordinary provider (not
 * `APP_GUARD`), and `AuthzController` applies `@UseGuards(PermissionGuard)`
 * per method on exactly the three admin routes. See
 * `authz.controller.test.ts`'s "AppModule does NOT mount PermissionGuard as
 * APP_GUARD" suite.
 *
 * `AuthzClient`'s transport points at this same service (`AUTHZ_URL`
 * defaulting to a loopback address) — `PermissionGuard`, guarding this
 * service's own admin routes, asks this same service's own `/decide`
 * handler over HTTP. A self-referential network hop, not recursion:
 * `AuthzController.decide()` never itself calls `AuthzClient.decide`.
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
  if (!value) throw new Error(`svc-authz: ${name} is required`)
  return value
}

/**
 * Task 13c: closes the gap where `PermissionGuard` reads `request.userId`
 * but nothing ever set it — see `services/svc-config/src/app.module.ts`'s
 * `createOidcMiddleware` comment for the full story. Applied here too,
 * ahead of the three `@UseGuards(PermissionGuard)` admin routes on
 * `AuthzController` — those need a populated `request.userId` exactly like
 * every other guarded route in this system. It also runs ahead of
 * `POST /decide` (deliberately unguarded — see the module doc below), which
 * is fine: this middleware never throws and `/decide`'s handler never reads
 * `request.userId`, so its presence there is a harmless no-op, not a guard.
 */
function createOidcMiddleware(): OidcMiddlewareHandler {
  return createOidcMiddlewareHandler({
    issuer: requiredEnv('OIDC_ISSUER'),
    audience: requiredEnv('OIDC_AUDIENCE'),
    jwksUri: requiredEnv('OIDC_JWKS_URI'),
  })
}

@Module({
  controllers: [AuthzController],
  providers: [
    PermissionGuard,
    {
      provide: AuthzClient,
      useFactory: () => new AuthzClient(createHttpAuthzTransport(process.env['AUTHZ_URL'] ?? 'http://127.0.0.1:3000')),
    },
    {
      provide: DB_POOL,
      // `createPool` pins `search_path` to `authz` so every unqualified
      // table name (and the fully-qualified `authz.*` names this
      // repository actually uses) resolves in this service's own schema
      // and nowhere else (global-constraints: "every service owns one
      // schema").
      useFactory: () => createPool(requiredEnv('DATABASE_URL'), 'authz'),
    },
    {
      provide: AuthzRepository,
      useFactory: (pool: Queryable) => new AuthzRepository(pool),
      inject: [DB_POOL],
    },
    {
      provide: AuthzService,
      useFactory: (repo: AuthzRepository) => new AuthzService(repo),
      inject: [AuthzRepository],
    },
  ],
})
export class AppModule implements NestModule {
  // `createOidcMiddleware()` returns a plain function ("functional
  // middleware" — see kernel `authz/oidc.middleware.ts`'s
  // `createOidcMiddlewareHandler` doc), never the `OidcMiddleware` class
  // itself: `consumer.apply(SomeClass)` makes Nest construct that class
  // through its own DI container using constructor reflection, which
  // ignores any `useFactory` provider registered under that token and
  // fails with `UnknownDependenciesException` for a constructor that takes
  // a plain runtime-config object (Task 16d incident).
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(createOidcMiddleware()).forRoutes('*')
  }
}
