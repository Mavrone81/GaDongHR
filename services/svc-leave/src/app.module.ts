import 'reflect-metadata'
import { randomUUID } from 'node:crypto'
import { Module } from '@nestjs/common'
import type { MiddlewareConsumer, NestModule } from '@nestjs/common'
import { APP_FILTER, APP_GUARD } from '@nestjs/core'
import {
  AuthzClient,
  CryptoClient,
  GadongErrorFilter,
  MachineTokenClient,
  PermissionGuard,
  createAuthenticatedFetch,
  createHttpTokenTransport,
  createOidcMiddlewareHandler,
  createPool,
} from '@gadong/kernel'
import type { AuthenticatedFetch, AuthzTransport, CryptoTransport, OidcMiddlewareHandler, Queryable } from '@gadong/kernel'
import { ApprovalsRepository } from './approvals.repository'
import { ApprovalsService } from './approvals.service'
import { BalancesRepository } from './balances.repository'
import { BalancesService } from './balances.service'
import { CONFIG_HEALTH, CRYPTO_HEALTH, DB_POOL, LeaveController } from './leave.controller'
import type { HealthCheckPort } from './leave.controller'
import { EmployeeRefConsumer } from './employee-ref.consumer'
import { EmployeeRefRepository } from './employee-ref.repository'
import { EssBalancesService } from './ess-balances.service'
import { HttpConfigClient } from './config-client'
import type { ConfigClient } from './config-client'
import { LeaveTypesRepository } from './leave-types.repository'
import { LeaveTypesService } from './leave-types.service'
import { RequestsRepository } from './requests.repository'
import { RequestsService } from './requests.service'

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`svc-leave: ${name} is required`)
  return value
}

/** Same `fetch`-reachability shape every other service's health dependency check uses (`services/svc-attendance/src/app.module.ts`'s `createHttpHealthCheck`) — `/health` must never itself throw. */
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
 * crypto-auth task: `svc-crypto` now guards `/encrypt` with
 * `PermissionGuard` — svc-leave only ever WRITES a medical-certificate
 * pointer (`RequestsService`, `requests.service.ts`), never reads one back,
 * so it holds `crypto.encrypt` ONLY, never `crypto.decrypt`/`crypto.bidx`
 * (least privilege). Takes an `AuthenticatedFetch` instead of the bare
 * global `fetch` it used before.
 */
