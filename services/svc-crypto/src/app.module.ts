import 'reflect-metadata'
import { Module } from '@nestjs/common'
import type { MiddlewareConsumer, NestModule } from '@nestjs/common'
import { APP_FILTER, APP_GUARD } from '@nestjs/core'
import { AuthzClient, GadongErrorFilter, PermissionGuard, createOidcMiddlewareHandler } from '@gadong/kernel'
import type { AuthzTransport, OidcMiddlewareHandler } from '@gadong/kernel'
import { CryptoController } from './crypto.controller'
import { CryptoService } from './crypto.service'
import { VAULT_PORT, VaultClient, createHttpVaultTransport, readApproleSecretFromFile } from './vault.client'

/**
 * Defense-in-depth fix (crypto-auth task): `svc-crypto` decrypts every
 * sensitive field in the system, and until this task it accepted `/encrypt`,
 * `/decrypt` and `/bidx` with ZERO authentication — the only thing standing
 * between any compromised container on `gadong-internal` (a normal bridge
 * network, not `internal: true` — see this task's report for why that is
 * documented, not flipped, as the network-topology half of the fix) and a
 * plaintext decrypt was "no published port". This module now mounts the
 * SAME `OidcMiddleware`/`PermissionGuard` path every other guarded service
 * uses — a calling service's machine `client_credentials` token
 * (`packages/kernel/src/authz/machine-token.client.ts`, already built for
 * the S2S auth task) flows through unmodified: there is no parallel,
 * weaker validation scheme for svc-crypto's callers. `crypto.controller.ts`
 * declares `crypto.encrypt`/`crypto.decrypt`/`crypto.bidx` — see that
 * file's doc and `deploy/scripts/seed.sh`'s per-service grants table for
 * why each calling service holds only the subset it actually needs
 * (least privilege: a service that only encrypts must never hold decrypt).
 *
 * `VAULT_PORT`'s factory reads `VAULT_ADDR`, `VAULT_APPROLE_ID` and the
 * AppRole secret file at `VAULT_APPROLE_SECRET_FILE` once, at DI
 * instantiation time — never logged, never re-read per request.
 */
function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`svc-crypto: ${name} is required`)
  return value
}

/** Identical shape to every other guarded service's `createHttpAuthzTransport` (e.g. `services/svc-docs/src/app.module.ts`) — an unreachable transport correctly fails closed (kernel `AuthzClient`). */
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

/** Same pattern as every other guarded service's `createOidcMiddleware` — see `packages/kernel/src/authz/oidc.middleware.ts`'s `createOidcMiddlewareHandler` doc for why this must be functional middleware, not the `OidcMiddleware` class directly. */
function createOidcMiddleware(): OidcMiddlewareHandler {
  return createOidcMiddlewareHandler({
    issuer: requiredEnv('OIDC_ISSUER'),
    audience: requiredEnv('OIDC_AUDIENCE'),
    jwksUri: requiredEnv('OIDC_JWKS_URI'),
  })
}

@Module({
  controllers: [CryptoController],
  providers: [
    { provide: APP_GUARD, useClass: PermissionGuard },
    CryptoService,
    // Task 16e, defect 2: maps a thrown `GadongError` (e.g.
    // `cryptoUnavailable()`, thrown when Vault is sealed or unreachable, and
    // already translated per-route by `crypto.controller.ts`'s own
    // `runFailClosed`, or `permissionDenied()`/`noPermissionDeclaredError()`
    // thrown directly by `PermissionGuard` above) onto its declared HTTP
    // status/envelope — see kernel `http/gadong-error.filter.ts`. Registered
    // globally as a safety net, not a replacement for that per-route
    // translation.
    { provide: APP_FILTER, useClass: GadongErrorFilter },
    {
      provide: AuthzClient,
      useFactory: () => new AuthzClient(createHttpAuthzTransport(process.env['AUTHZ_URL'] ?? 'http://svc-authz:3000')),
    },
    {
      provide: VAULT_PORT,
      useFactory: () => {
        const addr = process.env['VAULT_ADDR'] ?? 'http://127.0.0.1:8200'
        const roleId = process.env['VAULT_APPROLE_ID'] ?? ''
        const secretFile = process.env['VAULT_APPROLE_SECRET_FILE']
        const secretId = secretFile ? readApproleSecretFromFile(secretFile) : ''
        return new VaultClient(createHttpVaultTransport(addr), { addr, roleId, secretId })
      },
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(createOidcMiddleware()).forRoutes('*')
  }
}
