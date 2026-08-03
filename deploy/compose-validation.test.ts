import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import yaml from 'js-yaml'

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

interface ComposeHealthcheck {
  test?: string[]
}

interface ComposeVolume {
  type?: string
  source?: string
  target?: string
}

interface ComposeService {
  container_name?: string
  ports?: unknown[]
  mem_limit?: number | string
  healthcheck?: ComposeHealthcheck
  build?: unknown
  image?: string
  labels?: Record<string, string>
  security_opt?: string[]
  cap_add?: string[]
  environment?: Record<string, string>
  volumes?: ComposeVolume[]
}

interface ComposeFileSecret {
  file?: string
  name?: string
}

interface ComposeConfig {
  services: Record<string, ComposeService>
  secrets?: Record<string, ComposeFileSecret>
}

/**
 * Task 16f: shape of `traefik/dynamic/routes.yml`, the file-provider
 * dynamic configuration that replaced every `traefik.*` Docker label.
 * Parsed with `js-yaml`, not regex — the file's `Host(\`{{ env
 * "PUBLIC_HOST" }}\`)` rules are plain string content as far as YAML is
 * concerned (Traefik's own Go-templating happens after Traefik reads the
 * file, never something `js-yaml` needs to understand), so a real parser
 * is both correct and no harder than a hand-rolled one here.
 */
interface TraefikRouter {
  rule?: string
  priority?: number
  service?: string
  middlewares?: string[]
  tls?: { certResolver?: string }
}

interface TraefikServiceBackend {
  loadBalancer?: { servers?: { url?: string }[] }
}

interface TraefikDynamicConfig {
  http?: {
    routers?: Record<string, TraefikRouter>
    services?: Record<string, TraefikServiceBackend>
    middlewares?: Record<string, unknown>
  }
}

interface UiCoverageRoute {
  service: string
  exempt?: string
}

interface UiCoverage {
  routes: UiCoverageRoute[]
}

const DEPLOY_DIR = __dirname

function loadTraefikDynamicConfig(): TraefikDynamicConfig {
  const raw = readFileSync(join(DEPLOY_DIR, 'traefik', 'dynamic', 'routes.yml'), 'utf8')
  return yaml.load(raw) as TraefikDynamicConfig
}

function loadUiCoverage(): UiCoverage {
  const raw = readFileSync(join(DEPLOY_DIR, '..', 'web', 'ui-coverage.json'), 'utf8')
  return JSON.parse(raw) as UiCoverage
}

/**
 * Every compose-service hostname actually reachable by following a
 * router's `service:` to its backend's `loadBalancer.servers[].url` — the
 * thing `Host()`/`PathPrefix()` rules actually resolve to once Traefik
 * matches a request. Used both to prove routers point at real compose
 * services and, in reverse, to prove every service that NEEDS a public
 * path has one.
 */
function routedBackendHosts(dynamicConfig: TraefikDynamicConfig): Set<string> {
  const routers = dynamicConfig.http?.routers ?? {}
  const services = dynamicConfig.http?.services ?? {}
  const hosts = new Set<string>()
  for (const router of Object.values(routers)) {
    const backend = router.service ? services[router.service] : undefined
    for (const server of backend?.loadBalancer?.servers ?? []) {
      try {
        hosts.add(new URL(server.url ?? '').hostname)
      } catch {
        // Malformed URL — deliberately not added, so a typo'd backend
        // fails the "resolves to a real compose service" assertion
        // below instead of silently vanishing here.
      }
    }
  }
  return hosts
}

