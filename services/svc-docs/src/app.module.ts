import 'reflect-metadata'
import { join } from 'node:path'
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

/** `svc-crypto` (Task 6) HTTP transport — the real implementation of kernel's `CryptoTransport` port, same shape as the authz transport above. `CryptoClient.encryptBatch`/`.decrypt` fail closed (`CRY-503`) on any transport rejection — see `packages/kernel/src/crypto/client.ts`. */
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
  if (!value) throw new Error(`svc-docs: ${name} is required`)
  return value
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
      provide: CryptoClient,
      useFactory: () => new CryptoClient(createHttpCryptoTransport(process.env['CRYPTO_URL'] ?? 'http://svc-crypto:3000')),
    },
    {
      provide: DB_POOL,
      // `createPool` pins `search_path` to `docs` so every unqualified table
      // name (and the fully-qualified `docs.*` names this repository
      // actually uses) resolves in this service's own schema and nowhere
      // else (global-constraints: "every service owns one schema").
      useFactory: () => createPool(requiredEnv('DATABASE_URL'), 'docs'),
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
      ) => new DocumentsService(repo, templates, fonts, renderer, storage, crypto, requiredEnv('DOCS_BUCKET')),
      inject: [DocumentsRepository, TemplateLoader, FontRegistry, ChromiumPdfRenderer, MinioObjectStorage, CryptoClient],
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
