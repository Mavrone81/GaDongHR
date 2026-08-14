import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * **One way to mount the guard, and a named list of the services that
 * cannot** (integration reconciliation, 2026-08-04).
 *
 * Before this gate, `PermissionGuard` was mounted three different ways
 * across the fifteen services: as a global `APP_GUARD` (ten services), as a
 * per-controller `@UseGuards(PermissionGuard)` (svc-attendance), and as a
 * per-method `@UseGuards(PermissionGuard)` (svc-authz, svc-attendance's
 * punch routes). All three were individually correct. Only one of them
 * fails safe.
 *
 * The per-controller and per-route patterns share a single failure mode,
 * and it is not theoretical: **a controller added to that service later
 * inherits nothing.** It ships with no permission check, serves every
 * caller, and no test fails — because there is no test that can fail. The
 * route is present, the service is healthy, the guard is doing exactly what
 * it was told to do, which is guard the other controllers. A global
 * `APP_GUARD` inverts that: a route with neither `@RequirePermission` nor
 * `@Public()` throws AUZ-403 (`guard.ts`'s `noPermissionDeclaredError`)
 * rather than serving, so forgetting to decide is a loud failure instead of
 * a silent grant.
 *
 * So the standard pattern is `{ provide: APP_GUARD, useClass:
 * PermissionGuard }` plus `@Public()` where a route is genuinely
 * unauthenticated, and this test asserts it for every service that has a
 * Nest module — with the exceptions named, reasoned, and enumerated below
 * rather than inferred. A new service that copies the wrong pattern is not
 * silently accepted: it is neither in `STANDARD_PATTERN_EXCEPTIONS` nor
 * mounting `APP_GUARD`, so the first assertion names it.
 *
 * Two further assertions cover what mounting alone cannot:
 *
 *  - For every STANDARD service, every route must declare
 *    `@RequirePermission` or `@Public()`. Mounting the global guard makes an
 *    undecorated route fail at RUNTIME; this makes it fail at BUILD time.
 *    This is the assertion that would have caught the live svc-scheduler
 *    defect this reconciliation fixed — M2 mounted `APP_GUARD` when it added
 *    its rostering controllers but left the pre-existing `GET /health`
 *    carrying neither decorator, so the health check that compose, the
 *    deploy script and monitoring all call returned AUZ-403. The
 *    `@Public()`-marker audit next door could not see it (a route that is
 *    neither public nor guarded has no marker to compare), and the
 *    controller's unit test calls `health()` directly, which never runs a
 *    guard.
 *  - For every EXCEPTION service that still guards anything per-route, every
 *    route must carry `@UseGuards(PermissionGuard)` or appear in that
 *    service's explicit allowlist. That is what closes the "new controller
 *    ships unguarded" hole for the one service that genuinely keeps the
 *    per-route pattern.
 *
 * Regex-based rather than a TypeScript parser, matching the deliberate
 * trade-off in `public-routes.audit.test.ts` and `web/ui-coverage.test.ts`
 * next door — the decorator conventions here are followed uniformly across
 * every controller in this codebase, and a route declared some other way
 * should fail loudly here rather than be silently skipped.
 */

const REPO_ROOT = join(__dirname, '..', '..', '..', '..')
const SERVICES_DIR = join(REPO_ROOT, 'services')

const HTTP_METHODS = ['Get', 'Post', 'Put', 'Patch', 'Delete'] as const

/** The canonical registration. `guard.ts`'s own doc comment shows this exact line as the way to mount the guard. */
const APP_GUARD_PATTERN = /\{\s*provide:\s*APP_GUARD,\s*useClass:\s*PermissionGuard\s*\}/

type Pattern = 'standard' | 'per-route' | 'none'

interface ServiceException {
  service: string
  pattern: Pattern
  /**
   * Routes in this service allowed to carry no permission check at all,
   * as `METHOD path`. Every entry is a route that CANNOT be guarded, not
   * one that merely isn't.
   */
  unguardedRoutes: string[]
  reason: string
}

/**
 * The complete set of services that do not use the standard pattern. Each
 * carries the reason it cannot, in prose, and the exact routes it leaves
 * unguarded. This list is the whole point of the gate: an exception has to
 * be argued for in writing, in a file a reviewer reads, rather than being
 * whatever a service happened to do.
 */
const STANDARD_PATTERN_EXCEPTIONS: ServiceException[] = [
  {
    service: 'svc-authz',
    pattern: 'per-route',
    unguardedRoutes: ['POST decide', 'GET health'],
    reason:
      'POST /decide is the handler PermissionGuard itself calls, for every permission check in every ' +
      'other service. Guarding it would ask /decide to decide whether the caller may call /decide, which ' +
      'has no non-circular answer. Marking it @Public() under a global APP_GUARD would work mechanically, ' +
      'but would make the most security-critical route in the system depend on a decorator staying ' +
      'attached, where losing it causes infinite recursion rather than a clean denial. The three admin ' +
      'routes (GET /roles, the two grant/revoke routes) are guarded individually instead, and the ' +
      '"new controller ships unguarded" hole is closed by the per-route assertion below rather than by ' +
      'the mounting.',
  },
  {
    service: 'svc-i18n',
    pattern: 'none',
    unguardedRoutes: ['GET bundles/:locale', 'GET glossary', 'GET health'],
    reason:
      'Every route is public by design: the login screen has to render its own labels before any ' +
      'principal exists, so a guard here would make the product untranslatable until after login. ' +
      'Both business routes are exempted as consumed-not-displayed in web/ui-coverage.json.',
  },
]

interface RouteRef {
  service: string
  method: string
  path: string
  /** Decorators found on the contiguous lines directly below the HTTP decorator. */
  decorators: string[]
}

function walk(dir: string, suffix: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'dist' || entry.name === 'node_modules') continue
      out.push(...walk(full, suffix))
    } else if (entry.isFile() && entry.name.endsWith(suffix)) {
      out.push(full)
    }
  }
  return out
}

