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
})
