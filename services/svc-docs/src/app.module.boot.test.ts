import 'reflect-metadata'
import { Test } from '@nestjs/testing'
import { AppModule } from './app.module'

/**
 * Task 16d module-wiring regression test — see `services/svc-authz/src/app.module.boot.test.ts`
 * for the full story of why a bare `.compile()` is not enough and why this
 * goes one step further with `createNestApplication()` + `.init()`.
 *
 * `MINIO_*`/`DOCS_BUCKET` are transport-level config only —
 * `MinioObjectStorage`'s constructor (`storage/minio-storage.ts`) just
 * builds a `minio.Client`, which never opens a connection until `.put()`/
 * `.get()` is called, so no real MinIO server is needed to boot.
 */
describe('AppModule boots under Nest (module wiring)', () => {
  const requiredEnvKeys = [
    'DATABASE_URL',
    'OIDC_ISSUER',
    'OIDC_AUDIENCE',
    'OIDC_JWKS_URI',
    'MINIO_ENDPOINT',
    'MINIO_ACCESS_KEY',
    'MINIO_SECRET_KEY',
    'DOCS_BUCKET',
  ] as const
  const savedEnv = new Map<string, string | undefined>()

  beforeEach(() => {
    for (const key of requiredEnvKeys) savedEnv.set(key, process.env[key])
    process.env['DATABASE_URL'] = 'postgres://user:pass@127.0.0.1:5432/gadong_test'
    process.env['OIDC_ISSUER'] = 'https://kc.gadonghr.test/auth/realms/gadong'
    process.env['OIDC_AUDIENCE'] = 'gadong-services'
    process.env['OIDC_JWKS_URI'] = 'https://kc.gadonghr.test/auth/realms/gadong/protocol/openid-connect/certs'
    process.env['MINIO_ENDPOINT'] = 'minio.test.invalid'
    process.env['MINIO_ACCESS_KEY'] = 'test-access-key'
    process.env['MINIO_SECRET_KEY'] = 'test-secret-key'
    process.env['DOCS_BUCKET'] = 'gadong-docs-test'
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
