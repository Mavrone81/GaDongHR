import 'reflect-metadata'
import { join } from 'node:path'
import { Module } from '@nestjs/common'
import type { MiddlewareConsumer, NestModule } from '@nestjs/common'
import { APP_FILTER, APP_GUARD } from '@nestjs/core'
import {
  AuditEmitter,
  AuthzClient,
  CryptoClient,
  DENIAL_AUDIT_SINK,
  GadongErrorFilter,
  MachineTokenClient,
  PermissionGuard,
  createAuthenticatedFetch,
  createHttpTokenTransport,
  createOidcMiddlewareHandler,
  createPool,
} from '@gadong/kernel'
import type { OidcMiddlewareHandler } from '@gadong/kernel'
import type { AuthenticatedFetch, AuthzTransport, CryptoTransport, DenialAuditSink, Queryable } from '@gadong/kernel'
import { DB_POOL, DocumentsController } from './documents.controller'
import { DocumentsService } from './documents.service'
import { DocumentsRepository } from './documents.repository'
import { TemplateLoader } from './templates'
import { FontRegistry } from './fonts/font-registry'
import type { FontDescriptor } from './fonts/font-registry'
import { EXPECTED_FONT_FAMILIES } from './fonts/font-registry'
import { ChromiumPdfRenderer } from './rendering/chromium-renderer'
import { MinioObjectStorage } from './storage/minio-storage'

/**
 * `svc-authz` (Task 8) HTTP transport — identical wiring to
 * `services/svc-config/src/app.module.ts`; see that file's comment for why
 * an unreachable transport correctly fails closed (kernel `AuthzClient`)
 * rather than needing a placeholder here.
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
 * `svc-crypto` (Task 6) HTTP transport — the real implementation of
 * kernel's `CryptoTransport` port. `CryptoClient.encryptBatch`/`.decrypt`
 * fail closed (`CRY-503`) on any transport rejection — see
 * `packages/kernel/src/crypto/client.ts`. crypto-auth task: `svc-crypto`
 * now guards `/encrypt`/`/decrypt` with `PermissionGuard` (svc-docs holds
 * both — it writes the `file_ref` pointer on generate and decrypts it back
 * to embed/serve a previously rendered document, never `crypto.bidx`,
 * which it never calls), so this takes an `AuthenticatedFetch` instead of
 * the bare global `fetch` it used before.
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

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`svc-docs: ${name} is required`)
  return value
}

/**
 * crypto-auth task: this service's own machine identity for its one
 * outbound guarded call (svc-crypto) — an OAuth2 client_credentials
 * client, authenticated against the SAME OIDC issuer `createOidcMiddleware`
 * below validates incoming tokens against (`OIDC_TOKEN_URL` is the
 * issuer's TOKEN endpoint; `OIDC_ISSUER`/`OIDC_JWKS_URI` are for verifying
 * tokens, this is for OBTAINING one). `S2S_CLIENT_ID`/`S2S_CLIENT_SECRET`
 * come from the `svc-docs` realm client
 * (`deploy/keycloak/realm-gadonghr.json`) — same pattern
 * `svc-onboarding`/`svc-payroll` established for the S2S auth task.
 */
function createMachineTokenClient(): MachineTokenClient {
  return new MachineTokenClient(createHttpTokenTransport(requiredEnv('OIDC_TOKEN_URL')), {
    clientId: requiredEnv('S2S_CLIENT_ID'),
    clientSecret: requiredEnv('S2S_CLIENT_SECRET'),
  })
}

/**
 * Task 13c: closes the gap where `PermissionGuard` reads `request.userId`
 * but nothing ever set it — see `services/svc-config/src/app.module.ts`'s
 * `createOidcMiddleware` comment for the full story; identical wiring here.
 */
function createOidcMiddleware(): OidcMiddlewareHandler {
  return createOidcMiddlewareHandler({
    issuer: requiredEnv('OIDC_ISSUER'),
    audience: requiredEnv('OIDC_AUDIENCE'),
    jwksUri: requiredEnv('OIDC_JWKS_URI'),
  })
}

/** `templates/` and `templates/fonts/` ship next to `dist/` in both the source tree and the built Docker image (`Dockerfile`'s runtime stage `COPY`s `templates` alongside `dist`) — `__dirname` is `dist/` at runtime, so `../templates` reaches it in both places. */
const TEMPLATES_DIR = join(__dirname, '..', 'templates')
const FONTS_DIR = join(TEMPLATES_DIR, 'fonts')