/**
 * A ui-coverage.json route is reachable from a browser only if it is a
 * real screen (no `exempt` at all) or explicitly `consumed-not-displayed`
 * (still fetched by the browser over HTTP, just not its own screen — e.g.
 * `svc-i18n`'s `bundles/:locale`, fetched by the login screen before any
 * screen has rendered). The other two `exempt` values are both
 * explicitly NOT browser traffic, by their own `reason` text in
 * ui-coverage.json: `service-to-service` (internal-only, called by
 * `@gadong/kernel`'s `PermissionGuard`/`AuthzClient`/`CryptoClient` over
 * the compose network) and `operational` ("consumed by compose, the
 * deploy script and monitoring, not a browser" — every `/health` route).
 * Getting this wrong in the permissive direction would have wrongly
 * demanded a public router for `svc-crypto` (whose only routes are
 * `service-to-service` `encrypt`/`decrypt`/`bidx` plus an `operational`
 * `health` — none ever reach Traefik).
 */
function browserReachableServices(uiCoverage: UiCoverage): Set<string> {
  return new Set(
    uiCoverage.routes
      .filter((r) => r.exempt === undefined || r.exempt === 'consumed-not-displayed')
      .map((r) => r.service),
  )
}

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

  // Task 16f: the assertion that stops the PWA swallowing `/api/*` (`web`
  // is the catch-all `Host()` router at the domain root — it must always
  // sit at a lower priority than every `/api/*` router or the browser's
  // API calls would be served `index.html` instead of JSON) used to live
  // here, reading `traefik.*` Docker labels directly off these services.
  // Routing moved to Traefik's file provider (`traefik/dynamic/routes.yml`)
  // and the labels are gone — see the
  // `Traefik file-provider dynamic routing (Task 16f)` describe block
  // below, which asserts the same thing (and more) against that file
  // instead.

  test('no compose service still carries a `traefik.*` Docker label (routing moved to the file provider — Task 16f)', () => {
    for (const [name, svc] of Object.entries(config.services)) {
      const traefikLabelKeys = Object.keys(svc.labels ?? {}).filter((k) => k.startsWith('traefik.'))
      expect([name, traefikLabelKeys]).toEqual([name, []])
    }
  })

  test('traefik no longer mounts /var/run/docker.sock (Task 16f — the Docker provider that read it is gone)', () => {
    const traefik = config.services.traefik
    expect(traefik).toBeDefined()
    const socketMounts = (traefik?.volumes ?? []).filter(
      (v) => v.source?.includes('docker.sock') || v.target?.includes('docker.sock'),
    )
    expect(socketMounts).toEqual([])
  })

  /**
   * Task 16b: the general form of the Redis healthcheck bug — a
   * healthcheck's `test` command referencing a shell variable that is
   * never actually in the container's own `environment` block always
   * authenticates/operates with an EMPTY value for it, which for
   * `redis-cli -a $$REDIS_PASSWORD` means "authenticate with an empty
   * password" against a server that requires a real one, forever
   * `WRONGPASS`, even though the underlying process is healthy. `docker
   * compose config` fully resolves any single-`$`/`${...}` reference at
   * CONFIG time (see e.g. `postgres`'s healthcheck, which config
   * substitutes down to a literal `-U gadong_admin`) — so any `$name`
   * pattern still present in the MERGED config's `healthcheck.test` is,
   * by construction, a `$$`-escaped reference Compose deliberately left
   * for the CONTAINER's own shell to resolve at runtime. That variable
   * must therefore exist in this same service's `environment` block, or
   * it resolves to nothing at runtime, exactly like `REDIS_PASSWORD` did.
   */
  test('every service whose healthcheck references a shell variable declares it in `environment`', () => {
    const shellVarPattern = /\$\$?\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g

    function referencedVars(test: string[] | undefined): string[] {
      if (!test) return []
      const found = new Set<string>()
      for (const part of test) {
        for (const m of part.matchAll(shellVarPattern)) {
          if (m[1]) found.add(m[1])
        }
      }
      return [...found]
    }

    let sawAtLeastOneReference = false
    for (const [name, svc] of Object.entries(config.services)) {
      const referenced = referencedVars(svc.healthcheck?.test)
      const envKeys = Object.keys(svc.environment ?? {})
      for (const varName of referenced) {
        sawAtLeastOneReference = true
        expect([name, varName, envKeys.includes(varName)]).toEqual([name, varName, true])
      }
    }
    // If this ever went to zero, every assertion above would be vacuously
    // true and the test would be worthless — `redis` is expected to
    // always be the (at least) one service exercising this path.
    expect(sawAtLeastOneReference).toBe(true)
  })
})