function createHttpCryptoTransport(baseUrl: string, fetchImpl: typeof fetch): CryptoTransport {
  return {
    async post(path, body) {
      const res = await fetchImpl(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const text = await res.text()
      return text.length > 0 ? (JSON.parse(text) as unknown) : {}
    },
  }
}

/**
 * crypto-auth task: this service's own machine identity for its one
 * outbound guarded call (svc-crypto). `S2S_CLIENT_ID`/`S2S_CLIENT_SECRET`
 * come from the `svc-leave` realm client
 * (`deploy/keycloak/realm-gadonghr.json`) — same pattern
 * `svc-onboarding`/`svc-payroll` established for the S2S auth task.
 */
function createMachineTokenClient(): MachineTokenClient {
  return new MachineTokenClient(createHttpTokenTransport(requiredEnv('OIDC_TOKEN_URL')), {
    clientId: requiredEnv('S2S_CLIENT_ID'),
    clientSecret: requiredEnv('S2S_CLIENT_SECRET'),
  })
}

/** Same fail-closed reasoning as `services/svc-config/src/app.module.ts`'s identical function: `svc-authz` treats an unreachable transport as a denial, which is the correct behaviour, not a placeholder. */
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

function createOidcMiddleware(): OidcMiddlewareHandler {
  return createOidcMiddlewareHandler({
    issuer: requiredEnv('OIDC_ISSUER'),
    audience: requiredEnv('OIDC_AUDIENCE'),
    jwksUri: requiredEnv('OIDC_JWKS_URI'),
  })
}

/**
 * `svc-leave` IS reached by employees, managers and HR admins — like
 * `svc-config` (and unlike `svc-crypto`, which is service-to-service only),
 * this module mounts the kernel's `PermissionGuard` as `APP_GUARD`: every
 * route not explicitly marked `@Public()` (only `GET /health` is) must
 * declare a permission or the guard denies it.
 *
 * Every business service this module wires reads statutory figures from
 * `svc-config` (`ConfigClient`) and writes health-data pointers through
 * `svc-crypto` (`CryptoClient`) — both real HTTP clients here, both fakes
 * in every test (Task brief CONSTRAINTS: "no Postgres here — test against a
 * fake").
 */
@Module({
  controllers: [LeaveController],
  providers: [
    { provide: APP_GUARD, useClass: PermissionGuard },
    { provide: APP_FILTER, useClass: GadongErrorFilter },
    {
      provide: AuthzClient,
      useFactory: () => new AuthzClient(createHttpAuthzTransport(process.env['AUTHZ_URL'] ?? 'http://svc-authz:3000')),
    },
    {
      provide: DB_POOL,
      // `createPool` pins `search_path` to `leave` (global-constraints:
      // "every service owns one schema").
      useFactory: () => createPool(requiredEnv('DATABASE_URL'), 'leave'),
    },
    {
      provide: CRYPTO_HEALTH,
      useFactory: () => createHttpHealthCheck(`${process.env['CRYPTO_URL'] ?? 'http://svc-crypto:3000'}/health`),
    },
    {
      provide: CONFIG_HEALTH,
      useFactory: () => createHttpHealthCheck(`${process.env['CONFIG_URL'] ?? 'http://svc-config:3000'}/health`),
    },
    {
      // crypto-auth task: one machine-token client, one authenticated-fetch
      // helper, for this service's one outbound guarded call (svc-crypto).
      provide: 'AUTHENTICATED_FETCH',
      useFactory: (): AuthenticatedFetch => createAuthenticatedFetch(createMachineTokenClient()),
    },
    {
      provide: CryptoClient,
      useFactory: (authedFetch: AuthenticatedFetch) =>
        new CryptoClient(createHttpCryptoTransport(process.env['CRYPTO_URL'] ?? 'http://svc-crypto:3000', authedFetch)),
      inject: ['AUTHENTICATED_FETCH'],
    },
    {
      provide: HttpConfigClient,
      useFactory: () => new HttpConfigClient(process.env['CONFIG_URL'] ?? 'http://svc-config:3000'),
    },
    // Bound to the interface, not the concrete class, so every consumer
    // below depends on `ConfigClient` (the seam tests substitute a fake
    // through) rather than the HTTP implementation directly.
    { provide: 'CONFIG_CLIENT', useExisting: HttpConfigClient },
    {
      provide: LeaveTypesRepository,
      useFactory: (pool: Queryable) => new LeaveTypesRepository(pool),
      inject: [DB_POOL],
    },
    {
      provide: LeaveTypesService,
      useFactory: (repo: LeaveTypesRepository, config: ConfigClient) => new LeaveTypesService(repo, config, () => randomUUID()),
      inject: [LeaveTypesRepository, 'CONFIG_CLIENT'],
    },
    {
      provide: BalancesRepository,
      useFactory: (pool: Queryable) => new BalancesRepository(pool),
      inject: [DB_POOL],
    },
    {
      provide: BalancesService,
      useFactory: (repo: BalancesRepository) => new BalancesService(repo, () => randomUUID()),
      inject: [BalancesRepository],
    },
    {
      provide: EssBalancesService,
      useFactory: (types: LeaveTypesRepository, balances: BalancesService) => new EssBalancesService(types, balances),
      inject: [LeaveTypesRepository, BalancesService],
    },
    {
      provide: RequestsRepository,
      useFactory: (pool: Queryable) => new RequestsRepository(pool),
      inject: [DB_POOL],
    },
    {
      provide: RequestsService,
      useFactory: (repo: RequestsRepository, types: LeaveTypesRepository, balances: BalancesService, crypto: CryptoClient, config: ConfigClient) =>
        new RequestsService(repo, types, balances, crypto, config, () => randomUUID()),
      inject: [RequestsRepository, LeaveTypesRepository, BalancesService, CryptoClient, 'CONFIG_CLIENT'],
    },
    {
      provide: ApprovalsRepository,
      useFactory: (pool: Queryable) => new ApprovalsRepository(pool),
      inject: [DB_POOL],
    },
    {
      provide: ApprovalsService,
      useFactory: (repo: ApprovalsRepository, requestsRepo: RequestsRepository, typesRepo: LeaveTypesRepository, balances: BalancesService) =>
        new ApprovalsService(repo, requestsRepo, typesRepo, balances, () => randomUUID()),
      inject: [ApprovalsRepository, RequestsRepository, LeaveTypesRepository, BalancesService],
    },
    {
      provide: EmployeeRefRepository,
      useFactory: (pool: Queryable) => new EmployeeRefRepository(pool),
      inject: [DB_POOL],
    },
    {
      provide: EmployeeRefConsumer,
      useFactory: (repo: EmployeeRefRepository, leaveTypes: LeaveTypesRepository, balances: BalancesService) =>
        new EmployeeRefConsumer(repo, leaveTypes, balances),
      inject: [EmployeeRefRepository, LeaveTypesRepository, BalancesService],
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(createOidcMiddleware()).forRoutes('*')
  }
}
