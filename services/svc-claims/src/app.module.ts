import 'reflect-metadata'
import { Module } from '@nestjs/common'
import type { MiddlewareConsumer, NestModule } from '@nestjs/common'
import { APP_FILTER, APP_GUARD } from '@nestjs/core'
import {
  AuthzClient,
  CryptoClient,
  GadongErrorFilter,
  PermissionGuard,
  createOidcMiddlewareHandler,
  createPool,
} from '@gadong/kernel'
import type { OidcMiddlewareHandler } from '@gadong/kernel'
import type { AuthzTransport, CryptoTransport, Queryable } from '@gadong/kernel'
import { CRYPTO_HEALTH, DB_POOL, ClaimsController } from './claims.controller'
import type { HealthCheckPort } from './claims.controller'
import { ClaimTypesRepository } from './claim-types.repository'
import { ClaimTypesService } from './claim-types.service'
import { ApprovalBandsRepository } from './approval-bands.repository'
import { ApprovalBandsService } from './approval-bands.service'
import { ClaimsRepository } from './claims.repository'
import { ClaimsService } from './claims.service'
import { EmployeeRefRepository } from './employee-ref.repository'
import { EmployeeEventsService } from './employee-events.service'

/** `svc-authz` HTTP transport — identical wiring to `services/svc-config/src/app.module.ts`; see that file's comment for why an unreachable transport correctly fails closed (kernel `AuthzClient`) rather than needing a placeholder here. */
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

/** `svc-crypto` HTTP transport — the real implementation of kernel's `CryptoTransport` port, same shape `services/svc-docs/src/app.module.ts` uses. Every receipt `file_ref` (M6-2) is envelope-encrypted through this before write; `CryptoClient.encryptBatch` fails closed (`CRY-503`) on any transport rejection. */
function createHttpCryptoTransport(baseUrl: string): CryptoTransport {
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
  if (!value) throw new Error(`svc-claims: ${name} is required`)
  return value
}

/** Identical wiring/reasoning to `services/svc-config`'s `createOidcMiddleware` — populates `request.userId` from a verified bearer token, ahead of `PermissionGuard`. */
function createOidcMiddleware(): OidcMiddlewareHandler {
  return createOidcMiddlewareHandler({
    issuer: requiredEnv('OIDC_ISSUER'),
    audience: requiredEnv('OIDC_AUDIENCE'),
    jwksUri: requiredEnv('OIDC_JWKS_URI'),
  })
}

/** A `HealthCheckPort` backed by a plain `fetch` reachability probe — same shape `services/svc-leave`'s established. */
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
 * `AppModule` for Task 14 P0: claim types (M6-1), submission (M6-2),
 * banded approval (M6-3), reimbursement routing (M6-4), and budget/limit
 * enforcement (M6-5). Reached by employees (ESS submission), managers and
 * finance approvers, and HR admins (type/band config), so — matching
 * `services/svc-config`/`services/svc-docs` — this mounts the kernel's
 * `PermissionGuard` as `APP_GUARD`: every route not explicitly exempted
 * (only `GET /health` is) must declare a permission or the guard denies it.
 */
@Module({
  controllers: [ClaimsController],
  providers: [
    { provide: APP_GUARD, useClass: PermissionGuard },
    // Maps a thrown `GadongError` (most importantly the ones
    // `PermissionGuard` above throws directly) onto its declared HTTP
    // status/envelope — see kernel `http/gadong-error.filter.ts`. Global
    // (`APP_FILTER`), matching every other service in this codebase.
    { provide: APP_FILTER, useClass: GadongErrorFilter },
    {
      provide: AuthzClient,
      useFactory: () => new AuthzClient(createHttpAuthzTransport(process.env['AUTHZ_URL'] ?? 'http://svc-authz:3000')),
    },
    {
      provide: CryptoClient,
      useFactory: () => new CryptoClient(createHttpCryptoTransport(process.env['CRYPTO_URL'] ?? 'http://svc-crypto:3000')),
    },
    {
      provide: DB_POOL,
      // `createPool` pins `search_path` to `claims` so every unqualified
      // table name (and the fully-qualified `claims.*` names every
      // repository actually uses) resolves in this service's own schema
      // and nowhere else (global-constraints: "every service owns one
      // schema").
      useFactory: () => createPool(requiredEnv('DATABASE_URL'), 'claims'),
    },
    {
      provide: CRYPTO_HEALTH,
      useFactory: () => createHttpHealthCheck(`${process.env['CRYPTO_URL'] ?? 'http://svc-crypto:3000'}/health`),
    },
    {
      provide: ClaimTypesRepository,
      useFactory: (pool: Queryable) => new ClaimTypesRepository(pool),
      inject: [DB_POOL],
    },
    {
      provide: ClaimTypesService,
      useFactory: (repo: ClaimTypesRepository) => new ClaimTypesService(repo),
      inject: [ClaimTypesRepository],
    },
    {
      provide: ApprovalBandsRepository,
      useFactory: (pool: Queryable) => new ApprovalBandsRepository(pool),
      inject: [DB_POOL],
    },
    {
      provide: ApprovalBandsService,
      useFactory: (repo: ApprovalBandsRepository) => new ApprovalBandsService(repo),
      inject: [ApprovalBandsRepository],
    },
    {
      provide: ClaimsRepository,
      useFactory: (pool: Queryable) => new ClaimsRepository(pool),
      inject: [DB_POOL],
    },
    {
      provide: ClaimsService,
      useFactory: (repo: ClaimsRepository, claimTypesRepo: ClaimTypesRepository, bands: ApprovalBandsService, crypto: CryptoClient) =>
        new ClaimsService(repo, claimTypesRepo, bands, crypto),
      inject: [ClaimsRepository, ClaimTypesRepository, ApprovalBandsService, CryptoClient],
    },
    {
      provide: EmployeeRefRepository,
      useFactory: (pool: Queryable) => new EmployeeRefRepository(pool),
      inject: [DB_POOL],
    },
    // Consumes `employee.*` (roadmap event catalog) into
    // `claims_employee_ref` via kernel's `idempotent()` — see
    // `employee-events.service.ts`. Not yet wired to a live message-bus
    // subscriber: no service in this codebase has that wiring today (there
    // is no AMQP consumer runner in `@gadong/kernel` yet), so this is
    // provided for DI completeness and exercised directly by
    // `employee-events.service.test.ts`, matching how every other
    // not-yet-wired piece of this build stage is proven.
    {
      provide: EmployeeEventsService,
      useFactory: (repo: EmployeeRefRepository) => new EmployeeEventsService(repo),
      inject: [EmployeeRefRepository],
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(createOidcMiddleware()).forRoutes('*')
  }
}
