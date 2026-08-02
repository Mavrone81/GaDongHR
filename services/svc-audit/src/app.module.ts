import 'reflect-metadata'
import { Module } from '@nestjs/common'
import type { MiddlewareConsumer, NestModule } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { AuthzClient, OidcMiddleware, PermissionGuard, createPool } from '@gadong/kernel'
import type { AuthzTransport, Queryable } from '@gadong/kernel'
import { DB_POOL, EntriesController } from './entries.controller'
import { EntriesService } from './entries.service'
import { EntriesRepository } from './entries.repository'

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
function createOidcMiddleware(): OidcMiddleware {
  return new OidcMiddleware({
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
 * events (`consumer.ts`, driven by a future message-bus adapter — none
 * exists anywhere in this repo yet, see task-9-report.md), it never
 * produces its own.
 */
@Module({
  controllers: [EntriesController],
  providers: [
    { provide: APP_GUARD, useClass: PermissionGuard },
    { provide: OidcMiddleware, useFactory: createOidcMiddleware },
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
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(OidcMiddleware).forRoutes('*')
  }
}
