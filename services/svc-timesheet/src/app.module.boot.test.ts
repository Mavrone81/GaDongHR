import 'reflect-metadata'
import { Test } from '@nestjs/testing'
import { AppModule } from './app.module'

/**
 * Task 16d module-wiring regression test — see `services/svc-authz/src/app.module.boot.test.ts`
 * for the full story of why a bare `.compile()` is not enough and why this
 * goes one step further with `createNestApplication()` + `.init()`.
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
   * actually gets a correct response. `svc-timesheet` has only `GET /health`
   * today (Phase 3 adds the rest — `timesheet.controller.ts`'s own header),
   * so only defect 1's test applies here; there is no other protected route
   * yet to demonstrate defect 2 against a real request (see
   * `services/svc-config` for that half).
   */
  it('GET /health is reachable with no Authorization header and returns HTTP 200 with a health payload (Task 16e defect 1: this service also mounts PermissionGuard as APP_GUARD)', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile()
    const app = moduleRef.createNestApplication({ logger: false })
    await app.init()
    await app.listen(0)
    try {
      const address: unknown = app.getHttpServer().address()
      if (typeof address !== 'object' || address === null || typeof (address as { port?: unknown }).port !== 'number') {
        throw new Error('app.module.boot.test: app did not bind a TCP port')
      }
      const baseUrl = `http://127.0.0.1:${(address as { port: number }).port}`
      const res = await fetch(`${baseUrl}/health`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { service?: unknown; status?: unknown }
      expect(body.service).toBe('svc-timesheet')
      expect(['ok', 'degraded']).toContain(body.status)
    } finally {
      await app.close()
    }
  })
})
