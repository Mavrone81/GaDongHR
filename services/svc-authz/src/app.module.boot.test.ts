import 'reflect-metadata'
import { Test } from '@nestjs/testing'
import { AppModule } from './app.module'

/**
 * Task 16d module-wiring regression test. The kernel's own OIDC tests
 * (`packages/kernel/src/authz/oidc.middleware.test.ts`) exercise
 * `OidcMiddleware` directly and stayed green throughout the incident —
 * they never boot a real Nest module, so they could not have caught
 * `AppModule.configure()` handing `consumer.apply()` something Nest's
 * container cannot construct. This test is the one that would have: it
 * boots `AppModule` through Nest's real testing utilities, the same path
 * `main.ts` takes in production.
 *
 * `Test.createTestingModule(...).compile()` alone is NOT enough to
 * reproduce the failure — Nest only resolves `MiddlewareConsumer.apply(...)`
 * targets during `NestApplication.init()` (`@nestjs/core`'s
 * `nest-application.js`: `registerModules()` calls
 * `MiddlewareModule.register()`), which only runs once `createNestApplication()`
 * + `.init()` are called. That is why this test goes one step further than
 * a bare `.compile()`.
 *
 * Only transport-level env vars are stubbed — a Postgres connection string
 * a lazily-connecting `pg.Pool` never dials during boot, and a fake OIDC
 * issuer/JWKS URI `OidcMiddleware` never fetches from until a real request
 * arrives. Nest itself is never stubbed: a module that cannot `.init()` is
 * exactly what the live droplet's crash loop was reporting.
 */
describe('AppModule boots under Nest (module wiring)', () => {
  const requiredEnvKeys = ['DATABASE_URL', 'OIDC_ISSUER', 'OIDC_AUDIENCE', 'OIDC_JWKS_URI'] as const
  const savedEnv = new Map<string, string | undefined>()

  beforeEach(() => {
    for (const key of requiredEnvKeys) savedEnv.set(key, process.env[key])
    process.env['DATABASE_URL'] = 'postgres://user:pass@127.0.0.1:5432/gadong_test'
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

  it('initialises without an UnknownDependenciesException resolving OidcMiddleware', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    const app = moduleRef.createNestApplication()
    await app.init()
    await app.close()
  })

  /**
   * Task 16e — see `services/svc-config/src/app.module.boot.test.ts`'s
   * identical pair of tests for the full "THE TEST GAP" story: a bare
   * `.compile()`/`.init()` proves the module wires up, never that a request
   * actually gets a correct response. `svc-authz` was never one of the four
   * services defect 1 broke (`/health` here has no `@RequirePermission`/
   * `@UseGuards` at all — see `authz.controller.ts`), but this still issues
   * a real request rather than assuming that from the source; and
   * `GET /roles` (guarded per-route with `@UseGuards(PermissionGuard)`, not
   * `APP_GUARD`) is this service's demonstration of defect 2.
   */
  async function bootAndListen(): Promise<{ app: import('@nestjs/common').INestApplication; baseUrl: string }> {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    const app = moduleRef.createNestApplication({ logger: false })
    await app.init()
    await app.listen(0)
    const address: unknown = app.getHttpServer().address()
    if (typeof address !== 'object' || address === null || typeof (address as { port?: unknown }).port !== 'number') {
      throw new Error('app.module.boot.test: app did not bind a TCP port')
    }
    return { app, baseUrl: `http://127.0.0.1:${(address as { port: number }).port}` }
  }

  it('GET /health is reachable with no Authorization header and returns HTTP 200 with a health payload', async () => {
    const { app, baseUrl } = await bootAndListen()
    try {
      const res = await fetch(`${baseUrl}/health`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { service?: unknown; status?: unknown }
      expect(body.service).toBe('svc-authz')
      expect(['ok', 'degraded']).toContain(body.status)
    } finally {
      await app.close()
    }
  })

  it('a GadongError thrown by the per-route PermissionGuard for GET /roles with no Authorization header is mapped to its real HTTP status (403) with the envelope, not a 500 (Task 16e defect 2)', async () => {
    const { app, baseUrl } = await bootAndListen()
    try {
      const res = await fetch(`${baseUrl}/roles`)
      expect(res.status).toBe(403)
      const body = (await res.json()) as { code?: unknown; message_i18n_key?: unknown }
      expect(body.code).toBe('AUZ-403')
      expect(body.message_i18n_key).toBe('authz.error.denied')
    } finally {
      await app.close()
    }
  })
})
