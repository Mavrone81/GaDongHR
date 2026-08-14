import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

/**
 * Task 15b: like `deploy/compose-validation.test.ts` is the test suite for
 * the compose files, this file is the test suite for
 * `realm-gadonghr.json` — there is no running Keycloak in this
 * environment to assert against, so every assertion here is against the
 * parsed JSON itself (and, for the audience mapper, against the REAL
 * `OIDC_AUDIENCE` the running stack would configure — read via `docker
 * compose config`, the same canonical-merge trick
 * `compose-validation.test.ts` uses, never a copied string literal).
 */

interface ProtocolMapperRepresentation {
  name: string
  protocol: string
  protocolMapper: string
  config: Record<string, string>
}

interface ClientRepresentation {
  clientId: string
  publicClient: boolean
  standardFlowEnabled: boolean
  implicitFlowEnabled: boolean
  directAccessGrantsEnabled: boolean
  serviceAccountsEnabled: boolean
  attributes?: Record<string, string>
  protocolMappers?: ProtocolMapperRepresentation[]
  secret?: string
}

interface UserRepresentation {
  id: string
  username: string
  serviceAccountClientId?: string
}

interface RealmRepresentation {
  realm: string
  enabled: boolean
  clients: ClientRepresentation[]
  users?: UserRepresentation[]
  accessTokenLifespan: number
  ssoSessionMaxLifespan: number
  revokeRefreshToken: boolean
  refreshTokenMaxReuse: number
  bruteForceProtected: boolean
  registrationAllowed: boolean
  resetPasswordAllowed: boolean
  loginWithEmailAllowed: boolean
}

const REALM_PATH = join(__dirname, 'realm-gadonghr.json')
const DEPLOY_DIR = join(__dirname, '..')

/** Security doc SECURITY-ENCRYPTION-DESIGN.md §6: "session lifetime <= 12h" — plus the task brief's own "access token <= 15 min" ceiling. */
const MAX_ACCESS_TOKEN_LIFESPAN_SEC = 15 * 60
const MAX_SSO_SESSION_MAX_LIFESPAN_SEC = 12 * 60 * 60

function readRealm(): RealmRepresentation {
  return JSON.parse(readFileSync(REALM_PATH, 'utf8')) as RealmRepresentation
}

function findClient(realm: RealmRepresentation, clientId: string): ClientRepresentation {
  const client = realm.clients.find((c) => c.clientId === clientId)
  if (!client) throw new Error(`realm-gadonghr.json: client "${clientId}" not found`)
  return client
}

/**
 * The exact value `packages/kernel/src/authz/oidc.middleware.ts` checks
 * `aud` against in production — read from `docker compose config`'s
 * canonical, fully-merged output (`x-oidc-env`'s `OIDC_AUDIENCE`, as
 * resolved for `svc-authz`), not retyped here. This is what makes the
 * audience-mapper test below catch a drift between `docker-compose.yml`
 * and this realm file, not just a typo inside this test.
 */
function readConfiguredAudience(): string {
  const out = execFileSync('docker', ['compose', '-f', 'docker-compose.yml', 'config', '--format', 'json'], {
    cwd: DEPLOY_DIR,
    encoding: 'utf8',
  })
  const config = JSON.parse(out) as { services: Record<string, { environment?: Record<string, string> }> }
  const audience = config.services['svc-authz']?.environment?.['OIDC_AUDIENCE']
  if (!audience) throw new Error('OIDC_AUDIENCE not found in `docker compose config` output for svc-authz')
  return audience
}

