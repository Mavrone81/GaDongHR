import 'reflect-metadata'
import { randomUUID } from 'node:crypto'
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
import type { AuthzTransport, CryptoTransport, OidcMiddlewareHandler, Queryable } from '@gadong/kernel'
import { CONFIG_HEALTH, CRYPTO_HEALTH, DB_POOL, PayrollController } from './payroll.controller'
import type { HealthCheckPort } from './payroll.controller'
import { HttpConfigClient } from './config-client'
import type { ConfigClient } from './config-client'
import { PayProfilesRepository } from './pay-profiles.repository'
import { PayProfilesService } from './pay-profiles.service'
import { PayInputsRepository } from './pay-inputs.repository'
import { PayslipsRepository } from './payslips.repository'
import { PayslipsService } from './payslips.service'
import { RefsRepository } from './refs.repository'
import { RunsRepository } from './runs.repository'
import { RunsService } from './runs.service'
import { ExportsRepository } from './exports.repository'
import { ExportsService } from './exports.service'
import { FinalPayService } from './final-pay.service'
import { EventConsumersService } from './event-consumers.service'
import { HttpDocsClient, HttpEmployeeDirectoryClient, HttpTimesheetClient } from './ports'
import type { DocsClient, EmployeeDirectoryClient, ExportRecorder, TimesheetClient } from './ports'

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`svc-payroll: ${name} is required`)
  return value
}

/** Same `fetch`-reachability shape every other service's health dependency check uses — `/health` must never itself throw. */
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

/** Fail-closed by construction: `svc-authz` treats an unreachable transport as a denial. */
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
 * Phase 5 wiring: the gross-to-net engine, the run lifecycle, payslips,
 * bank files and statutory exports. `PermissionGuard` is mounted as
 * `APP_GUARD`, so every route that is not explicitly `@Public()` must
 * declare a permission or be denied — deny-by-default is structural, not a
 * convention this controller has to remember.
 *
 * Five service-to-service clients, all real HTTP here and all fakes in
 * every test (there is no Postgres, no Vault and no broker in this
 * environment): `svc-config` (every statutory figure), `svc-crypto` (every
 * money column), `svc-timesheet` (locked hours), `svc-docs` (payslip PDFs)
 * and `svc-onboarding` (the names and national IDs a สปส.1-10 needs, which
 * this schema deliberately does not replicate).
 */
