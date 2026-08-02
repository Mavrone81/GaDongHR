import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

/**
 * Task 13: the deliverable here is configuration, not code, so this file
 * IS the test suite for `docker-compose.yml` + `docker-compose.prod.yml`
 * (brief §5). It shells out to the real `docker compose config` — the
 * same command `deploy/README.md` tells an operator to run before ever
 * deploying — and asserts against the CANONICAL, fully-merged output,
 * not the source YAML, so an override file that re-adds something the
 * base file removed (or vice versa) is still caught.
 *
 * Requires Docker (with the Compose v2 plugin) on the machine running
 * `pnpm test` — true in this repo's CI (`.github/workflows/ci.yml` runs
 * on `ubuntu-latest`, which ships Docker) and on any dev machine that can
 * run this stack at all.
 */

interface ComposeService {
  container_name?: string
  ports?: unknown[]
  mem_limit?: number | string
  healthcheck?: unknown
  build?: unknown
  image?: string
}

interface ComposeConfig {
  services: Record<string, ComposeService>
}

const DEPLOY_DIR = __dirname

/** Total physical RAM of `gadonghr-prod` (Task 13 brief: "2 vCPU / 4 GB / 80 GB"). */
const TOTAL_HOST_MB = 4096

/**
 * Brief §1: "the total must fit 4 GB with room for the OS." The
 * validation checklist (brief §5) states this as "leaves ≥ 512 MB for the
 * OS" — the floor below, not a target. `deploy/README.md`'s memory
 * budget table documents the actual committed total (3,376 MB, 720 MB of
 * headroom) as a deliberate margin above this floor, not exactly at it.
 */
const MIN_OS_HEADROOM_MB = 512

function runComposeConfig(...files: string[]): ComposeConfig {
  const args = files.flatMap((f) => ['-f', f]).concat(['config', '--format', 'json'])
  const out = execFileSync('docker', ['compose', ...args], { cwd: DEPLOY_DIR, encoding: 'utf8' })
  return JSON.parse(out) as ComposeConfig
}

describe('deploy/docker-compose.yml + docker-compose.prod.yml (merged, canonical)', () => {
  let config: ComposeConfig

  beforeAll(() => {
    config = runComposeConfig('docker-compose.yml', 'docker-compose.prod.yml')
  })

  test('parses cleanly and defines at least the fourteen expected services', () => {
    const names = Object.keys(config.services).sort()
    // The seven platform services that actually exist (brief §1) plus the
    // seven required infra containers (brief: "Also required: traefik,
    // postgres:16, rabbitmq:3.13-management, redis:7, minio, vault:1.17,
    // keycloak:26"). Module services M1-M7 must NOT appear.
    const expected = [
      'keycloak',
      'minio',
      'postgres',
      'rabbitmq',
      'redis',
      'svc-audit',
      'svc-authz',
      'svc-config',
      'svc-crypto',
      'svc-docs',
      'svc-i18n',
      'svc-notify',
      'traefik',
      'vault',
    ]
    expect(names).toEqual(expected)
  })

  test('no service sets container_name (default gadonghr-<service>-<n> naming only)', () => {
    for (const [name, svc] of Object.entries(config.services)) {
      expect([name, svc.container_name]).toEqual([name, undefined])
    }
  })

  test('only traefik publishes host ports', () => {
    for (const [name, svc] of Object.entries(config.services)) {
      const ports = svc.ports ?? []
      if (name === 'traefik') {
        expect(ports.length).toBeGreaterThan(0)
      } else {
        expect([name, ports]).toEqual([name, []])
      }
    }
  })

  test('every service declares a healthcheck', () => {
    for (const [name, svc] of Object.entries(config.services)) {
      expect([name, svc.healthcheck != null]).toEqual([name, true])
    }
  })

  test('every service sets an explicit mem_limit, and the total leaves >=512 MB for the OS', () => {
    let totalBytes = 0
    for (const [name, svc] of Object.entries(config.services)) {
      const limit = Number(svc.mem_limit ?? 0)
      expect([name, limit]).toEqual([name, expect.any(Number)])
      expect(limit).toBeGreaterThan(0)
      totalBytes += limit
    }
    const totalMB = totalBytes / (1024 * 1024)
    const headroomMB = TOTAL_HOST_MB - totalMB
    expect(headroomMB).toBeGreaterThanOrEqual(MIN_OS_HEADROOM_MB)
  })

  test('no service in the prod overlay carries both build and image (never build on the server)', () => {
    for (const [name, svc] of Object.entries(config.services)) {
      if (svc.build != null) {
        expect([name, svc.image]).toEqual([name, undefined])
      }
    }
  })

  test('every one of the seven platform services resolves to a ghcr.io image in the prod merge', () => {
    const platformServices = ['svc-crypto', 'svc-config', 'svc-authz', 'svc-audit', 'svc-i18n', 'svc-notify', 'svc-docs']
    for (const name of platformServices) {
      const svc = config.services[name]
      expect(svc).toBeDefined()
      expect(svc?.image).toMatch(/^ghcr\.io\/mavrone81\/gadonghr-/)
      expect(svc?.build).toBeUndefined()
    }
  })
})

describe('deploy/docker-compose.yml alone (local/dev/CI-build shape)', () => {
  let config: ComposeConfig

  beforeAll(() => {
    config = runComposeConfig('docker-compose.yml')
  })

  test('parses cleanly on its own, without the prod overlay', () => {
    expect(Object.keys(config.services).length).toBeGreaterThan(0)
  })

  test('every one of the seven platform services builds from its own Dockerfile', () => {
    const platformServices = ['svc-crypto', 'svc-config', 'svc-authz', 'svc-audit', 'svc-i18n', 'svc-notify', 'svc-docs']
    for (const name of platformServices) {
      const svc = config.services[name]
      expect(svc?.build).toBeDefined()
      expect(svc?.image).toBeUndefined()
    }
  })
})

describe('deploy scripts are syntactically valid shell', () => {
  const scripts = ['auto-deploy-gadonghr.sh', 'prune-gadonghr-images.sh', 'seed.sh', 'backup.sh']

  test.each(scripts)('%s passes `bash -n`', (script) => {
    const path = join(DEPLOY_DIR, 'scripts', script)
    expect(() => execFileSync('bash', ['-n', path], { encoding: 'utf8' })).not.toThrow()
  })
})