describe('deploy/keycloak/realm-gadonghr.json', () => {
  let realm: RealmRepresentation

  beforeAll(() => {
    realm = readRealm()
  })

  test('parses cleanly as the gadonghr realm, enabled', () => {
    expect(realm.realm).toBe('gadonghr')
    expect(realm.enabled).toBe(true)
  })

  test('declares exactly ten clients: web, seeder, the four S2S auth task machine principals, and the four crypto-auth task machine principals', () => {
    expect(realm.clients.map((c) => c.clientId).sort()).toEqual([
      'seeder',
      'svc-attendance',
      'svc-claims',
      'svc-docs',
      'svc-leave',
      'svc-onboarding',
      'svc-payroll',
      'svc-scheduler',
      'svc-timesheet',
      'web',
    ])
  })

  test('login with email, no self-registration, no default password reset', () => {
    expect(realm.loginWithEmailAllowed).toBe(true)
    expect(realm.registrationAllowed).toBe(false)
    expect(realm.resetPasswordAllowed).toBe(false)
  })

  describe('web — the PWA client', () => {
    let web: ClientRepresentation
    beforeAll(() => {
      web = findClient(realm, 'web')
    })

    test('is public with PKCE S256 required', () => {
      expect(web.publicClient).toBe(true)
      expect(web.attributes?.['pkce.code.challenge.method']).toBe('S256')
    })

    test('standard flow only — implicit and direct-grant flows disabled', () => {
      expect(web.standardFlowEnabled).toBe(true)
      expect(web.implicitFlowEnabled).toBe(false)
      expect(web.directAccessGrantsEnabled).toBe(false)
    })

    test('has no service account of its own', () => {
      expect(web.serviceAccountsEnabled).toBe(false)
    })
  })

  describe('seeder — the bootstrap service-account client', () => {
    let seeder: ClientRepresentation
    beforeAll(() => {
      seeder = findClient(realm, 'seeder')
    })

    test('is confidential with service accounts on and standard flow off', () => {
      expect(seeder.publicClient).toBe(false)
      expect(seeder.serviceAccountsEnabled).toBe(true)
      expect(seeder.standardFlowEnabled).toBe(false)
    })

    test('carries no secret literal in the committed file', () => {
      // A real secret checked into git is exactly what deploy/scripts/seed.sh's
      // Admin-REST-pin mechanism exists to avoid — see deploy/keycloak/README.md.
      expect(seeder.secret).toBeUndefined()
    })

    test("its service-account user's id is pinned in `users`, matching seed.sh's SEEDER_SERVICE_ACCOUNT_ID", () => {
      const svcUser = realm.users?.find((u) => u.serviceAccountClientId === 'seeder')
      expect(svcUser).toBeDefined()
      expect(svcUser?.id).toBe('00000000-0000-4000-8000-00005eed0001')

      const seedSh = readFileSync(join(DEPLOY_DIR, 'scripts', 'seed.sh'), 'utf8')
      const bootstrapAdminSh = readFileSync(join(DEPLOY_DIR, 'scripts', 'bootstrap-admin.sh'), 'utf8')
      expect(seedSh).toContain(`SEEDER_SERVICE_ACCOUNT_ID="${svcUser?.id}"`)
      expect(bootstrapAdminSh).toContain(`SEEDER_SERVICE_ACCOUNT_ID="${svcUser?.id}"`)
    })
  })

  describe('the four S2S auth task machine principals (svc-onboarding, svc-payroll, svc-timesheet, svc-scheduler)', () => {
    const machineClientIds = ['svc-onboarding', 'svc-payroll', 'svc-timesheet', 'svc-scheduler'] as const

    test.each(machineClientIds)('%s is confidential, service accounts on, standard flow off, no secret literal committed', (clientId) => {
      const client = findClient(realm, clientId)
      expect(client.publicClient).toBe(false)
      expect(client.serviceAccountsEnabled).toBe(true)
      expect(client.standardFlowEnabled).toBe(false)
      // Same reasoning as `seeder`: a real secret checked into git is
      // exactly what `deploy/scripts/seed.sh`'s Admin-REST-pin mechanism
      // exists to avoid.
      expect(client.secret).toBeUndefined()
    })

    test.each(machineClientIds)("%s's service-account user id is pinned in `users`, distinct from every other principal", (clientId) => {
      const svcUser = realm.users?.find((u) => u.serviceAccountClientId === clientId)
      expect(svcUser).toBeDefined()
      const seedSh = readFileSync(join(DEPLOY_DIR, 'scripts', 'seed.sh'), 'utf8')
      expect(seedSh).toContain(svcUser?.id ?? '<missing>')
    })

    test('every machine principal has a distinct service-account user id (no two principals collide on identity)', () => {
      const ids = machineClientIds.map((clientId) => realm.users?.find((u) => u.serviceAccountClientId === clientId)?.id)
      expect(new Set(ids).size).toBe(machineClientIds.length)
    })
  })

  describe('the four crypto-auth task machine principals (svc-attendance, svc-claims, svc-leave, svc-docs)', () => {
    const cryptoMachineClientIds = ['svc-attendance', 'svc-claims', 'svc-leave', 'svc-docs'] as const

    test.each(cryptoMachineClientIds)('%s is confidential, service accounts on, standard flow off, no secret literal committed', (clientId) => {
      const client = findClient(realm, clientId)
      expect(client.publicClient).toBe(false)
      expect(client.serviceAccountsEnabled).toBe(true)
      expect(client.standardFlowEnabled).toBe(false)
      expect(client.secret).toBeUndefined()
    })

    test.each(cryptoMachineClientIds)("%s's service-account user id is pinned in `users`, distinct from every other principal", (clientId) => {
      const svcUser = realm.users?.find((u) => u.serviceAccountClientId === clientId)
      expect(svcUser).toBeDefined()
      const seedSh = readFileSync(join(DEPLOY_DIR, 'scripts', 'seed.sh'), 'utf8')
      expect(seedSh).toContain(svcUser?.id ?? '<missing>')
    })

    test('every crypto-auth machine principal has a distinct service-account user id, distinct from the S2S auth task ones too', () => {
      const allClientIds = ['svc-onboarding', 'svc-payroll', 'svc-timesheet', 'svc-scheduler', ...cryptoMachineClientIds]
      const ids = allClientIds.map((clientId) => realm.users?.find((u) => u.serviceAccountClientId === clientId)?.id)
      expect(new Set(ids).size).toBe(allClientIds.length)
    })
  })

  test('token lifetimes match Security doc §6 (access token <= 15 min, SSO session <= 12h)', () => {
    expect(realm.accessTokenLifespan).toBeGreaterThan(0)
    expect(realm.accessTokenLifespan).toBeLessThanOrEqual(MAX_ACCESS_TOKEN_LIFESPAN_SEC)
    expect(realm.ssoSessionMaxLifespan).toBeGreaterThan(0)
    expect(realm.ssoSessionMaxLifespan).toBeLessThanOrEqual(MAX_SSO_SESSION_MAX_LIFESPAN_SEC)
  })

  test('refresh token rotation is on (single-use, reuse revokes the session)', () => {
    expect(realm.revokeRefreshToken).toBe(true)
    expect(realm.refreshTokenMaxReuse).toBe(0)
  })

  test('brute-force lockout detection is enabled', () => {
    expect(realm.bruteForceProtected).toBe(true)
  })

  describe('audience mapper — the single most common reason a correctly-configured realm still fails every request', () => {
    let audience: string
    beforeAll(() => {
      audience = readConfiguredAudience()
    })

    test.each([
      'web',
      'seeder',
      'svc-onboarding',
      'svc-payroll',
      'svc-timesheet',
      'svc-scheduler',
      'svc-attendance',
      'svc-claims',
      'svc-leave',
      'svc-docs',
    ] as const)('%s stamps an aud the middleware accepts', (clientId) => {
      const client = findClient(realm, clientId)
      const mapper = client.protocolMappers?.find((m) => m.protocolMapper === 'oidc-audience-mapper')
      expect(mapper).toBeDefined()
      expect(mapper?.config['included.custom.audience']).toBe(audience)
      expect(mapper?.config['access.token.claim']).toBe('true')
    })
  })
})