function extractStringArg(argSource: string): string {
  const trimmed = argSource.trim()
  if (trimmed === '') return ''
  const match = /^['"`]([^'"`]*)['"`]$/.exec(trimmed)
  if (!match) {
    throw new Error(
      `guard-mounting.audit.test.ts: decorator argument "${argSource}" is not a plain string literal — ` +
        `this parser only understands \`@Get('path')\`/\`@Get()\` style arguments.`,
    )
  }
  return match[1] ?? ''
}

function joinPath(...segments: string[]): string {
  return segments
    .map((s) => s.trim().replace(/^\/+/, '').replace(/\/+$/, ''))
    .filter((s) => s.length > 0)
    .join('/')
}

/** Every service directory that has a Nest module — `retention-job` has none (a scheduled worker with no HTTP listener), so it self-excludes. */
function servicesWithAModule(): string[] {
  return readdirSync(SERVICES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => existsSync(join(SERVICES_DIR, name, 'src', 'app.module.ts')))
    .sort()
}

/**
 * Comments must be stripped before matching. Every service that
 * DELIBERATELY does not mount the global guard explains that in a doc
 * comment which quotes the exact provider line it is declining to use
 * (svc-i18n and svc-authz). A naive source-wide match therefore reports
 * every one of them as mounting the guard — the precise inverse of the
 * truth, and a false PASS for a service that guards nothing.
 *
 * crypto-auth task: `svc-crypto` used to be a third `pattern: 'none'`
 * exception here (called service-to-service only, no human principal to
 * check a permission against) — but "no human principal" was never a
 * reason `PermissionGuard` cannot apply; a machine's `client_credentials`
 * token populates `request.userId` through the exact same `OidcMiddleware`
 * path a human token does (`packages/kernel/src/authz/
 * machine-token.client.ts`'s file header). `svc-crypto` now mounts the
 * standard pattern like every other guarded service and is no longer in
 * `STANDARD_PATTERN_EXCEPTIONS` at all — see `services/svc-crypto/src/
 * app.module.ts` and `crypto.controller.ts`.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

function mountsGlobalGuard(service: string): boolean {
  const source = readFileSync(join(SERVICES_DIR, service, 'src', 'app.module.ts'), 'utf8')
  return APP_GUARD_PATTERN.test(stripComments(source))
}

/**
 * Every route in a service, with the decorators that sit directly beneath
 * its HTTP decorator. Reads the contiguous `@...` lines below, exactly as
 * `public-routes.audit.test.ts` does for `@Public()`, so `@RequirePermission`,
 * `@Public`, `@UseGuards` and `@DeviceAuthenticated` are all visible from
 * one pass.
 */
