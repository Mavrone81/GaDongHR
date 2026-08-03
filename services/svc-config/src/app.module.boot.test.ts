import 'reflect-metadata'
import { Test } from '@nestjs/testing'
import { AppModule } from './app.module'

/**
 * Task 16d module-wiring regression test — see `services/svc-authz/src/app.module.boot.test.ts`
 * for the full story of why a bare `.compile()` is not enough and why this
 * goes one step further with `createNestApplication()` + `.init()`.
 */
describe('AppModule boots under Nest (module wiring)', () => {
  const requiredEnvKeys = [
    'DATABASE_URL',
    'OIDC_ISSUER',
    'OIDC_AUDIENCE',
    'OIDC_JWKS_URI',
    'CONFIG_PACK_SIGNING_KEY',
  ] as const
  const savedEnv = new Map<string, string | undefined>()

  beforeEach(() => {
    for (const key of requiredEnvKeys) savedEnv.set(key, process.env[key])
    process.env['DATABASE_URL'] = 'postgres://user:pass@127.0.0.1:5432/gadong_test'
    process.env['OIDC_ISSUER'] = 'https://kc.gadonghr.test/auth/realms/gadong'
    process.env['OIDC_AUDIENCE'] = 'gadong-services'
    process.env['OIDC_JWKS_URI'] = 'https://kc.gadonghr.test/auth/realms/gadong/protocol/openid-connect/certs'
    process.env['CONFIG_PACK_SIGNING_KEY'] = 'test-signing-key-not-a-real-secret'
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
   * Task 16e, THE TEST GAP: the test above proves `AppModule` compiles and
   * initialises — it never issues a request, so it could not have caught
   * either live-droplet defect (health denied by the guard's own
   * deny-by-default; a `GadongError`'s real `httpStatus` never reaching the
   * HTTP response). These two tests go one step further and actually make a
   * real HTTP request through the fully compiled app, exactly the way
   * Docker's healthcheck / a load balancer / an uptime monitor does — no
   * `Authorization` header, a real TCP connection, a real response status.
   *
   * `bootAndListen`/`tcpPort` are duplicated (not shared via an import)
   * across every service's `app.module.boot.test.ts` that has this pair of
   * tests — each service's test suite is self-contained and this is a small
   * enough helper that a cross-service test-utility module would be more
   * machinery than the four lines it saves.
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

  it('GET /health is reachable with no Authorization header and returns HTTP 200 with a health payload (Task 16e defect 1: PermissionGuard must not deny its own healthcheck)', async () => {
    const { app, baseUrl } = await bootAndListen()
    try {
      const res = await fetch(`${baseUrl}/health`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { service?: unknown; status?: unknown; dependencies?: unknown }
      expect(body.service).toBe('svc-config')
      expect(['ok', 'degraded']).toContain(body.status)
    } finally {
      await app.close()
    }
  })

  it('a GadongError thrown by PermissionGuard for a protected route with no Authorization header is mapped to its real HTTP status (403) with the {code, message_i18n_key, details} envelope, not Nest\'s generic 500 (Task 16e defect 2)', async () => {
    const { app, baseUrl } = await bootAndListen()
    try {
      const res = await fetch(`${baseUrl}/rules`)
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
