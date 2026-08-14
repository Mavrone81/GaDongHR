import 'reflect-metadata'
import { Module } from '@nestjs/common'
import type { MiddlewareConsumer, NestModule } from '@nestjs/common'
import { APP_FILTER, APP_GUARD } from '@nestjs/core'
import {
  AuditEmitter,
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
import type { OidcMiddlewareHandler } from '@gadong/kernel'
import type { AuthenticatedFetch, AuthzTransport, CryptoTransport, Queryable } from '@gadong/kernel'
import { AttendanceController, CRYPTO_HEALTH, DB_POOL, FACE_ENGINE_HEALTH } from './attendance.controller'
import type { HealthCheckPort } from './attendance.controller'
import { EnrolmentController } from './enrolment.controller'
import { PunchController } from './punch.controller'
import { DeviceController } from './device.controller'
import { SecurityController } from './security.controller'
import { ConsentStateRepository } from './consent-state.repository'
import { EnrolmentRepository } from './enrolment.repository'
import { AlternativeCredentialRepository } from './alternative-credential.repository'
import { DeviceRepository } from './device.repository'
import { PunchRepository } from './punch.repository'
import { SecurityEventRepository } from './security-event.repository'
import { EnrolmentService } from './enrolment.service'
import { DeviceService } from './device.service'
import { PunchService } from './punch.service'
import { TemplateDeletionService } from './template-deletion.service'
import { ConsentEventHandler } from './consent-event.handler'
import { EmployeeEventHandler } from './employee-event.handler'
import { DeviceAuthGuard } from './device-auth.guard'
import type { FaceEngineAdapter } from './face-engine.adapter'
import { createComprefaceAdapter } from './face-engine.compreface.adapter'
import type { LivenessChecker } from './liveness.checker'
import type { ConfigClient } from './config-client'
import { createHttpConfigClient } from './config-client'

export const FACE_ENGINE = Symbol('FACE_ENGINE')
export const LIVENESS_CHECKER = Symbol('LIVENESS_CHECKER')
export const CONFIG_CLIENT = Symbol('CONFIG_CLIENT')
export const CREDENTIAL_PEPPER = Symbol('CREDENTIAL_PEPPER')

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`svc-attendance: ${name} is required`)
  return value
}

function createHttpAuthzTransport(baseUrl: string): AuthzTransport {
  return {
    async post(path, body) {
      const res = await fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const text = await res.text()
      return text.length > 0 ? (JSON.parse(text) as unknown) : {}
    },
  }
}

/**
 * crypto-auth task: `svc-crypto` now guards `/encrypt`/`/decrypt` with
 * `PermissionGuard` (svc-attendance holds both — `DeviceService` writes AND
 * reads the device secret field, never `crypto.bidx`, which it never
 * calls). Takes an `AuthenticatedFetch` instead of the bare global `fetch`
 * it used before.
 */
