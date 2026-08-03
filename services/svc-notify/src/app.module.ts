import 'reflect-metadata'
import { Module } from '@nestjs/common'
import type { MiddlewareConsumer, NestModule } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { AuthzClient, PermissionGuard, createOidcMiddlewareHandler, createPool } from '@gadong/kernel'
import type { OidcMiddlewareHandler } from '@gadong/kernel'
import type { AuthzTransport, Locale, Queryable } from '@gadong/kernel'
import { DB_POOL, EMAIL_TRANSPORT, NotifyController } from './notify.controller'
import { NotifyRepository } from './notify.repository'
import { NotifyService } from './notify.service'
import type { EmailTransport } from './notify.service'
import { TemplateRenderer } from './templates'
import { NodemailerEmailTransport } from './smtp.transport'

/**
 * `svc-authz` HTTP wiring — identical shape and identical justification to
 * `services/svc-config/src/app.module.ts`'s `createHttpAuthzTransport`:
 * svc-authz's `/decide` is real HTTP even though nothing in THIS
 * environment calls it, and an unreachable transport already fails closed
 * (kernel `authz/client.ts`).
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
  if (!value) throw new Error(`svc-notify: ${name} is required`)
  return value
}

function isLocale(v: string | undefined): v is Locale {
  return v === 'th' || v === 'en' || v === 'zh'
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

/**
 * Not a secret — unlike `svc-config`'s `CONFIG_PACK_SIGNING_KEY`, there is
 * nothing here a hard-coded fallback would leak — so a plain in-code
 * default is fine. `'th'` (not `'en'`) because GaDongHR's workforce is
 * majority Thai-speaking factory floor staff (product brief); the whole
 * point of "recipient's language, not the actor's, and never
 * English-by-accident" (Task 11 brief) is defeated if the one language
 * nobody explicitly chose quietly becomes English.
 */
const DEFAULT_TENANT_LANG: Locale = 'th'

/**
 * Reached by end users (`GET /notifications`, `POST /notifications/:id/read`)
 * so, like `svc-config` and unlike `svc-crypto` (service-to-service only),
 * this mounts the kernel's `PermissionGuard` as `APP_GUARD`: every route
 * not explicitly exempted (only `GET /health`) must declare a permission or
 * the guard denies it.
 */
@Module({
  controllers: [NotifyController],
  providers: [
    { provide: APP_GUARD, useClass: PermissionGuard },
    {
      provide: AuthzClient,
      useFactory: () => new AuthzClient(createHttpAuthzTransport(process.env['AUTHZ_URL'] ?? 'http://svc-authz:3000')),
    },
    {
      provide: DB_POOL,
      // `createPool` pins `search_path` to `notify` so every unqualified
      // table name resolves in this service's own schema and nowhere else
      // (global-constraints: "every service owns one schema").
      useFactory: () => createPool(requiredEnv('DATABASE_URL'), 'notify'),
    },
    {
      provide: NotifyRepository,
      useFactory: (pool: Queryable) => new NotifyRepository(pool),
      inject: [DB_POOL],
    },
    {
      provide: TemplateRenderer,
      useFactory: () => new TemplateRenderer(),
    },
    {
      provide: EMAIL_TRANSPORT,
      useFactory: () =>
        new NodemailerEmailTransport({
          host: requiredEnv('SMTP_HOST'),
          port: Number(process.env['SMTP_PORT'] ?? '587'),
          secure: process.env['SMTP_SECURE'] === 'true',
          from: requiredEnv('SMTP_FROM'),
          user: process.env['SMTP_USER'],
          pass: process.env['SMTP_PASS'],
        }),
    },
    {
      provide: NotifyService,
      useFactory: (repo: NotifyRepository, emailTransport: EmailTransport, templates: TemplateRenderer) => {
        const envLang = process.env['NOTIFY_TENANT_DEFAULT_LANG']
        const tenantDefaultLang = isLocale(envLang) ? envLang : DEFAULT_TENANT_LANG
        return new NotifyService(repo, emailTransport, templates, tenantDefaultLang)
      },
      inject: [NotifyRepository, EMAIL_TRANSPORT, TemplateRenderer],
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