/**
 * Task 16f: Traefik's Docker provider can never work on this host (Docker
 * 29.6's minimum API version is 1.40; Traefik's bundled client pins 1.24 —
 * verified across four live attempts, see traefik/traefik.yml's header).
 * With the provider permanently failing, Traefik discovered zero
 * containers and had zero routers — every request 404'd. Fixed by
 * replacing the Docker provider with the file provider
 * (`traefik/dynamic/routes.yml`), which also lets `/var/run/docker.sock`
 * come off the `traefik` service entirely (a real reduction in attack
 * surface for an edge-facing proxy, not just a bug fix).
 *
 * This suite parses `routes.yml` for real (via `js-yaml`, not regex) and
 * cross-checks it against the merged `docker compose config` output AND
 * `web/ui-coverage.json` — nothing here is a hard-coded list of router
 * names, so a future service added to one side without the other still
 * fails loudly.
 */
describe('Traefik file-provider dynamic routing (Task 16f)', () => {
  let composeConfig: ComposeConfig
  let dynamicConfig: TraefikDynamicConfig
  let uiCoverage: UiCoverage

  beforeAll(() => {
    composeConfig = runComposeConfig('docker-compose.yml', 'docker-compose.prod.yml')
    dynamicConfig = loadTraefikDynamicConfig()
    uiCoverage = loadUiCoverage()
  })

  test('routes.yml parses to at least one router, one service, and one middleware (otherwise this suite is vacuous)', () => {
    expect(Object.keys(dynamicConfig.http?.routers ?? {}).length).toBeGreaterThan(0)
    expect(Object.keys(dynamicConfig.http?.services ?? {}).length).toBeGreaterThan(0)
    expect(Object.keys(dynamicConfig.http?.middlewares ?? {}).length).toBeGreaterThan(0)
  })

  /**
   * The router-vs-backend assertion (brief: "Demonstrate at least the
   * router-vs-backend assertion failing before it passes" — see
   * task-16f-traefik-report.md for the RED run this produced against a
   * deliberately broken `routes.yml`). Every router must name a `service:`
   * that is actually defined in `routes.yml`'s own `http.services` map,
   * and every one of THAT backend's server URLs must resolve — by
   * hostname, not by name-matching the router — to a real compose service
   * name. This is what actually catches "two sources of truth diverged":
   * a router pointing at a backend that was renamed/removed, or a backend
   * URL with a typo'd or stale compose service name, would both 404/502
   * in production but parse "successfully" as YAML — neither is caught by
   * anything that doesn't cross-reference `docker compose config`.
   */
  test('every router names a backend that exists in routes.yml, and every backend URL host resolves to a real compose service', () => {
    const routers = dynamicConfig.http?.routers ?? {}
    const services = dynamicConfig.http?.services ?? {}
    const composeServiceNames = new Set(Object.keys(composeConfig.services))

    expect(Object.keys(routers).length).toBeGreaterThan(0)

    for (const [routerName, router] of Object.entries(routers)) {
      expect([routerName, router.service]).toEqual([routerName, expect.any(String)])

      const backend = router.service ? services[router.service] : undefined
      expect([routerName, router.service, backend]).toEqual([routerName, router.service, expect.anything()])

      const servers = backend?.loadBalancer?.servers ?? []
      expect([routerName, servers.length > 0]).toEqual([routerName, true])

      for (const server of servers) {
        const url = server.url ?? ''
        let host = ''
        expect(() => {
          host = new URL(url).hostname
        }).not.toThrow()
        expect([routerName, url, composeServiceNames.has(host)]).toEqual([routerName, url, true])
      }
    }
  })

  test('every API router (PathPrefix `/api/...`) has a priority strictly greater than the `web` catch-all router', () => {
    const routers = dynamicConfig.http?.routers ?? {}
    const webRouter = routers.web
    expect(webRouter).toBeDefined()
    expect(webRouter?.priority).toEqual(expect.any(Number))
    const webPriority = Number(webRouter?.priority)

    const apiRouterEntries = Object.entries(routers).filter(([, r]) => /PathPrefix\(`\/api\//.test(r.rule ?? ''))
    // Not vacuous: this repo has six such services today.
    expect(apiRouterEntries.length).toBeGreaterThan(0)

    for (const [name, router] of apiRouterEntries) {
      expect([name, router.priority]).toEqual([name, expect.any(Number)])
      expect([name, Number(router.priority) > webPriority]).toEqual([name, true])
    }
  })

  test('every compose platform service with a browser-reachable route in ui-coverage.json has a router routing to it', () => {
    const reachable = browserReachableServices(uiCoverage)
    const composeServiceNames = Object.keys(composeConfig.services)

    // Derived from ui-coverage.json + docker-compose.yml, not hard-coded —
    // ui-coverage.json also lists services from later phases
    // (svc-attendance, svc-payroll, ...) that are not compose services
    // yet; only the intersection is a real requirement today.
    const platformServicesNeedingRouters = composeServiceNames.filter(
      (name) => name.startsWith('svc-') && reachable.has(name),
    )
    expect(platformServicesNeedingRouters.length).toBeGreaterThan(0)

    const hosts = routedBackendHosts(dynamicConfig)
    for (const name of platformServicesNeedingRouters) {
      expect([name, hosts.has(name)]).toEqual([name, true])
    }

    // `web` (the PWA itself) never appears in ui-coverage.json — that
    // file enumerates API endpoints, not the SPA shell — but it is
    // obviously browser-reachable and must not be skipped just because it
    // has no ui-coverage.json entry to derive itself from.
    expect(hosts.has('web')).toBe(true)
  })

  test('every platform service with NO browser-reachable ui-coverage.json route correctly has no router (no dead / unused routes)', () => {
    const reachable = browserReachableServices(uiCoverage)
    const composeServiceNames = Object.keys(composeConfig.services)
    const platformServicesWithNoPublicRoute = composeServiceNames.filter(
      (name) => name.startsWith('svc-') && !reachable.has(name),
    )
    // Not vacuous: svc-crypto is expected to land here today (Vault HTTP
    // client only, called server-side over the internal network — see
    // deploy/README.md's Traefik routing section).
    expect(platformServicesWithNoPublicRoute.length).toBeGreaterThan(0)

    const hosts = routedBackendHosts(dynamicConfig)
    for (const name of platformServicesWithNoPublicRoute) {
      expect([name, hosts.has(name)]).toEqual([name, false])
    }
  })

  test('keycloak has a router (the `/auth` path, not derived from ui-coverage.json — Keycloak is not a @gadong service)', () => {
    const hosts = routedBackendHosts(dynamicConfig)
    expect(hosts.has('keycloak')).toBe(true)
  })
})

/**
 * Task 16b: the actual bug — `svc-crypto` could not read
 * `/run/secrets/vault_approle_secret` because Compose's file-sourced
 * `secrets:` bind-mounts the HOST file into the container with the HOST's
 * own ownership preserved verbatim, and the correct, least-privilege host
 * permission (`-rw------- root:root`) is unreadable by the container's
 * `node` (uid 1000) process. The Compose *spec* documents a per-service
 * `uid`/`gid`/`mode` on a `secrets:` entry that would remount the secret
 * under different ownership without ever touching the host file — but
 * this was verified empirically against the actual engine in use here
 * (Docker Compose, non-Swarm `docker compose up`/`run` — this repo has no
 * `deploy:`/`docker stack deploy` anywhere), which prints "secrets `uid`,
 * `gid` and `mode` are not supported, they will be ignored" and mounts
 * with the host owner unchanged regardless. So every file-sourced secret
 * must instead have its ownership enforced by the deploy script itself,
 * every run — `scripts/auto-deploy-gadonghr.sh`'s "Ensure secret file
 * ownership" step — or a fresh host reproduces the exact EACCES
 * crash-loop this task fixed, waiting on a human to remember a manual
 * `chown`. This test asserts that enforcement exists for EVERY
 * file-sourced secret the compose files declare, not just the one known
 * today, and that it runs before `compose up -d` (an enforcement step
 * that ran only after the container already started reading the file
 * would be too late).
 */
describe('every file-sourced Compose secret has its host ownership enforced, not left to luck (Task 16b)', () => {
  let config: ComposeConfig
  let deployScript: string

  beforeAll(() => {
    config = runComposeConfig('docker-compose.yml', 'docker-compose.prod.yml')
    deployScript = readFileSync(join(DEPLOY_DIR, 'scripts', 'auto-deploy-gadonghr.sh'), 'utf8')
  })

  test('at least one file-sourced secret exists (otherwise this suite is vacuous)', () => {
    const fileSecrets = Object.entries(config.secrets ?? {}).filter(([, s]) => typeof s.file === 'string')
    expect(fileSecrets.length).toBeGreaterThan(0)
  })

  test('every file-sourced secret is chown/chmod-enforced by the deploy script before `up -d`', () => {
    const fileSecrets = Object.entries(config.secrets ?? {}).filter(([, s]) => typeof s.file === 'string')
    const upIndex = deployScript.search(/compose\s+up\s+-d/)
    expect(upIndex).toBeGreaterThan(-1)

    for (const [secretName] of fileSecrets) {
      const lines = deployScript.split('\n').filter((l) => l.includes(`secrets/${secretName}`))
      const hasChown = lines.some((l) => /chown\s+1000:1000/.test(l))
      const hasChmod = lines.some((l) => /chmod\s+600\b/.test(l))
      expect([secretName, hasChown, hasChmod]).toEqual([secretName, true, true])

      // Ordering: the enforcement must appear before `compose up -d` in
      // the script's source, or the container may already have started
      // reading the (still wrongly-owned) file by the time it runs.
      const enforceIndex = deployScript.indexOf(`secrets/${secretName}`)
      expect(enforceIndex).toBeGreaterThan(-1)
      expect(enforceIndex).toBeLessThan(upIndex)
    }
  })
})

/**
 * Task 16: the actual bug that blocked a live deploy was two files
 * disagreeing with nothing ever reading both — `vault.hcl`'s
 * `disable_mlock` setting and `docker-compose.yml`'s `security_opt`/
 * `cap_add` for the `vault` service made mutually exclusive promises
 * (mlock enabled + `no-new-privileges` blocking the only mechanism that
 * could ever grant CAP_IPC_LOCK to the non-root `vault` process). This
 * suite parses BOTH sources — `vault.hcl` directly, and the merged,
 * canonical `docker compose config` output, the same thing
 * `runComposeConfig` above reads — so a future edit to either file that
 * reintroduces the conflict is caught here, not on a droplet.
 */
describe('vault.hcl and docker-compose.yml agree on mlock / no-new-privileges', () => {
  let config: ComposeConfig
  let vaultHclSource: string

  beforeAll(() => {
    config = runComposeConfig('docker-compose.yml', 'docker-compose.prod.yml')
    vaultHclSource = readFileSync(join(DEPLOY_DIR, 'vault', 'vault.hcl'), 'utf8')
  })

  /**
   * Parses the live `disable_mlock` value out of `vault.hcl`, ignoring
   * comment lines (`#...`) — a naive substring search would match the
   * word inside this very file's own explanatory comments above the real
   * setting.
   */
  function parseDisableMlock(source: string): boolean {
    const uncommented = source
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n')
    const match = uncommented.match(/disable_mlock\s*=\s*(true|false)/)
    if (!match?.[1]) {
      throw new Error('vault.hcl does not set disable_mlock at all — expected an explicit true or false')
    }
    return match[1] === 'true'
  }

  test('vault.hcl sets disable_mlock exactly once, outside of comments', () => {
    const uncommented = vaultHclSource
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n')
    const matches = [...uncommented.matchAll(/disable_mlock\s*=\s*(true|false)/g)]
    expect(matches.length).toBe(1)
  })

  test('vault\'s merged security_opt / cap_add are consistent with vault.hcl\'s disable_mlock', () => {
    const disableMlock = parseDisableMlock(vaultHclSource)
    const vault = config.services.vault
    expect(vault).toBeDefined()
    const securityOpt = vault?.security_opt ?? []
    const capAdd = vault?.cap_add ?? []
    const noNewPrivileges = securityOpt.includes('no-new-privileges:true')
    const hasIpcLock = capAdd.includes('IPC_LOCK')

    if (!disableMlock) {
      // mlock is ON (disable_mlock = false): the non-root `vault` process
      // MUST be able to actually acquire CAP_IPC_LOCK at its su-exec, or
      // Vault crash-loops with "Failed to lock memory... please enable
      // mlock or set disable_mlock" — the exact failure this task fixed.
      // That requires BOTH the capability to be granted AND
      // `no-new-privileges` to be absent (file capabilities are not
      // honoured at execve() once no_new_privs is set — the mechanism
      // that defeated this on the droplet).
      expect([disableMlock, hasIpcLock]).toEqual([disableMlock, true])
      expect([disableMlock, noNewPrivileges]).toEqual([disableMlock, false])
    } else {
      // mlock is OFF (disable_mlock = true, this file's actual decision —
      // see vault.hcl's comment for the trade-off): vault no longer needs
      // CAP_IPC_LOCK at all, so it must not be granted (least privilege —
      // an unused capability on the service holding every unseal key is
      // pure downside), and there is no reason for `vault` to be
      // exempted from the same hardening every other service carries.
      expect([disableMlock, hasIpcLock]).toEqual([disableMlock, false])
      expect([disableMlock, noNewPrivileges]).toEqual([disableMlock, true])
    }
  })

  /**
   * The merge-vs-replace trap that defeated the droplet attempt: Compose
   * merges list values (`security_opt`) from an override rather than
   * replacing them, so a per-service `security_opt: []` silently does
   * nothing. This reads the REAL merged output (not the source YAML) for
   * every service, so it would fail immediately if `vault` (or anything
   * else) ever lost `no-new-privileges` without an explicit, effective
   * `!override`/`!reset` — and it proves the exception did not spread:
   * every service in the stack, `vault` included under this task's chosen
   * design, still carries it.
   */
  test('every service in the merged config carries no-new-privileges:true — no silent exception', () => {
    for (const [name, svc] of Object.entries(config.services)) {
      expect([name, svc.security_opt ?? []]).toEqual([name, ['no-new-privileges:true']])
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

/**
 * Task 16b: the actual bug — every schema-owning service's own migration
 * unconditionally re-issues `CREATE SCHEMA IF NOT EXISTS "<schema>"` at
 * every boot (over the same `DATABASE_URL` the runtime pool then reuses),
 * and Postgres evaluates the CREATE privilege on the DATABASE before ever
 * reaching the `IF NOT EXISTS` short-circuit — an already-existing schema
 * does not save you. `01-roles.sql` fixes this with one `GRANT CREATE ON
 * DATABASE` per role, but the defect that shipped past a green suite
 * BEFORE this task was never "the grant is wrong", it was "the grant
 * doesn't exist at all, for any of the twelve" — so what this must catch
 * is a FUTURE partial fix (eleven roles granted, one quietly missed) just
 * as much as total absence. Hard-coding the expected list of twelve names
 * here would defeat that purpose (a test that lists the same twelve names
 * the SQL file lists proves nothing) — the expected set is derived
 * instead from `docs/superpowers/plans/00-PROGRAM-ROADMAP.md`'s own
 * "Service inventory" table (`Schema` column), the single canonical
 * source `01-roles.sql`'s own header comment already points at ("Twelve
 * business schemas (roadmap Database conventions ...)").
 */
describe('deploy/postgres/init/01-roles.sql grants CREATE ON DATABASE to every roadmap schema role (Task 16b)', () => {
  const roadmapSource = readFileSync(
    join(DEPLOY_DIR, '..', 'docs', 'superpowers', 'plans', '00-PROGRAM-ROADMAP.md'),
    'utf8',
  )
  const sqlSource = readFileSync(join(DEPLOY_DIR, 'postgres', 'init', '01-roles.sql'), 'utf8')

  /**
   * Pulls every `Schema` cell out of the roadmap's "Service inventory"
   * markdown table (stops at the next `##` heading) — a cell is only
   * counted if it is backtick-quoted (` `config` `, not the bare `—` used
   * for the services that own no schema), so `svc-crypto`, `svc-i18n`,
   * `web`, `retention-job`, and `@gadong/kernel` are excluded exactly as
   * the table itself excludes them, not by name-matching.
   */
  function extractRoadmapSchemas(source: string): string[] {
    const tableSection = source.split('## Service inventory')[1]?.split(/\n## /)[0] ?? ''
    const rows = tableSection.split('\n').filter((l) => l.trim().startsWith('|'))
    const schemas: string[] = []
    for (const row of rows) {
      const cells = row.split('|').map((c) => c.trim())
      const schemaCell = cells[3]
      const match = schemaCell?.match(/`([\w-]+)`/)
      if (match?.[1]) schemas.push(match[1])
    }
    return schemas
  }

  /** Every `GRANT CREATE ON DATABASE ... TO <role>;` in the SQL source. */
  function extractGrantedRoles(source: string): string[] {
    const pattern = /GRANT\s+CREATE\s+ON\s+DATABASE\s+\S+\s+TO\s+(\w+)\s*;/gi
    return [...source.matchAll(pattern)].map((m) => m[1]).filter((r): r is string => Boolean(r))
  }

  const expectedRoles = extractRoadmapSchemas(roadmapSource).sort()
  const grantedRoles = extractGrantedRoles(sqlSource).sort()

  test('the roadmap table yields a non-empty schema list (otherwise this suite is vacuous)', () => {
    expect(expectedRoles.length).toBeGreaterThan(0)
  })

  test('01-roles.sql contains at least one GRANT CREATE ON DATABASE statement', () => {
    expect(grantedRoles.length).toBeGreaterThan(0)
  })

  test('every roadmap schema role — no subset, no extra — is granted CREATE ON DATABASE', () => {
    expect(grantedRoles).toEqual(expectedRoles)
  })

  test('each GRANT CREATE ON DATABASE statement names the database via the POSTGRES_DB env var, not a literal', () => {
    // Guards against a future edit hard-coding a database name (e.g.
    // `GRANT CREATE ON DATABASE gadonghr TO ...`) that would silently
    // diverge from whatever `POSTGRES_DB` is actually set to in `.env`.
    const literalDbGrants = [...sqlSource.matchAll(/GRANT\s+CREATE\s+ON\s+DATABASE\s+(\S+)\s+TO\s+\w+\s*;/gi)].filter(
      (m) => m[1] !== ':"gadong_db"',
    )
    expect(literalDbGrants).toEqual([])
  })
})
