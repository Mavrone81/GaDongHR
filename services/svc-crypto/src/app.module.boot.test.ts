import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import type { INestApplication } from '@nestjs/common'
import { AppModule } from './app.module'

/**
 * crypto-auth task: `svc-crypto` now mounts `OidcMiddleware`/`PermissionGuard`
 * like every other guarded service (see `app.module.ts`'s own doc for the
 * defense-in-depth story) — this is the Task 16d-style module-wiring
 * regression test that proves the DI graph actually resolves (a module
 * that merely type-checks can still throw `UnknownDependenciesException` at
 * request time), and that the guard's deny-by-default and the health
 * route's `@Public()` both hold end-to-end through a real booted app, not
 * just as isolated unit assertions (`crypto.controller.test.ts`).
 */
describe('AppModule boots under Nest (module wiring, crypto-auth task)', () => {
  const requiredEnvKeys = ['OIDC_ISSUER', 'OIDC_AUDIENCE', 'OIDC_JWKS_URI'] as const
  const savedEnv = new Map<string, string | undefined>()

  beforeEach(() => {
    for (const key of requiredEnvKeys) savedEnv.set(key, process.env[key])
    process.env['OIDC_ISSUER'] = 'https://kc.gadonghr.test/auth/realms/gadong'
    process.env['OIDC_AUDIENCE'] = 'gadong-services'
    process.env['OIDC_JWKS_URI'] = 'https://kc.gadonghr.test/auth/realms/gadong/protocol/openid-connect/certs'
  })

  afterEach(() => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    savedEnv.clear()
  })

  async function bootAndListen(): Promise<{ app: INestApplication; baseUrl: string }> {
    const app = await NestFactory.create(AppModule, { logger: false })
    await app.init()
    await app.listen(0)
    const address: unknown = app.getHttpServer().address()
    if (typeof address !== 'object' || address === null || typeof (address as { port?: unknown }).port !== 'number') {
      throw new Error('app.module.boot.test: app did not bind a TCP port')
    }
    return { app, baseUrl: `http://127.0.0.1:${(address as { port: number }).port}` }
  }

  it('initialises without an UnknownDependenciesException anywhere in the DI graph (guard, middleware, AuthzClient, VaultClient)', async () => {
    const { app } = await bootAndListen()
    await app.close()
  })

  it('GET /health is reachable with no Authorization header and returns HTTP 200 — PermissionGuard must not deny its own healthcheck', async () => {
    const { app, baseUrl } = await bootAndListen()
    try {
      const res = await fetch(`${baseUrl}/health`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { service?: unknown; status?: unknown }
      expect(body.service).toBe('svc-crypto')
      expect(['ok', 'degraded']).toContain(body.status)
    } finally {
      await app.close()
    }
  })

  it.each([
    ['POST', 'encrypt', '{"fields":[]}'],
    ['POST', 'decrypt', '{"entityId":"e","field":"f","ciphertext":"Y3Q=","purpose":"p"}'],
    ['POST', 'bidx', '{"fieldClass":"S2","field":"f","value":"v"}'],
  ])('%s /%s with no Authorization header denies with 403 AUZ-403, not a 500 — this is the hole this task closes', async (_method, path, body) => {
    const { app, baseUrl } = await bootAndListen()
    try {
      const res = await fetch(`${baseUrl}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body })
      expect(res.status).toBe(403)
      const json = (await res.json()) as { code?: unknown; message_i18n_key?: unknown }
      expect(json.code).toBe('AUZ-403')
      expect(json.message_i18n_key).toBe('authz.error.denied')
    } finally {
      await app.close()
    }
  })
})
