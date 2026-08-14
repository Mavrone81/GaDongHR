import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import type { INestApplication } from '@nestjs/common'
import { AppModule } from './app.module'

/**
 * Task 16d-style module-wiring regression test (see `services/svc-config/
 * src/app.module.boot.test.ts` and `services/svc-authz/src/app.module.boot.test.ts`
 * for the full incident history this pattern guards against): a module
 * that merely TYPE-CHECKS can still throw `UnknownDependenciesException`
 * at request time if a provider/middleware binding is wrong, so this
 * actually boots the app (`NestFactory.create` — the same call `main.ts`
 * makes, not `@nestjs/testing`'s `Test.createTestingModule`, which is not
 * a dependency this service otherwise needs and this task must not add
 * outside its owned `{src,migrations}` directories) and issues real HTTP
 * requests through it, exactly the way Docker's healthcheck / a load
 * balancer / an uptime monitor does.
 */
describe('AppModule boots under Nest (module wiring)', () => {
  // S2S auth task: `createMachineTokenClient()` (`app.module.ts`) now reads
  // `OIDC_TOKEN_URL`/`S2S_CLIENT_ID`/`S2S_CLIENT_SECRET` at construction
  // time via `requiredEnv` — the exact same "boot fails loudly, not with a
  // request-time `UnknownDependenciesException`" contract this test file
  // already exists to guard, so these three join the set this test fixes.
  const requiredEnvKeys = ['DATABASE_URL', 'OIDC_ISSUER', 'OIDC_AUDIENCE', 'OIDC_JWKS_URI', 'OIDC_TOKEN_URL', 'S2S_CLIENT_ID', 'S2S_CLIENT_SECRET'] as const
  const savedEnv = new Map<string, string | undefined>()

  beforeEach(() => {
    for (const key of requiredEnvKeys) savedEnv.set(key, process.env[key])
    process.env['DATABASE_URL'] = 'postgres://user:pass@127.0.0.1:5432/gadong_test'
    process.env['OIDC_ISSUER'] = 'https://kc.gadonghr.test/auth/realms/gadong'
    process.env['OIDC_AUDIENCE'] = 'gadong-services'
    process.env['OIDC_JWKS_URI'] = 'https://kc.gadonghr.test/auth/realms/gadong/protocol/openid-connect/certs'
    process.env['OIDC_TOKEN_URL'] = 'https://kc.gadonghr.test/auth/realms/gadong/protocol/openid-connect/token'
    process.env['S2S_CLIENT_ID'] = 'svc-onboarding'
    process.env['S2S_CLIENT_SECRET'] = 'test-secret'
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

  it('initialises without an UnknownDependenciesException resolving OidcMiddleware or any service in the EmployeeController dependency graph', async () => {
    const { app } = await bootAndListen()
    await app.close()
  })

  it('GET /health is reachable with no Authorization header and returns HTTP 200 with a health payload — PermissionGuard must not deny its own healthcheck', async () => {
    const { app, baseUrl } = await bootAndListen()
    try {
      const res = await fetch(`${baseUrl}/health`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { service?: unknown; status?: unknown }
      expect(body.service).toBe('svc-onboarding')
      expect(['ok', 'degraded']).toContain(body.status)
    } finally {
      await app.close()
    }
  })

  it('a GadongError thrown by PermissionGuard for a protected route with no Authorization header is mapped to its real HTTP status (403) with the {code, message_i18n_key, details} envelope, not a generic 500', async () => {
    const { app, baseUrl } = await bootAndListen()
    try {
      const res = await fetch(`${baseUrl}/employees`)
      expect(res.status).toBe(403)
      const body = (await res.json()) as { code?: unknown; message_i18n_key?: unknown; details?: unknown }
      expect(body.code).toBe('AUZ-403')
      expect(body.message_i18n_key).toBe('authz.error.denied')
      expect(Array.isArray(body.details)).toBe(true)
    } finally {
      await app.close()
    }
  })
})
