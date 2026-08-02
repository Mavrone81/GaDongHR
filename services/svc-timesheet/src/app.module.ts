import 'reflect-metadata'
import { Module } from '@nestjs/common'
import type { MiddlewareConsumer, NestModule } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { AuthzClient, OidcMiddleware, PermissionGuard, createPool } from '@gadong/kernel'
import type { AuthzTransport } from '@gadong/kernel'
import { DB_POOL, TimesheetController } from './timesheet.controller'

/**
 * `svc-authz` real HTTP wiring — identical shape to `services/svc-config`'s
 * and `services/svc-audit`'s `createHttpAuthzTransport`: `AuthzClient.decide`
 * treats an unreachable transport as a denial (kernel `authz/client.ts`),
 * the correct fail-closed behaviour, not a placeholder needing revisiting
 * once `svc-authz` (Task 8) is live.
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
  if (!value) throw new Error(`svc-timesheet: ${name} is required`)
  return value
}

/**
 * `OidcMiddleware` populates `request.userId` from a verified bearer token's
 * `sub` claim, ahead of `PermissionGuard` reading it — see
 * `services/svc-config/src/app.module.ts`'s `createOidcMiddleware` comment
 * for the full story behind why this exists (Task 13c: a guard reading a
 * field nothing ever set makes every guarded route unreachable).
 */
function createOidcMiddleware(): OidcMiddleware {
  return new OidcMiddleware({
    issuer: requiredEnv('OIDC_ISSUER'),
    audience: requiredEnv('OIDC_AUDIENCE'),
    jwksUri: requiredEnv('OIDC_JWKS_URI'),
  })
}

/**
 * `svc-timesheet` is the M3 junction service — every route
 * M3-TIMESHEET.md's API manual defines (`timesheet.read`, `timesheet.correct`,
 * `timesheet.lock`, `timesheet.unlock`, …) is permission-scoped, so — like
 * `svc-config` and `svc-audit`, and unlike `svc-crypto` (service-to-service
 * only) or `svc-i18n` (must render before any principal exists) — this
 * module mounts the kernel's `PermissionGuard` as `APP_GUARD`: deny-by-
 * default for every route not explicitly exempted. Today `GET /health` is
 * the only route that exists (Task 14 brief scope — Phase 3 owns the rest),
 * so it is also the only one currently reachable, but the guard is wired
 * now rather than left for Phase 3 to add, matching this task's brief to
 * follow `svc-config`'s NestJS wiring exactly.
 */
@Module({
  controllers: [TimesheetController],
  providers: [
    { provide: APP_GUARD, useClass: PermissionGuard },
    { provide: OidcMiddleware, useFactory: createOidcMiddleware },
    {
      provide: AuthzClient,
      useFactory: () => new AuthzClient(createHttpAuthzTransport(process.env['AUTHZ_URL'] ?? 'http://svc-authz:3000')),
    },
    {
      provide: DB_POOL,
      // `createPool` pins `search_path` to `timesheet` so every
      // unqualified table name resolves in this service's own schema and
      // nowhere else (roadmap "Database conventions": "Each service's DB
      // role is granted only its own schema").
      useFactory: () => createPool(requiredEnv('DATABASE_URL'), 'timesheet'),
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(OidcMiddleware).forRoutes('*')
  }
}
