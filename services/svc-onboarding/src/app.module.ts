import 'reflect-metadata'
import { Module } from '@nestjs/common'
import type { MiddlewareConsumer, NestModule } from '@nestjs/common'
import { APP_FILTER, APP_GUARD } from '@nestjs/core'
import { AuditEmitter, AuthzClient, CryptoClient, GadongErrorFilter, PermissionGuard, createOidcMiddlewareHandler, createPool } from '@gadong/kernel'
import type { OidcMiddlewareHandler } from '@gadong/kernel'
import type { AuthzTransport, CryptoTransport, Queryable } from '@gadong/kernel'
import { DB_POOL, EmployeeController } from './employee.controller'
import { CRYPTO_PROBE, HealthController } from './health.controller'
import type { CryptoProbe } from './health.controller'
import { EmployeeRepository } from './employee.repository'
import { EmployeeService } from './employee.service'
import { OnboardingTaskRepository } from './onboarding-task.repository'
import { ChecklistService } from './checklist.service'
import { ConsentRepository } from './consent.repository'
import { ConsentService } from './consent.service'
import { ProbationRepository } from './probation.repository'
import { ProbationService } from './probation.service'
import { ContractService } from './contract.service'
import { SelfServiceService } from './self-service.service'
import { createHttpConfigClient } from './config-client'
import { createHttpDocsClient } from './docs-client'

/** `svc-authz` HTTP transport — identical wiring to `services/svc-config`/`svc-docs`'s `app.module.ts`; an unreachable transport correctly fails closed (kernel `AuthzClient`). */
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

/** `svc-crypto` HTTP transport — the real implementation of kernel's `CryptoTransport` port, identical shape to `services/svc-docs/src/app.module.ts`'s. Every S2/S3 write/read in this service goes through this. */
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

/** Real HTTP implementation of `CryptoProbe` — unchanged from the Phase 1 (Task 14) skeleton's `app.module.ts`: a plain `GET /health` against `svc-crypto`, any failure is `down`, never thrown. */
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

/** Task 13c pattern (`svc-config`/`svc-docs`'s `createOidcMiddleware`): validates the bearer token and populates `request.userId`/`request.actorRole`, ahead of `PermissionGuard`. */
function createOidcMiddleware(): OidcMiddlewareHandler {
  return createOidcMiddlewareHandler({
    issuer: requiredEnv('OIDC_ISSUER'),
    audience: requiredEnv('OIDC_AUDIENCE'),
    jwksUri: requiredEnv('OIDC_JWKS_URI'),
  })
}

/**
 * Phase 2 (this task) supersedes the Task 14 skeleton's deliberately
 * guard-free `AppModule`: `/employees*`/`/self-service/:token` are reached
 * by HR admins, managers and employees themselves, so — matching every
 * business-logic sibling service (`svc-config`, `svc-docs`) — this mounts
 * the kernel's `PermissionGuard` as `APP_GUARD`. Every route not explicitly
 * exempted (only `GET /health` is, via `@Public()`) must declare a
 * permission or the guard denies it.
 */
@Module({
  controllers: [EmployeeController, HealthController],
  providers: [
    { provide: APP_GUARD, useClass: PermissionGuard },
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
      provide: CRYPTO_PROBE,
      useFactory: () => createHttpCryptoProbe(process.env['CRYPTO_URL'] ?? 'http://svc-crypto:3000'),
    },
    {
      provide: DB_POOL,
      // `createPool` pins `search_path` to `onboarding` so every unqualified
      // table name (and the fully-qualified `onboarding.*` names every
      // repository here actually uses) resolves in this service's own
      // schema and nowhere else (global-constraints: "every service owns
      // one schema").
      useFactory: () => createPool(requiredEnv('DATABASE_URL'), 'onboarding'),
    },
    { provide: EmployeeRepository, useFactory: (pool: Queryable) => new EmployeeRepository(pool), inject: [DB_POOL] },
    { provide: OnboardingTaskRepository, useFactory: (pool: Queryable) => new OnboardingTaskRepository(pool), inject: [DB_POOL] },
    { provide: ConsentRepository, useFactory: (pool: Queryable) => new ConsentRepository(pool), inject: [DB_POOL] },
    { provide: ProbationRepository, useFactory: (pool: Queryable) => new ProbationRepository(pool), inject: [DB_POOL] },
    { provide: AuditEmitter, useFactory: () => new AuditEmitter() },
    {
      provide: ChecklistService,
      useFactory: (taskRepo: OnboardingTaskRepository) =>
        new ChecklistService(taskRepo, createHttpConfigClient(process.env['CONFIG_URL'] ?? 'http://svc-config:3000')),
      inject: [OnboardingTaskRepository],
    },
    {
      provide: EmployeeService,
      useFactory: (repo: EmployeeRepository, crypto: CryptoClient, checklist: ChecklistService, probationRepo: ProbationRepository, audit: AuditEmitter) =>
        new EmployeeService(repo, crypto, checklist, probationRepo, audit),
      inject: [EmployeeRepository, CryptoClient, ChecklistService, ProbationRepository, AuditEmitter],
    },
    {
      provide: ConsentService,
      useFactory: (consentRepo: ConsentRepository, employeeRepo: EmployeeRepository, employeeService: EmployeeService, crypto: CryptoClient, audit: AuditEmitter) =>
        new ConsentService(consentRepo, employeeRepo, employeeService, crypto, audit),
      inject: [ConsentRepository, EmployeeRepository, EmployeeService, CryptoClient, AuditEmitter],
    },
    {
      provide: ProbationService,
      useFactory: (probationRepo: ProbationRepository, employeeRepo: EmployeeRepository, employeeService: EmployeeService, audit: AuditEmitter) =>
        new ProbationService(probationRepo, employeeRepo, employeeService, audit),
      inject: [ProbationRepository, EmployeeRepository, EmployeeService, AuditEmitter],
    },
    {
      provide: ContractService,
      useFactory: (employeeRepo: EmployeeRepository, crypto: CryptoClient) =>
        new ContractService(employeeRepo, crypto, createHttpDocsClient(process.env['DOCS_URL'] ?? 'http://svc-docs:3000')),
      inject: [EmployeeRepository, CryptoClient],
    },
    {
      provide: SelfServiceService,
      useFactory: (employeeService: EmployeeService) => new SelfServiceService(employeeService),
      inject: [EmployeeService],
    },
  ],
})
export class AppModule implements NestModule {
  // Functional middleware, not the `OidcMiddleware` class — see kernel
  // `authz/oidc.middleware.ts`'s `createOidcMiddlewareHandler` doc for why
  // `consumer.apply(OidcMiddleware)` fails with `UnknownDependenciesException`
  // (Task 16d incident, carried forward across every service).
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(createOidcMiddleware()).forRoutes('*')
  }
}
