import 'reflect-metadata'
import { Module } from '@nestjs/common'
import type { MiddlewareConsumer, NestModule } from '@nestjs/common'
import { APP_FILTER, APP_GUARD } from '@nestjs/core'
import { AuthzClient, GadongErrorFilter, PermissionGuard, createOidcMiddlewareHandler, createPool } from '@gadong/kernel'
import type { OidcMiddlewareHandler } from '@gadong/kernel'
import type { AuthzTransport, Queryable } from '@gadong/kernel'
import { ConfigClient } from './config-client'
import type { ConfigTransport } from './config-client'
import { ConsolidationService } from './consolidation.service'
import { CorrectionAuditRepository } from './correction-audit.repository'
import { DayRecordRepository } from './day-record.repository'
import { EmployeeRefRepository } from './employee-ref.repository'
import { EventsConsumer } from './events.consumer'
import { ExceptionRepository } from './exception.repository'
import { ExceptionsService } from './exceptions.service'
import { LeaveRefRepository } from './leave-ref.repository'
import { OtApprovalRefRepository } from './ot-approval-ref.repository'
import { PeriodRepository } from './period.repository'
import { PeriodService } from './period.service'
import { RosterRefRepository } from './roster-ref.repository'
import { DB_POOL, TimesheetController } from './timesheet.controller'
import { ViewsService } from './views.service'

/**
 * `svc-authz` real HTTP wiring — identical shape to `services/svc-config`'s
 * and `services/svc-audit`'s `createHttpAuthzTransport`: `AuthzClient.decide`
 * treats an unreachable transport as a denial (kernel `authz/client.ts`).
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

/** `svc-config` HTTP wiring for `ConfigClient` — every statutory figure `OtClassifier`/`ConsolidationService` evaluates against comes from here at runtime (brief CONSTRAINTS: never hard-coded). */
function createHttpConfigTransport(baseUrl: string): ConfigTransport {
  return {
    async get(path) {
      const res = await fetch(`${baseUrl}${path}`)
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
 * for the full story.
 */
function createOidcMiddleware(): OidcMiddlewareHandler {
  return createOidcMiddlewareHandler({
    issuer: requiredEnv('OIDC_ISSUER'),
    audience: requiredEnv('OIDC_AUDIENCE'),
    jwksUri: requiredEnv('OIDC_JWKS_URI'),
  })
}

/**
 * `svc-timesheet` — the M3 junction service. Every route
 * M3-TIMESHEET.md's API manual defines is permission-scoped, so — like
 * `svc-config`/`svc-leave`/`svc-scheduler` — this module mounts the
 * kernel's `PermissionGuard` as `APP_GUARD`: deny-by-default for every
 * route not explicitly exempted (`GET /health` is the only one).
 *
 * `EventsConsumer` is a plain provider here — the actual subscription
 * (queue bind + dispatch loop) is wired in `main.ts`'s `wireEventBus`
 * (event-bus task), not here: `AppModule` only needs to construct the
 * dependency graph `main.ts` later pulls `EventsConsumer` out of via
 * `app.get()`.
 */
@Module({
  controllers: [TimesheetController],
  providers: [
    { provide: APP_GUARD, useClass: PermissionGuard },
    { provide: APP_FILTER, useClass: GadongErrorFilter },
    {
      provide: AuthzClient,
      useFactory: () => new AuthzClient(createHttpAuthzTransport(process.env['AUTHZ_URL'] ?? 'http://svc-authz:3000')),
    },
    {
      provide: ConfigClient,
      useFactory: () => new ConfigClient(createHttpConfigTransport(process.env['CONFIG_URL'] ?? 'http://svc-config:3000')),
    },
    {
      provide: DB_POOL,
      // `createPool` pins `search_path` to `timesheet` so every
      // unqualified table name resolves in this service's own schema and
      // nowhere else (roadmap "Database conventions").
      useFactory: () => createPool(requiredEnv('DATABASE_URL'), 'timesheet'),
    },
    { provide: DayRecordRepository, useFactory: (pool: Queryable) => new DayRecordRepository(pool), inject: [DB_POOL] },
    { provide: ExceptionRepository, useFactory: (pool: Queryable) => new ExceptionRepository(pool), inject: [DB_POOL] },
    { provide: PeriodRepository, useFactory: (pool: Queryable) => new PeriodRepository(pool), inject: [DB_POOL] },
    { provide: RosterRefRepository, useFactory: (pool: Queryable) => new RosterRefRepository(pool), inject: [DB_POOL] },
    { provide: LeaveRefRepository, useFactory: (pool: Queryable) => new LeaveRefRepository(pool), inject: [DB_POOL] },
    { provide: OtApprovalRefRepository, useFactory: (pool: Queryable) => new OtApprovalRefRepository(pool), inject: [DB_POOL] },
    { provide: EmployeeRefRepository, useFactory: (pool: Queryable) => new EmployeeRefRepository(pool), inject: [DB_POOL] },
    { provide: CorrectionAuditRepository, useFactory: (pool: Queryable) => new CorrectionAuditRepository(pool), inject: [DB_POOL] },
    {
      provide: ConsolidationService,
      useFactory: (
        dayRecords: DayRecordRepository,
        exceptions: ExceptionRepository,
        rosterRefs: RosterRefRepository,
        leaveRefs: LeaveRefRepository,
        otApprovalRefs: OtApprovalRefRepository,
        employeeRefs: EmployeeRefRepository,
        correctionAudits: CorrectionAuditRepository,
        configClient: ConfigClient,
      ) => new ConsolidationService(dayRecords, exceptions, rosterRefs, leaveRefs, otApprovalRefs, employeeRefs, correctionAudits, configClient),
      inject: [DayRecordRepository, ExceptionRepository, RosterRefRepository, LeaveRefRepository, OtApprovalRefRepository, EmployeeRefRepository, CorrectionAuditRepository, ConfigClient],
    },
    {
      provide: EventsConsumer,
      useFactory: (consolidation: ConsolidationService, employeeRefs: EmployeeRefRepository) => new EventsConsumer(consolidation, employeeRefs),
      inject: [ConsolidationService, EmployeeRefRepository],
    },
    {
      provide: ExceptionsService,
      useFactory: (
        exceptions: ExceptionRepository,
        dayRecords: DayRecordRepository,
        periods: PeriodRepository,
        correctionAudits: CorrectionAuditRepository,
        consolidation: ConsolidationService,
      ) => new ExceptionsService(exceptions, dayRecords, periods, correctionAudits, consolidation),
      inject: [ExceptionRepository, DayRecordRepository, PeriodRepository, CorrectionAuditRepository, ConsolidationService],
    },
    {
      provide: PeriodService,
      useFactory: (periods: PeriodRepository, exceptions: ExceptionRepository, dayRecords: DayRecordRepository) =>
        new PeriodService(periods, exceptions, dayRecords),
      inject: [PeriodRepository, ExceptionRepository, DayRecordRepository],
    },
    {
      provide: ViewsService,
      useFactory: (dayRecords: DayRecordRepository, employeeRefs: EmployeeRefRepository, exceptions: ExceptionRepository) =>
        new ViewsService(dayRecords, employeeRefs, exceptions),
      inject: [DayRecordRepository, EmployeeRefRepository, ExceptionRepository],
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(createOidcMiddleware()).forRoutes('*')
  }
}