/** Logical family name → embedded file, per I18N-GUIDE.md §1 rule 6. `EXPECTED_FONT_FAMILIES` (from `fonts/font-registry.ts`) is the single source of truth for which three families `/health` requires — this list must register exactly those, or `FontRegistry.isHealthy()` reports `down` even on a correctly built image. */
const FONT_DESCRIPTORS: FontDescriptor[] = [
  { family: 'Sarabun', path: join(FONTS_DIR, 'Sarabun-Regular.ttf') },
  { family: 'Noto Sans SC', path: join(FONTS_DIR, 'NotoSansSC-Regular.ttf') },
  { family: 'Noto Sans', path: join(FONTS_DIR, 'NotoSans-Regular.ttf') },
]

void EXPECTED_FONT_FAMILIES // documents the contract FONT_DESCRIPTORS above must satisfy; enforced by font-registry.test.ts, not by the type system

/**
 * Reached by HR admins/managers requesting payslips and contracts (unlike
 * `svc-crypto`, deliberately exempt because it is service-to-service only),
 * so — matching `svc-config` — this mounts the kernel's `PermissionGuard`
 * as `APP_GUARD`: every route not explicitly exempted (only `GET /health`
 * is) must declare a permission or the guard denies it.
 */
@Module({
  controllers: [DocumentsController],
  providers: [
    { provide: APP_GUARD, useClass: PermissionGuard },
    // Task 16e, defect 2: maps a thrown `GadongError` (most importantly the
    // ones `PermissionGuard` above throws directly, before any controller's
    // own `try`/`catch` ever runs) onto its declared `httpStatus` and
    // `{code, message_i18n_key, details}` envelope — see kernel
    // `http/gadong-error.filter.ts`. Global (`APP_FILTER`), not a per-route
    // `@UseFilters`, for the same reason `PermissionGuard` is global: a
    // route-scoped filter would never see an exception thrown by a
    // globally-mounted guard.
    { provide: APP_FILTER, useClass: GadongErrorFilter },
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
      // `createPool` pins `search_path` to `docs` so every unqualified table
      // name (and the fully-qualified `docs.*` names this repository
      // actually uses) resolves in this service's own schema and nowhere
      // else (global-constraints: "every service owns one schema").
      useFactory: () => createPool(requiredEnv('DATABASE_URL'), 'docs'),
    },
    // One shared `AuditEmitter` (stateless — kernel `audit/emitter.ts`),
    // matching `svc-payroll`'s `app.module.ts`.
    { provide: AuditEmitter, useFactory: () => new AuditEmitter() },
    {
      // Wires `PermissionGuard`'s optional denial-audit sink (kernel
      // `authz/guard.ts`) to this service's own `docs.outbox` — see that
      // file's "DENIAL AUDITING" doc.
      provide: DENIAL_AUDIT_SINK,
      useFactory: (pool: Queryable): DenialAuditSink => ({ pool, schema: 'docs' }),
      inject: [DB_POOL],
    },
    {
      provide: DocumentsRepository,
      useFactory: (pool: Queryable) => new DocumentsRepository(pool),
      inject: [DB_POOL],
    },
    {
      provide: TemplateLoader,
      useFactory: () => new TemplateLoader(TEMPLATES_DIR),
    },
    {
      provide: FontRegistry,
      useFactory: () => new FontRegistry(FONT_DESCRIPTORS),
    },
    {
      provide: ChromiumPdfRenderer,
      useFactory: () => new ChromiumPdfRenderer(process.env['CHROMIUM_EXECUTABLE_PATH']),
    },
    {
      provide: MinioObjectStorage,
      useFactory: () =>
        new MinioObjectStorage({
          endPoint: requiredEnv('MINIO_ENDPOINT'),
          port: Number(process.env['MINIO_PORT'] ?? '9000'),
          useSSL: process.env['MINIO_USE_SSL'] === 'true',
          accessKey: requiredEnv('MINIO_ACCESS_KEY'),
          secretKey: requiredEnv('MINIO_SECRET_KEY'),
        }),
    },
    {
      provide: DocumentsService,
      useFactory: (
        repo: DocumentsRepository,
        templates: TemplateLoader,
        fonts: FontRegistry,
        renderer: ChromiumPdfRenderer,
        storage: MinioObjectStorage,
        crypto: CryptoClient,
        audit: AuditEmitter,
      ) => new DocumentsService(repo, templates, fonts, renderer, storage, crypto, requiredEnv('DOCS_BUCKET'), audit),
      inject: [DocumentsRepository, TemplateLoader, FontRegistry, ChromiumPdfRenderer, MinioObjectStorage, CryptoClient, AuditEmitter],
    },
  ],
})
export class AppModule implements NestModule {
  // Functional middleware, not the `OidcMiddleware` class — see kernel
  // `authz/oidc.middleware.ts`'s `createOidcMiddlewareHandler` doc for why
  // `consumer.apply(OidcMiddleware)` fails with
  // `UnknownDependenciesException` (Task 16d incident).
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(createOidcMiddleware()).forRoutes('*')
  }
}
