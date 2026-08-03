import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
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
  labels?: Record<string, string>
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

  test('parses cleanly and defines at least the fifteen expected services', () => {
    const names = Object.keys(config.services).sort()
    // The seven platform services that actually exist (brief §1) plus the
    // seven required infra containers (brief: "Also required: traefik,
    // postgres:16, rabbitmq:3.13-management, redis:7, minio, vault:1.17,
    // keycloak:26"), plus `web` (Task 15c: the PWA is now wired in so
    // `hr.bevorasg.com` actually serves a UI). Module services M1-M7 must
    // still NOT appear.
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
      'web',
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

  // Task 15c: `web` is reachable only through Traefik, same as every
  // other service in this file — it must NOT publish its own host port,
  // and exactly one service (traefik) may publish any at all. This is a
  // narrower, explicit restatement of the loop above, specifically so a
  // future service (including `web`) that accidentally adds `ports:` is
  // caught by name, not just by the generic loop.
  test('exactly one service (traefik) publishes ports, and web does not', () => {
    const publishers = Object.entries(config.services).filter(([, svc]) => (svc.ports ?? []).length > 0)
    expect(publishers.map(([name]) => name)).toEqual(['traefik'])
    expect(config.services.web?.ports ?? []).toEqual([])
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

  // Task 15c: `web` is the PWA that makes `hr.bevorasg.com` serve an
  // actual UI. It must resolve to a real ghcr.io image (never `build:` in
  // the prod merge, same contract as the seven platform services above),
  // carry an explicit `mem_limit` (already proven non-zero by the
  // memory-total test above, but asserted by name here so a future
  // refactor of that loop can't silently stop covering `web`), and
  // declare a healthcheck (it has no `/health` endpoint — see
  // web/Dockerfile's header — so this is necessarily a plain HTTP probe
  // of the index page, not the `x-http-health` anchor the Node services
  // share, but it must still exist).
  test('web resolves to a ghcr.io image, with an explicit mem_limit and a healthcheck', () => {
    const web = config.services.web
    expect(web).toBeDefined()
    expect(web?.image).toMatch(/^ghcr\.io\/mavrone81\/gadonghr-web:/)
    expect(web?.build).toBeUndefined()
    expect(Number(web?.mem_limit ?? 0)).toBeGreaterThan(0)
    expect(web?.healthcheck != null).toBe(true)
  })

  /**
   * Task 15c: the assertion that stops the PWA swallowing `/api/*`. `web`
   * is the catch-all `Host(\`${PUBLIC_HOST}\`)` router at the domain
   * root — if it were ever evaluated before an API service's own
   * `PathPrefix(\`/api/...\`)` router, every API call the browser makes
   * would be served the SPA's `index.html` instead of JSON. That failure
   * mode is silent at the container level (every container reports
   * healthy — `web` IS correctly serving the domain root) and only shows
   * up as "the UI loads but nothing on it ever loads" — exactly the
   * regression this test exists to catch before it reaches
   * `hr.bevorasg.com`.
   */
  test('every API service has a router priority higher than web’s', () => {
    const routerPriority = (svc: ComposeService | undefined, router: string): number => {
      const raw = svc?.labels?.[`traefik.http.routers.${router}.priority`]
      expect(raw).toBeDefined()
      return Number(raw)
    }

    const webPriority = routerPriority(config.services.web, 'web')

    const apiServices = ['svc-config', 'svc-authz', 'svc-audit', 'svc-i18n', 'svc-notify', 'svc-docs']
    for (const name of apiServices) {
      const svc = config.services[name]
      expect(svc).toBeDefined()
      expect(svc?.labels?.['traefik.enable']).toBe('true')
      const rule = svc?.labels?.[`traefik.http.routers.${name}.rule`]
      expect(rule).toBeDefined()
      expect(rule).toMatch(/PathPrefix/)
      const priority = routerPriority(svc, name)
      expect(priority).toBeGreaterThan(webPriority)
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

  // Task 15c: web/Dockerfile, same local/dev/CI-build contract as the
  // seven platform services above — never `image:` here, only in the
  // prod overlay.
  test('web builds from its own Dockerfile', () => {
    const svc = config.services.web
    expect(svc?.build).toBeDefined()
    expect(svc?.image).toBeUndefined()
  })
})

describe('deploy scripts are syntactically valid shell', () => {
  const scripts = ['auto-deploy-gadonghr.sh', 'prune-gadonghr-images.sh', 'seed.sh', 'backup.sh']

  test.each(scripts)('%s passes `bash -n`', (script) => {
    const path = join(DEPLOY_DIR, 'scripts', script)
    expect(() => execFileSync('bash', ['-n', path], { encoding: 'utf8' })).not.toThrow()
  })
})

/**
 * Task 15e: every `ghcr.io/mavrone81/*` image tag must be pinned by the
 * SAME variable, defaulting to a tag CI actually publishes. This exists
 * because Task 15 pinned the seven platform services with
 * `${GADONG_BUILD_SHA:-latest}` while `web` alone used
 * `${GADONG_VERSION:-main}` — `GADONG_BUILD_SHA` is a build-time-only
 * `docker build --build-arg` (never set at deploy time, never in `.env`),
 * so all seven fell through to `:latest`, a tag
 * `.github/workflows/ci.yml`'s `build-images` matrix never pushes (it
 * only ever pushes `:<sha>` and `:main`) — and the `docker compose pull`
 * that `auto-deploy-gadonghr.sh` runs 404'd on the production droplet.
 *
 * `runComposeConfig` (used by the describe blocks above) is the wrong
 * tool here: `docker compose config` substitutes `${VAR:-default}` with a
 * live value and destroys both the variable's name and its static
 * fallback, which is exactly what this needs to inspect. So this section
 * reads docker-compose.prod.yml's raw source instead.
 */
describe('deploy/docker-compose.prod.yml image tag variables (raw source, cross-checked against ci.yml)', () => {
  const composeSource = readFileSync(join(DEPLOY_DIR, 'docker-compose.prod.yml'), 'utf8')
  const ciSource = readFileSync(join(DEPLOY_DIR, '..', '.github', 'workflows', 'ci.yml'), 'utf8')

  interface ImageRef {
    service: string
    variable: string
    fallback: string
  }

  // Matches e.g. `image: ghcr.io/mavrone81/gadonghr-svc-crypto:${GADONG_VERSION:-main}`.
  const imageRefPattern = /image:\s*ghcr\.io\/mavrone81\/gadonghr-([\w-]+):\$\{(\w+):-([\w.-]+)\}/g

  function extractImageRefs(source: string): ImageRef[] {
    return [...source.matchAll(imageRefPattern)].map((m) => {
      const [, service, variable, fallback] = m
      if (!service || !variable || !fallback) {
        throw new Error(`image-ref regex matched but a capture group was empty: ${m[0]}`)
      }
      return { service, variable, fallback }
    })
  }

  const refs = extractImageRefs(composeSource)

  test('finds a ${VAR:-fallback} image reference for all eight ghcr.io/mavrone81 services', () => {
    // Seven platform services + web. If this count is wrong, every test
    // below is vacuous, so it is asserted on its own first.
    expect(refs.map((r) => r.service).sort()).toEqual(
      ['svc-audit', 'svc-authz', 'svc-config', 'svc-crypto', 'svc-docs', 'svc-i18n', 'svc-notify', 'web'].sort(),
    )
  })

  test('every ghcr.io/mavrone81 image reference is pinned by the SAME variable', () => {
    // Derived from the file, not hard-coded: a test that asserted
    // `=== 'GADONG_VERSION'` would have passed on the original bug just as
    // easily as a test that asserted `=== 'GADONG_BUILD_SHA'` — the actual
    // defect was TWO variables coexisting for one job, so what must be
    // asserted is that the derived set of variables in use has exactly one
    // member, whatever its name.
    const variablesUsed = new Set(refs.map((r) => r.variable))
    if (variablesUsed.size !== 1) {
      const bySvc = refs.map((r) => `${r.service}=\${${r.variable}}`).join(', ')
      throw new Error(
        `expected exactly one image-tag variable across all ghcr.io/mavrone81 services, ` +
          `found ${variablesUsed.size} (${[...variablesUsed].join(', ')}): ${bySvc}`,
      )
    }
    expect(variablesUsed.size).toBe(1)
  })

  test('no ghcr.io/mavrone81 image tag defaults to `latest`', () => {
    // CI's build-images matrix (asserted below) never pushes a `:latest`
    // tag, so any service whose fallback is `latest` is guaranteed to 404
    // on `docker compose pull` the moment its variable is unset.
    for (const ref of refs) {
      expect([ref.service, ref.fallback]).not.toEqual([ref.service, 'latest'])
    }
  })

  test('the compose fallback tag is one CI actually publishes (cross-checked against ci.yml)', () => {
    // The only literal (non-templated) tag CI's `build-images` matrix
    // pushes for `ghcr.io/mavrone81/gadonghr-*` images — `${{ github.sha }}`
    // is excluded because it is a CI-runtime expression, not a static
    // string a compose fallback could ever equal.
    const ciTagPattern = /ghcr\.io\/mavrone81\/gadonghr-\$\{\{\s*matrix\.name\s*\}\}:(\S+)/g
    const ciTags = [...ciSource.matchAll(ciTagPattern)]
      .map((m) => m[1] ?? '')
      .filter((tag) => tag.length > 0 && !tag.includes('${{'))
    expect(ciTags.length).toBeGreaterThan(0)
    expect(ciTags).not.toContain('latest')

    for (const ref of refs) {
      if (!ciTags.includes(ref.fallback)) {
        throw new Error(
          `${ref.service}'s fallback tag ':-${ref.fallback}' is not among the tags CI publishes (${ciTags.join(', ')})`,
        )
      }
    }
  })
})