function createHttpCryptoTransport(baseUrl: string, fetchImpl: typeof fetch): CryptoTransport {
  return {
    async post(path, body) {
      const res = await fetchImpl(`${baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const text = await res.text()
      return text.length > 0 ? (JSON.parse(text) as unknown) : {}
    },
  }
}

/**
 * crypto-auth task: this service's own machine identity — an OAuth2
 * client_credentials client, authenticated against the SAME OIDC issuer
 * `createOidcMiddleware` below validates incoming tokens against
 * (`OIDC_TOKEN_URL` is the issuer's TOKEN endpoint; `OIDC_ISSUER`/
 * `OIDC_JWKS_URI` are for verifying tokens, this is for OBTAINING one).
 * `S2S_CLIENT_ID`/`S2S_CLIENT_SECRET` come from the `svc-attendance` realm
 * client (`deploy/keycloak/realm-gadonghr.json`) — same pattern
 * `svc-onboarding`/`svc-payroll` already established for the S2S auth task.
 */
function createMachineTokenClient(): MachineTokenClient {
  return new MachineTokenClient(createHttpTokenTransport(requiredEnv('OIDC_TOKEN_URL')), {
    clientId: requiredEnv('S2S_CLIENT_ID'),
    clientSecret: requiredEnv('S2S_CLIENT_SECRET'),
  })
}

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

/** No hard-coded liveness engine in this build (P0 scope: the injected interface is what makes the future real implementation swap-in cheap, per the task brief). Every call fails closed — never silently reports `passed: true` for an engine that was never actually consulted. */
function createUnconfiguredLivenessChecker(): LivenessChecker {
  const fail = (): never => {
    throw new Error('svc-attendance: no LivenessChecker configured — LIVENESS_URL is required in production')
  }
  return { passiveCheck: fail, activeChallenge: fail }
}

function createOidcMiddleware(): OidcMiddlewareHandler {
  return createOidcMiddlewareHandler({
    issuer: requiredEnv('OIDC_ISSUER'),
    audience: requiredEnv('OIDC_AUDIENCE'),
    jwksUri: requiredEnv('OIDC_JWKS_URI'),
  })
}

/**
 * `OidcMiddleware` is scoped to the human-facing controllers only
 * (`configure()` below) — the two kiosk-only punch routes authenticate via
 * `DeviceAuthGuard` instead, and `AttendanceController`'s health route
 * needs neither.
 *
 * **Guard mounting (converged 2026-08-04).** This service now uses the
 * standard pattern every other service uses — a global `APP_GUARD`
 * `PermissionGuard` plus `@Public()` on the one route that is genuinely
 * unauthenticated — enforced by
 * `packages/kernel/src/authz/guard-mounting.audit.test.ts`.
 *
 * The M4 build mounted `PermissionGuard` per-controller via `@UseGuards`
 * instead, to avoid forcing a `@Public()` onto `AttendanceController`'s
 * pre-existing `GET /health`. Per-controller mounting fails open in exactly
 * one way, and it is the way that matters: a controller added to this
 * service later inherits nothing, so it ships unguarded and every test
 * still passes. Global mounting fails closed — an undecorated route throws
 * AUZ-403 rather than serving.
 *
 * TWO guards are registered, and the ORDER IS LOAD-BEARING. Nest runs
 * `APP_GUARD` providers in registration order, so `DeviceAuthGuard` runs
 * first and populates `request.userId` as `device:<id>` for a kiosk call,
 * which `PermissionGuard` then reads — the same order the two kiosk routes
 * previously got from `@UseGuards(DeviceAuthGuard, PermissionGuard)`.
 * Reversing these two lines would deny every kiosk punch before
 * `DeviceAuthGuard` ever ran. `DeviceAuthGuard` acts only on routes marked
 * `@DeviceAuthenticated()` and is a no-op elsewhere; it never grants
 * anything on its own, because `PermissionGuard` still has to allow the
 * request afterwards.
 */
@Module({
  controllers: [AttendanceController, EnrolmentController, PunchController, DeviceController, SecurityController],
  providers: [
    { provide: APP_FILTER, useClass: GadongErrorFilter },
    // ORDER IS LOAD-BEARING — see this module's header comment.
    { provide: APP_GUARD, useClass: DeviceAuthGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
    {
      provide: AuthzClient,
      useFactory: () => new AuthzClient(createHttpAuthzTransport(process.env['AUTHZ_URL'] ?? 'http://svc-authz:3000')),
    },
    {
      // crypto-auth task: one machine-token client, one authenticated-fetch
      // helper, for this service's one outbound guarded call (svc-crypto) —
      // matching `AuthzClient`/`CryptoClient`'s own one-instance-per-service
      // lifetime, same pattern `svc-onboarding`/`svc-payroll` established.
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
      provide: DB_POOL,
      useFactory: () => createPool(requiredEnv('DATABASE_URL'), 'attendance'),
    },
    {
      provide: CRYPTO_HEALTH,
      useFactory: () => createHttpHealthCheck(`${process.env['CRYPTO_URL'] ?? 'http://svc-crypto:3000'}/health`),
    },
    {
      provide: FACE_ENGINE_HEALTH,
      useFactory: () => createHttpHealthCheck(process.env['FACE_ENGINE_URL'] ?? 'http://compreface-api:8000'),
    },
    {
      // CompreFace cannot run in this environment (task CONSTRAINTS) — this
      // is real wiring for a real deployment, never exercised by this
      // build's own test suite (which proves every consumer against
      // `testing/fake-face-engine.ts` instead — see `face-engine.adapter.ts`).
      provide: FACE_ENGINE,
      useFactory: (): FaceEngineAdapter =>
        createComprefaceAdapter(process.env['FACE_ENGINE_URL'] ?? 'http://compreface-api:8000', process.env['FACE_ENGINE_API_KEY'] ?? ''),
    },
    {
      provide: LIVENESS_CHECKER,
      useFactory: (): LivenessChecker => createUnconfiguredLivenessChecker(),
    },
    {
      provide: CONFIG_CLIENT,
      useFactory: (): ConfigClient => createHttpConfigClient(process.env['CONFIG_URL'] ?? 'http://svc-config:3000'),
    },
    {
      // Pepper for PIN/QR/badge hashing (`credential-hash.ts`) — a secret,
      // not a statutory/governed figure, so (unlike the match threshold)
      // this is deliberately NOT read from `svc-config`; it is deployment
      // secret material, read from the environment like `DATABASE_URL`.
      provide: CREDENTIAL_PEPPER,
      useFactory: () => requiredEnv('ATTENDANCE_CREDENTIAL_PEPPER'),
    },
    { provide: AuditEmitter, useFactory: () => new AuditEmitter() },
    { provide: ConsentStateRepository, useFactory: (pool: Queryable) => new ConsentStateRepository(pool), inject: [DB_POOL] },
    { provide: EnrolmentRepository, useFactory: (pool: Queryable) => new EnrolmentRepository(pool), inject: [DB_POOL] },
    { provide: AlternativeCredentialRepository, useFactory: (pool: Queryable) => new AlternativeCredentialRepository(pool), inject: [DB_POOL] },
    { provide: DeviceRepository, useFactory: (pool: Queryable) => new DeviceRepository(pool), inject: [DB_POOL] },
    { provide: PunchRepository, useFactory: (pool: Queryable) => new PunchRepository(pool), inject: [DB_POOL] },
    { provide: SecurityEventRepository, useFactory: (pool: Queryable) => new SecurityEventRepository(pool), inject: [DB_POOL] },
    {
      provide: TemplateDeletionService,
      useFactory: (enrolmentRepo: EnrolmentRepository, faceEngine: FaceEngineAdapter, audit: AuditEmitter) =>
        new TemplateDeletionService(enrolmentRepo, faceEngine, audit),
      inject: [EnrolmentRepository, FACE_ENGINE, AuditEmitter],
    },
    {
      provide: EnrolmentService,
      useFactory: (
        consentState: ConsentStateRepository,
        enrolmentRepo: EnrolmentRepository,
        altCredentialRepo: AlternativeCredentialRepository,
        faceEngine: FaceEngineAdapter,
        audit: AuditEmitter,
        pepper: string,
      ) => new EnrolmentService(consentState, enrolmentRepo, altCredentialRepo, faceEngine, audit, pepper),
      inject: [ConsentStateRepository, EnrolmentRepository, AlternativeCredentialRepository, FACE_ENGINE, AuditEmitter, CREDENTIAL_PEPPER],
    },
    {
      provide: DeviceService,
      useFactory: (deviceRepo: DeviceRepository, crypto: CryptoClient, audit: AuditEmitter) => new DeviceService(deviceRepo, crypto, audit),
      inject: [DeviceRepository, CryptoClient, AuditEmitter],
    },
    {
      provide: PunchService,
      useFactory: (
        punchRepo: PunchRepository,
        enrolmentRepo: EnrolmentRepository,
        altCredentialRepo: AlternativeCredentialRepository,
        securityEventRepo: SecurityEventRepository,
        faceEngine: FaceEngineAdapter,
        liveness: LivenessChecker,
        config: ConfigClient,
        pepper: string,
      ) => new PunchService(punchRepo, enrolmentRepo, altCredentialRepo, securityEventRepo, faceEngine, liveness, config, pepper),
      inject: [PunchRepository, EnrolmentRepository, AlternativeCredentialRepository, SecurityEventRepository, FACE_ENGINE, LIVENESS_CHECKER, CONFIG_CLIENT, CREDENTIAL_PEPPER],
    },
    {
      provide: ConsentEventHandler,
      useFactory: (consentState: ConsentStateRepository, templateDeletion: TemplateDeletionService) => new ConsentEventHandler(consentState, templateDeletion),
      inject: [ConsentStateRepository, TemplateDeletionService],
    },
    {
      provide: EmployeeEventHandler,
      useFactory: (templateDeletion: TemplateDeletionService) => new EmployeeEventHandler(templateDeletion),
      inject: [TemplateDeletionService],
    },
    PermissionGuard,
    DeviceAuthGuard,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(createOidcMiddleware()).forRoutes(EnrolmentController, PunchController, DeviceController, SecurityController)
  }
}