function routesOf(service: string): RouteRef[] {
  const srcDir = join(SERVICES_DIR, service, 'src')
  if (!existsSync(srcDir)) return []
  const routes: RouteRef[] = []

  for (const filePath of walk(srcDir, '.controller.ts')) {
    const source = readFileSync(filePath, 'utf8')
    const controllerMatch = /@Controller\(([^)]*)\)/.exec(source)
    const prefix = controllerMatch ? extractStringArg(controllerMatch[1] ?? '') : ''
    // A class-level @UseGuards applies to every route in the file.
    const classGuardsPermission = /@UseGuards\([^)]*PermissionGuard[^)]*\)\s*\n\s*(?:@[\w.]+\([^)]*\)\s*\n\s*)*export class/.test(source)

    const lines = source.split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      const line = (lines[i] ?? '').trim()
      const httpMatch = new RegExp(`^@(${HTTP_METHODS.join('|')})\\(([^)]*)\\)$`).exec(line)
      if (!httpMatch) continue
      const method = (httpMatch[1] ?? '').toUpperCase()
      const routePath = joinPath(prefix, extractStringArg(httpMatch[2] ?? ''))

      const decorators: string[] = []
      if (classGuardsPermission) decorators.push('@UseGuards(PermissionGuard)')
      for (let j = i + 1; j < lines.length; j += 1) {
        const next = (lines[j] ?? '').trim()
        if (!next.startsWith('@')) break
        decorators.push(next)
      }
      routes.push({ service, method, path: routePath, decorators })
    }
  }
  return routes
}

const hasPermission = (r: RouteRef): boolean => r.decorators.some((d) => d.startsWith('@RequirePermission('))
const hasPublic = (r: RouteRef): boolean => r.decorators.some((d) => d === '@Public()')
const hasUseGuardsPermission = (r: RouteRef): boolean => r.decorators.some((d) => d.startsWith('@UseGuards(') && d.includes('PermissionGuard'))
const key = (r: RouteRef): string => `${r.method} ${r.path}`

