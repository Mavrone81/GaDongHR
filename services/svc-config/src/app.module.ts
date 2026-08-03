import 'reflect-metadata'
import { Module } from '@nestjs/common'
import type { MiddlewareConsumer, NestModule } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { AuthzClient, PermissionGuard, createOidcMiddlewareHandler, createPool } from '@gadong/kernel'
import type { OidcMiddlewareHandler } from '@gadong/kernel'
import type { AuthzTransport, Queryable } from '@gadong/kernel'
import { DB_POOL, RulesController } from './rules.controller'
import { RulesService } from './rules.service'
import { RulesRepository } from './rules.repository'
import { PacksService } from './packs.service'

/**
 * `svc-authz` is Task 8, not yet built — this transport is real HTTP
 * wiring for when it exists. Until then `AuthzClient.decide` treats an
 * unreachable transport as a denial (kernel `authz/client.ts`), which is
 * the correct fail-closed behaviour, not a placeholder that needs revisiting.
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
  if (!value) throw new Error(`svc-config: ${name} is required`)
  return value
}

/**
 * Task 13c: `PermissionGuard` reads `request.userId` but nothing ever set
 * it — every guarded route was unreachable (`AUZ-403` on every request,
 * found via `seed.sh`'s pack import in Task 13). `OidcMiddleware` (kernel
 * `authz/oidc.middleware.ts`) is the fix: it validates the bearer token
 * against Keycloak's real JWKS and populates `request.userId` from `sub`
 * only on a fully verified token — never on a merely decoded one. `OIDC_*`
 * come from config, matching `AUTHZ_URL`/`DATABASE_URL` below, never
 * hard-coded.
 */
function createOidcMiddleware(): OidcMiddlewareHandler {
  return createOidcMiddlewareHandler({
    issuer: requiredEnv('OIDC_ISSUER'),
    audience: requiredEnv('OIDC_AUDIENCE'),
    jwksUri: requiredEnv('OIDC_JWKS_URI'),
  })
}

/**
 * Unlike `svc-crypto` (deliberately no `PermissionGuard` — service-to-
 * service only), `svc-config` IS reached by HR admins and every other
 * service asking "what's the rule", so it mounts the kernel's
 * `PermissionGuard` as `APP_GUARD`: every route not explicitly exempted
 * (only `GET /health` is) must declare a permission or the guard denies it
 * (Task 7 brief §2; carried-forward binding, "a route without one must be
 * denied — that is already structural in the guard").
 */
@Module({
  controllers: [RulesController],
  providers: [
    { provide: APP_GUARD, useClass: PermissionGuard },
    {
      provide: AuthzClient,
      useFactory: () => new AuthzClient(createHttpAuthzTransport(process.env['AUTHZ_URL'] ?? 'http://svc-authz:3000')),
    },
    {
      provide: DB_POOL,
      // `createPool` pins `search_path` to `config` so every unqualified
      // table name (and the fully-qualified `config.*` names this
      // repository actually uses) resolves in this service's own schema
      // and nowhere else (global-constraints: "every service owns one
      // schema").
      useFactory: () => createPool(requiredEnv('DATABASE_URL'), 'config'),
    },
    {
      provide: RulesRepository,
      useFactory: (pool: Queryable) => new RulesRepository(pool),
      inject: [DB_POOL],
    },
    {
      provide: RulesService,
      useFactory: (repo: RulesRepository) => new RulesService(repo),
      inject: [RulesRepository],
    },
    {
      provide: PacksService,
      // Never a hard-coded default (carried-forward binding: fail closed,
      // no secret hard-coded in production code) — see task-7-report.md
      // for the dev key the shipped seed packs are signed with.
      useFactory: (repo: RulesRepository) => new PacksService(repo, requiredEnv('CONFIG_PACK_SIGNING_KEY')),
      inject: [RulesRepository],
    },
  ],
})
export class AppModule implements NestModule {
  // Nest runs middleware ahead of guards for every matched route, so this
  // ordering — `OidcMiddleware` populates `request.userId`, then
  // `PermissionGuard` (registered above as `APP_GUARD`) reads it — is
  // automatic; there is no separate "run before the guard" wiring needed.
  //
  // `createOidcMiddleware()` returns functional middleware (a plain
  // function), not the `OidcMiddleware` class — see kernel
  // `authz/oidc.middleware.ts`'s `createOidcMiddlewareHandler` doc for why
  // `consumer.apply(OidcMiddleware)` fails with
  // `UnknownDependenciesException` (Task 16d incident).
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(createOidcMiddleware()).forRoutes('*')
  }
}
