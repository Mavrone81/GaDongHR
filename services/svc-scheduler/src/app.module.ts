import 'reflect-metadata'
import { Module } from '@nestjs/common'
import type { MiddlewareConsumer, NestModule } from '@nestjs/common'
import { APP_FILTER, APP_GUARD } from '@nestjs/core'
import { AuthzClient, GadongErrorFilter, PermissionGuard, createOidcMiddlewareHandler, createPool } from '@gadong/kernel'
import type { OidcMiddlewareHandler } from '@gadong/kernel'
import type { AuthzTransport, Queryable } from '@gadong/kernel'
import { ConfigClient } from './config-client'
import type { ConfigTransport } from './config-client'
import { EmployeeRefRepository } from './employee-ref.repository'
import { EventsService } from './events.service'
import { GuardrailPolicy } from './guardrail'
import { DB_POOL, HealthController } from './health.controller'
import { HolidaysController } from './holidays.controller'
import { HolidaysRepository } from './holidays.repository'
import { HolidaysService } from './holidays.service'
import { LeaveRefRepository } from './leave-ref.repository'
import { OtController } from './ot.controller'
import { OtRepository } from './ot.repository'
import { OtService } from './ot.service'
import { RosterController } from './roster.controller'
import { RosterRepository } from './roster.repository'
import { RosterService } from './roster.service'
import { ShiftsController } from './shifts.controller'
import { ShiftsRepository } from './shifts.repository'
import { ShiftsService } from './shifts.service'

/**
 * `svc-authz` HTTP wiring — identical shape and justification to
 * `services/svc-config/src/app.module.ts`'s `createHttpAuthzTransport`.
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

/**
 * `svc-config` HTTP wiring for `ConfigClient` — every statutory ceiling
 * `GuardrailPolicy`/`HolidaysService`/`OtService` evaluates against comes
 * from here at runtime (brief CONSTRAINTS: never hard-coded). An
 * unreachable `svc-config` is NOT failed closed the way `AuthzClient` is —
 * see `config-client.ts`'s header — it genuinely rejects, because there is
 * no safe placeholder ceiling to fall back to.
 */
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
  if (!value) throw new Error(`svc-scheduler: ${name} is required`)
  return value
}

/** Same wiring as `services/svc-config/src/app.module.ts`'s `createOidcMiddleware` — populates `request.userId` from a verified bearer token ahead of `PermissionGuard`. */
function createOidcMiddleware(): OidcMiddlewareHandler {
  return createOidcMiddlewareHandler({
    issuer: requiredEnv('OIDC_ISSUER'),
    audience: requiredEnv('OIDC_AUDIENCE'),
    jwksUri: requiredEnv('OIDC_JWKS_URI'),
  })
}

/**
 * `svc-scheduler` is reached by managers, employees (`/my/schedule`) and
 * HR admins alike — like `svc-config`/`svc-notify` and unlike `svc-crypto`
 * — so it mounts the kernel's `PermissionGuard` as `APP_GUARD`: every route
 * but `GET /health` must declare a permission or the guard denies it.
 * `RosterService`'s conflict detection and `HolidaysService`/`OtService`'s
 * statutory checks are pure application logic composed from
 * repository + `ConfigClient` — nothing here is wired to a real message
 * broker (no subscriber exists anywhere in this codebase yet; `EventsService`
 * is the same "ready for a future subscriber, tested directly today" shape
 * `services/svc-notify`'s `NotifyService` already established).
 */
@Module({
  controllers: [HealthController, ShiftsController, RosterController, OtController, HolidaysController],
  providers: [
    { provide: APP_GUARD, useClass: PermissionGuard },
    // Task 16e, defect 2: see `services/svc-attendance/src/app.module.ts`'s
    // identical comment — maps a thrown `GadongError` onto its declared HTTP
    // status/envelope from day one.
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
      // `createPool` pins `search_path` to `scheduler` so every unqualified
      // table name resolves in this service's own schema and nowhere else
      // (global-constraints: "every service owns one schema").
      useFactory: () => createPool(requiredEnv('DATABASE_URL'), 'scheduler'),
    },
    { provide: ShiftsRepository, useFactory: (pool: Queryable) => new ShiftsRepository(pool), inject: [DB_POOL] },
    { provide: RosterRepository, useFactory: (pool: Queryable) => new RosterRepository(pool), inject: [DB_POOL] },
    { provide: HolidaysRepository, useFactory: (pool: Queryable) => new HolidaysRepository(pool), inject: [DB_POOL] },
    { provide: OtRepository, useFactory: (pool: Queryable) => new OtRepository(pool), inject: [DB_POOL] },
    { provide: EmployeeRefRepository, useFactory: (pool: Queryable) => new EmployeeRefRepository(pool), inject: [DB_POOL] },
    { provide: LeaveRefRepository, useFactory: (pool: Queryable) => new LeaveRefRepository(pool), inject: [DB_POOL] },
    { provide: GuardrailPolicy, useFactory: (c: ConfigClient) => new GuardrailPolicy(c), inject: [ConfigClient] },
    { provide: ShiftsService, useFactory: (r: ShiftsRepository) => new ShiftsService(r), inject: [ShiftsRepository] },
    {
      provide: RosterService,
      useFactory: (roster: RosterRepository, shifts: ShiftsRepository, leave: LeaveRefRepository, guardrails: GuardrailPolicy) =>
        new RosterService(roster, shifts, leave, guardrails),
      inject: [RosterRepository, ShiftsRepository, LeaveRefRepository, GuardrailPolicy],
    },
    {
      provide: HolidaysService,
      useFactory: (r: HolidaysRepository, c: ConfigClient) => new HolidaysService(r, c),
      inject: [HolidaysRepository, ConfigClient],
    },
    {
      provide: OtService,
      useFactory: (r: OtRepository, c: ConfigClient) => new OtService(r, c),
      inject: [OtRepository, ConfigClient],
    },
    {
      provide: EventsService,
      useFactory: (e: EmployeeRefRepository, l: LeaveRefRepository) => new EventsService(e, l),
      inject: [EmployeeRefRepository, LeaveRefRepository],
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(createOidcMiddleware()).forRoutes('*')
  }
}