describe('Guard mounting is one pattern, with named exceptions', () => {
  const services = servicesWithAModule()
  const exceptions = new Map(STANDARD_PATTERN_EXCEPTIONS.map((e) => [e.service, e]))

  it('parser sanity: found the real services and their routes', () => {
    expect(services.length).toBeGreaterThan(5)
    expect(services).toContain('svc-config')
    expect(routesOf('svc-config').length).toBeGreaterThan(0)
  })

  it('every service either mounts the standard global APP_GUARD or is a named, reasoned exception', () => {
    const offenders = services.filter((s) => !mountsGlobalGuard(s) && !exceptions.has(s))
    if (offenders.length > 0) {
      throw new Error(
        `${offenders.length} service(s) neither mount the standard guard nor appear in ` +
          `STANDARD_PATTERN_EXCEPTIONS:\n` +
          offenders.map((s) => `  - ${s}`).join('\n') +
          `\n\nThe standard pattern is \`{ provide: APP_GUARD, useClass: PermissionGuard }\` in ` +
          `services/<name>/src/app.module.ts, plus @Public() on any genuinely unauthenticated route. ` +
          `It fails closed: an undecorated route throws AUZ-403 instead of serving. If this service ` +
          `truly cannot use it, add it to STANDARD_PATTERN_EXCEPTIONS with the reason in prose and the ` +
          `exact routes it leaves unguarded — "it was easier" is not a reason.`,
      )
    }
  })

  it('no service listed as an exception has quietly started mounting the global guard (stale exception)', () => {
    const stale = STANDARD_PATTERN_EXCEPTIONS.filter((e) => services.includes(e.service) && mountsGlobalGuard(e.service)).map((e) => e.service)
    expect(stale).toEqual([])
  })

  it('every exception names at least one route and gives a real reason', () => {
    for (const e of STANDARD_PATTERN_EXCEPTIONS) {
      expect(e.unguardedRoutes.length).toBeGreaterThan(0)
      expect(e.reason.trim().length).toBeGreaterThan(80)
    }
  })

  /**
   * The assertion that catches the svc-scheduler class of defect: a service
   * that mounts the global guard but leaves a route undecorated. At runtime
   * that route 403s for everyone; here it fails the build, named.
   */
  describe('services on the standard pattern', () => {
    const standard = servicesWithAModule().filter((s) => mountsGlobalGuard(s))

    it('found the expected majority of services on the standard pattern', () => {
      expect(standard.length).toBeGreaterThanOrEqual(10)
    })

    it('every route declares exactly one of @RequirePermission or @Public() — never neither, never both', () => {
      const bad: string[] = []
      for (const service of standard) {
        for (const route of routesOf(service)) {
          const permission = hasPermission(route)
          const isPublic = hasPublic(route)
          if (permission === isPublic) {
            bad.push(`${service}: ${key(route)} — ${permission ? 'has BOTH @RequirePermission and @Public()' : 'has NEITHER'}`)
          }
        }
      }
      if (bad.length > 0) {
        throw new Error(
          `${bad.length} route(s) in globally-guarded services do not declare a permission decision:\n` +
            bad.map((b) => `  - ${b}`).join('\n') +
            `\n\nUnder a global APP_GUARD, a route with neither decorator throws AUZ-403 for every caller ` +
            `(guard.ts's noPermissionDeclaredError) — it is unreachable, not open. Add @RequirePermission('...') ` +
            `if a permission governs it, or @Public() (and the matching entries in ` +
            `packages/kernel/src/authz/public-routes.audit.test.ts and web/ui-coverage.json) if it is ` +
            `genuinely unauthenticated.`,
        )
      }
    })

    it('no service on the standard pattern also mounts PermissionGuard per-route — one mechanism, not two', () => {
      const redundant: string[] = []
      for (const service of standard) {
        for (const route of routesOf(service)) {
          if (hasUseGuardsPermission(route)) redundant.push(`${service}: ${key(route)}`)
        }
      }
      expect(redundant).toEqual([])
    })
  })

  /**
   * The other half: for the one exception that still guards per-route, a
   * route added later must not be able to slip through undeclared. The
   * mounting cannot enforce this, so the test does.
   */
  describe('services keeping the per-route pattern', () => {
    for (const exception of STANDARD_PATTERN_EXCEPTIONS.filter((e) => e.pattern === 'per-route')) {
      it(`${exception.service}: every route carries @UseGuards(PermissionGuard) or is a named unguardable route`, () => {
        const allowed = new Set(exception.unguardedRoutes)
        const unguarded = routesOf(exception.service)
          .filter((r) => !hasUseGuardsPermission(r) && !allowed.has(key(r)))
          .map(key)
        if (unguarded.length > 0) {
          throw new Error(
            `${exception.service} has ${unguarded.length} route(s) with no permission check and no entry in ` +
              `its STANDARD_PATTERN_EXCEPTIONS allowlist:\n` +
              unguarded.map((r) => `  - ${r}`).join('\n') +
              `\n\nThis service does not mount a global guard, so nothing protects a route by default. ` +
              `Add @UseGuards(PermissionGuard) + @RequirePermission('...'), or — if the route genuinely ` +
              `cannot be guarded — add it to that service's unguardedRoutes with the reason.`,
          )
        }
      })

      it(`${exception.service}: every route it DOES guard also declares a permission`, () => {
        const missing = routesOf(exception.service)
          .filter((r) => hasUseGuardsPermission(r) && !hasPermission(r))
          .map(key)
        expect(missing).toEqual([])
      })
    }
  })

  /**
   * `svc-attendance` is the service this reconciliation converged, and the
   * reason the convergence was non-trivial: two of its routes authenticate a
   * kiosk by per-device HMAC rather than OIDC, and that guard MUST run
   * before `PermissionGuard` (it is what populates the principal the
   * permission check reads). Nest runs global guards before route guards, so
   * the ordering could not survive as `@UseGuards(DeviceAuthGuard,
   * PermissionGuard)` once the permission guard went global — it now lives
   * in APP_GUARD registration ORDER instead. Reversing those two lines would
   * deny every kiosk punch, silently, with no other test failing.
   */
  describe('svc-attendance kiosk guard ordering (the reason its convergence was non-trivial)', () => {
    const modulePath = join(SERVICES_DIR, 'svc-attendance', 'src', 'app.module.ts')

    it('mounts the standard guard like everyone else', () => {
      expect(mountsGlobalGuard('svc-attendance')).toBe(true)
    })

    it('registers DeviceAuthGuard as an APP_GUARD BEFORE PermissionGuard — the order is the contract', () => {
      const source = readFileSync(modulePath, 'utf8')
      const deviceAt = source.indexOf('{ provide: APP_GUARD, useClass: DeviceAuthGuard }')
      const permissionAt = source.indexOf('{ provide: APP_GUARD, useClass: PermissionGuard }')
      expect(deviceAt).toBeGreaterThan(-1)
      expect(permissionAt).toBeGreaterThan(-1)
      // DeviceAuthGuard populates request.userId as `device:<id>`;
      // PermissionGuard reads it. Reversed, every kiosk punch is denied.
      expect(deviceAt).toBeLessThan(permissionAt)
    })

    it('the two kiosk routes are marked @DeviceAuthenticated() and still declare their permission', () => {
      const kiosk = routesOf('svc-attendance').filter((r) => r.decorators.includes('@DeviceAuthenticated()'))
      expect(kiosk.map(key).sort()).toEqual(['POST punches/batch', 'POST punches/face'])
      for (const route of kiosk) expect(hasPermission(route)).toBe(true)
    })
  })
})
