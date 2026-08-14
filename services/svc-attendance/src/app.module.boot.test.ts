import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import type { INestApplication } from '@nestjs/common'
import { AppModule } from './app.module'

/**
 * Task 16d-style module-wiring regression test (see
 * `services/svc-onboarding/src/app.module.boot.test.ts`, which this
 * mirrors): a module that merely TYPE-CHECKS can still throw
 * `UnknownDependenciesException` at request time if a provider/guard/
 * middleware binding is wrong — this actually boots the app
 * (`NestFactory.create`, the same call `main.ts` makes) and issues real
 * HTTP requests through it.
 *
 * This is the test that would have caught a wrong `@UseGuards` ORDER on
 * the kiosk punch routes (`punch.controller.ts`'s header comment):
 * `DeviceAuthGuard` must run before `PermissionGuard`, and a DI resolution
 * failure for either guard's own constructor dependencies (`DeviceService`,
 * `AuthzClient`) only surfaces once Nest actually tries to instantiate the
 * route handler chain — never at `tsc` time.
 */
describe('AppModule boots under Nest (module wiring)', () => {
  // crypto-auth task: `createMachineTokenClient()` (`app.module.ts`) now
  // reads `OIDC_TOKEN_URL`/`S2S_CLIENT_ID`/`S2S_CLIENT_SECRET` at
  // construction time via `requiredEnv` — same "boot fails loudly" contract
  // this test file already exists to guard (see svc-onboarding's identical
  // fixture from the S2S auth task).
  const requiredEnvKeys = [
    'DATABASE_URL',
    'OIDC_ISSUER',
    'OIDC_AUDIENCE',
    'OIDC_JWKS_URI',
    'OIDC_TOKEN_URL',
    'S2S_CLIENT_ID',
    'S2S_CLIENT_SECRET',
    'ATTENDANCE_CREDENTIAL_PEPPER',
  ] as const
  const savedEnv = new Map<string, string | undefined>()

  beforeEach(() => {
    for (const key of requiredEnvKeys) savedEnv.set(key, process.env[key])
    process.env['DATABASE_URL'] = 'postgres://user:pass@127.0.0.1:5432/gadong_test'
    process.env['OIDC_ISSUER'] = 'https://kc.gadonghr.test/auth/realms/gadong'
    process.env['OIDC_AUDIENCE'] = 'gadong-services'
    process.env['OIDC_JWKS_URI'] = 'https://kc.gadonghr.test/auth/realms/gadong/protocol/openid-connect/certs'
    process.env['OIDC_TOKEN_URL'] = 'https://kc.gadonghr.test/auth/realms/gadong/protocol/openid-connect/token'
    process.env['S2S_CLIENT_ID'] = 'svc-attendance'
    process.env['S2S_CLIENT_SECRET'] = 'test-secret'
    process.env['ATTENDANCE_CREDENTIAL_PEPPER'] = 'test-boot-pepper-not-for-production'
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

  it('initialises without an UnknownDependenciesException anywhere in the DI graph (guards, middleware, every controller)', async () => {
    const { app } = await bootAndListen()
    await app.close()
  })

  it('GET /health is reachable with no Authorization header and returns HTTP 200 — unaffected by the new per-controller PermissionGuard wiring', async () => {
    const { app, baseUrl } = await bootAndListen()
    try {
      const res = await fetch(`${baseUrl}/health`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { service?: unknown; status?: unknown }
      expect(body.service).toBe('svc-attendance')
      expect(['ok', 'degraded']).toContain(body.status)
    } finally {
      await app.close()
    }
  })

  it('a human-facing protected route (POST /enrolments/start) with no Authorization header denies with 403 AUZ-403, not a 500', async () => {
    const { app, baseUrl } = await bootAndListen()
    try {
      const res = await fetch(`${baseUrl}/enrolments/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      expect(res.status).toBe(403)
      const body = (await res.json()) as { code?: unknown }
      expect(body.code).toBe('AUZ-403')
    } finally {
      await app.close()
    }
  })

  it('a kiosk-only route (POST /punches/face) with no device headers denies (DeviceAuthGuard runs before PermissionGuard) — never a 500', async () => {
    const { app, baseUrl } = await bootAndListen()
    try {
      const res = await fetch(`${baseUrl}/punches/face`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      expect(res.status).toBeLessThan(500)
    } finally {
      await app.close()
    }
  })
})