@Module({
  controllers: [PayrollController],
  providers: [
    { provide: APP_GUARD, useClass: PermissionGuard },
    { provide: APP_FILTER, useClass: GadongErrorFilter },
    {
      provide: AuthzClient,
      useFactory: () => new AuthzClient(createHttpAuthzTransport(process.env['AUTHZ_URL'] ?? 'http://svc-authz:3000')),
    },
    {
      provide: DB_POOL,
      // `createPool` pins `search_path` to `payroll` so every unqualified
      // table name resolves in this service's own schema and nowhere else.
      useFactory: () => createPool(requiredEnv('DATABASE_URL'), 'payroll'),
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
      provide: CryptoClient,
      useFactory: () => new CryptoClient(createHttpCryptoTransport(process.env['CRYPTO_URL'] ?? 'http://svc-crypto:3000')),
    },
    {
      provide: HttpConfigClient,
      useFactory: () => new HttpConfigClient(process.env['CONFIG_URL'] ?? 'http://svc-config:3000'),
    },
    // Bound to the interface so every consumer depends on the seam tests
    // substitute a fake through, not on the HTTP implementation.
    { provide: 'CONFIG_CLIENT', useExisting: HttpConfigClient },
    {
      provide: 'TIMESHEET_CLIENT',
      useFactory: () => new HttpTimesheetClient(process.env['TIMESHEET_URL'] ?? 'http://svc-timesheet:3000'),
    },
    {
      provide: 'DOCS_CLIENT',
      useFactory: () => new HttpDocsClient(process.env['DOCS_URL'] ?? 'http://svc-docs:3000'),
    },
    {
      provide: 'DIRECTORY_CLIENT',
      useFactory: () => new HttpEmployeeDirectoryClient(process.env['ONBOARDING_URL'] ?? 'http://svc-onboarding:3000'),
    },

    { provide: PayProfilesRepository, useFactory: (pool: Queryable) => new PayProfilesRepository(pool), inject: [DB_POOL] },
    { provide: RunsRepository, useFactory: (pool: Queryable) => new RunsRepository(pool), inject: [DB_POOL] },
    { provide: PayslipsRepository, useFactory: (pool: Queryable) => new PayslipsRepository(pool), inject: [DB_POOL] },
    { provide: PayInputsRepository, useFactory: (pool: Queryable) => new PayInputsRepository(pool), inject: [DB_POOL] },
    { provide: RefsRepository, useFactory: (pool: Queryable) => new RefsRepository(pool), inject: [DB_POOL] },
    { provide: ExportsRepository, useFactory: (pool: Queryable) => new ExportsRepository(pool), inject: [DB_POOL] },

    {
      provide: PayProfilesService,
      useFactory: (repo: PayProfilesRepository, refs: RefsRepository, crypto: CryptoClient, config: ConfigClient) =>
        new PayProfilesService(repo, refs, crypto, config, () => randomUUID()),
      inject: [PayProfilesRepository, RefsRepository, CryptoClient, 'CONFIG_CLIENT'],
    },
    {
      provide: PayslipsService,
      useFactory: (payslips: PayslipsRepository, runs: RunsRepository, crypto: CryptoClient) => new PayslipsService(payslips, runs, crypto),
      inject: [PayslipsRepository, RunsRepository, CryptoClient],
    },
    {
      provide: ExportsService,
      useFactory: (
        runs: RunsRepository,
        payslips: PayslipsRepository,
        profiles: PayProfilesRepository,
        profilesService: PayProfilesService,
        refs: RefsRepository,
        exportsRepo: ExportsRepository,
        directory: EmployeeDirectoryClient,
        config: ConfigClient,
        crypto: CryptoClient,
      ) => new ExportsService(runs, payslips, profiles, profilesService, refs, exportsRepo, directory, config, crypto, () => randomUUID()),
      inject: [
        RunsRepository,
        PayslipsRepository,
        PayProfilesRepository,
        PayProfilesService,
        RefsRepository,
        ExportsRepository,
        'DIRECTORY_CLIENT',
        'CONFIG_CLIENT',
        CryptoClient,
      ],
    },
    {
      provide: RunsService,
      useFactory: (
        runs: RunsRepository,
        profiles: PayProfilesRepository,
        profilesService: PayProfilesService,
        payslips: PayslipsRepository,
        payInputs: PayInputsRepository,
        refs: RefsRepository,
        config: ConfigClient,
        crypto: CryptoClient,
        timesheets: TimesheetClient,
        docs: DocsClient,
        recorder: ExportRecorder,
      ) =>
        new RunsService(
          runs,
          profiles,
          profilesService,
          payslips,
          payInputs,
          refs,
          config,
          crypto,
          timesheets,
          docs,
          recorder,
          () => randomUUID(),
          () => new Date().toISOString(),
        ),
      inject: [
        RunsRepository,
        PayProfilesRepository,
        PayProfilesService,
        PayslipsRepository,
        PayInputsRepository,
        RefsRepository,
        'CONFIG_CLIENT',
        CryptoClient,
        'TIMESHEET_CLIENT',
        'DOCS_CLIENT',
        ExportsService,
      ],
    },
    {
      provide: FinalPayService,
      useFactory: (
        refs: RefsRepository,
        profilesService: PayProfilesService,
        payInputs: PayInputsRepository,
        config: ConfigClient,
        crypto: CryptoClient,
      ) => new FinalPayService(refs, profilesService, payInputs, config, crypto, () => randomUUID()),
      inject: [RefsRepository, PayProfilesService, PayInputsRepository, 'CONFIG_CLIENT', CryptoClient],
    },
    {
      // Wired here rather than in the controller: `timesheet.locked`,
      // `leave.balance_payout`, `claim.approved_for_payroll` and
      // `employee.*` arrive over the broker, not over HTTP. The relay that
      // drives them is kernel infrastructure; this provider is what it
      // resolves.
      provide: EventConsumersService,
      useFactory: (refs: RefsRepository, payInputs: PayInputsRepository, config: ConfigClient, crypto: CryptoClient) =>
        new EventConsumersService(refs, payInputs, config, crypto, () => randomUUID()),
      inject: [RefsRepository, PayInputsRepository, 'CONFIG_CLIENT', CryptoClient],
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(createOidcMiddleware()).forRoutes('*')
  }
}
