import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Task 16e's third requirement: "a test listing exactly which routes are
 * public across all services, so a new public route is a deliberate,
 * reviewable change." `@Public()` (`guard.ts`) is the mechanism that makes a
 * route bypass `PermissionGuard`; this gate makes every USE of it visible in
 * one place and reconciled against `web/ui-coverage.json`, which already
 * records the "this route is legitimately unauthenticated" decision for
 * every route in the system (operational health checks, service-to-service
 * calls, and svc-i18n's pre-login bundles) — see that file's own
 * `ui-coverage.test.ts` gate, which this test complements rather than
 * duplicates: that gate proves every ROUTE has a manifest entry; this one
 * proves every `@Public()` MARKER (a stronger claim — "the guard actually
 * lets this through with no check at all") has one too, and that the known
 * set of them hasn't silently grown.
 *
 * Deliberately regex-based, not a TypeScript parser — the same trade-off
 * `web/ui-coverage.test.ts` makes, for the same reason (no parser dependency
 * needed for a decorator convention every controller in this codebase
 * already follows consistently).
 *
 * Mirrors `web/ui-coverage.test.ts`'s "never hand-maintained" route parser
 * on purpose (duplicated, not imported — `packages/kernel` cannot depend on
 * `web`, the dependency direction runs the other way): the actual routes are
 * parsed out of the real `*.controller.ts` source, never hand-typed here,
 * except for the ONE hard-coded expectation below (`EXPECTED_PUBLIC_ROUTES`)
 * that exists specifically so an added or removed `@Public()` route changes
 * a named, reviewable assertion instead of just quietly changing what a
 * generic "matches the manifest" check accepts.
 */

const REPO_ROOT = join(__dirname, '..', '..', '..', '..')
const SERVICES_DIR = join(REPO_ROOT, 'services')
const MANIFEST_PATH = join(REPO_ROOT, 'web', 'ui-coverage.json')

const HTTP_METHODS = ['Get', 'Post', 'Put', 'Patch', 'Delete'] as const
type HttpMethodDecorator = (typeof HTTP_METHODS)[number]

interface PublicRoute {
  service: string
  method: string
  path: string
}

interface ManifestEntry {
  service?: string
  method?: string
  path?: string
  exempt?: string
  reason?: string
}

/** The full, exact set of routes this codebase marks `@Public()` today (Task 16e). Adding, removing, or moving one is a deliberate one-line change to this list, not a side effect of a generic pattern match. */
const EXPECTED_PUBLIC_ROUTES: PublicRoute[] = [
  { service: 'svc-config', method: 'GET', path: 'health' },
  { service: 'svc-audit', method: 'GET', path: 'health' },
  { service: 'svc-docs', method: 'GET', path: 'health' },
  { service: 'svc-notify', method: 'GET', path: 'health' },
  { service: 'svc-timesheet', method: 'GET', path: 'health' },
  // Added 2026-08-04 (M1/M5/M6 reconciliation): each of these three mounted
  // `PermissionGuard` globally for the first time to guard real business
  // routes, which would otherwise deny-by-default their own healthcheck —
  // the same Task 16e defect class `health.controller.ts`'s M1 fix caught.
  { service: 'svc-onboarding', method: 'GET', path: 'health' },
  { service: 'svc-leave', method: 'GET', path: 'health' },
  { service: 'svc-claims', method: 'GET', path: 'health' },
  // Added by the integration reconciliation (2026-08-04), FIXING A LIVE
  // DEFECT. The note that used to sit here read "svc-scheduler's health
  // stays non-public: M2 did not mount a global guard, so its health route
  // needs no bypass" — and it was wrong. M2's Phase 3 build DID add
  // `{ provide: APP_GUARD, useClass: PermissionGuard }` when it added the
  // rostering controllers, so `GET /health` had a global guard, no
  // `@Public()` and no `@RequirePermission`, and returned AUZ-403 to
  // compose's healthcheck, the deploy script and monitoring on every call.
  //
  // This gate could not have caught it: it compares `@Public()` MARKERS,
  // and a route that is neither public nor guarded has no marker to
  // compare. `guard-mounting.audit.test.ts` (added alongside this entry)
  // asserts the complementary property — every route in a globally-guarded
  // service declares one or the other — which is what makes this class of
  // defect visible.
  { service: 'svc-scheduler', method: 'GET', path: 'health' },
  // Added by the same reconciliation, converging svc-attendance off the
  // per-controller `@UseGuards(PermissionGuard)` pattern onto the standard
  // global `APP_GUARD`. M4 chose per-controller specifically so it would
  // not have to add this line; the cost was that a controller added to
  // svc-attendance later would have shipped unguarded with no test failing.
  { service: 'svc-attendance', method: 'GET', path: 'health' },
  // Added by M7 (Phase 5), same cause as the three above: `svc-payroll` now
  // mounts `PermissionGuard` globally to guard the pay-profile, run
  // lifecycle, payslip, bank-file and statutory-export routes, so its own
  // healthcheck — called by compose, the deploy script and monitoring with
  // no bearer token — would otherwise be denied by deny-by-default. It is
  // the only `@Public()` route in the service that holds every salary in
  // the product, and `services/svc-payroll/src/payroll.controller.test.ts`
  // asserts independently that no other route there is public.
  { service: 'svc-payroll', method: 'GET', path: 'health' },
  // Added by the crypto-auth task: `svc-crypto` now mounts `PermissionGuard`
  // globally (defense-in-depth fix — it used to accept `/encrypt`/`/decrypt`/
  // `/bidx` with zero authentication), so its own healthcheck — called by
  // compose, the deploy script and monitoring with no bearer token — needs
  // the same `@Public()` bypass every other guarded service's health route
  // already has. `crypto.controller.test.ts`'s own suite asserts
  // independently that `/encrypt`/`/decrypt`/`/bidx` are NOT public.
  { service: 'svc-crypto', method: 'GET', path: 'health' },
]

function routeKeyString(r: PublicRoute): string {
  return `${r.method} ${r.service}:/${r.path}`
}

/** Same narrow "quoted string literal argument only" parser `web/ui-coverage.test.ts` uses — see that file's `extractStringArg` for the full justification. */
function extractStringArg(argSource: string): string {
  const trimmed = argSource.trim()
  if (trimmed === '') return ''
  const match = /^['"`]([^'"`]*)['"`]$/.exec(trimmed)
  if (!match) {
    throw new Error(
      `public-routes.audit.test.ts: decorator argument "${argSource}" is not a plain string literal.`,
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

function walkControllerFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'dist' || entry.name === 'node_modules') continue
      out.push(...walkControllerFiles(full))
    } else if (entry.isFile() && entry.name.endsWith('.controller.ts')) {
      out.push(full)
    }
  }
  return out
}

function findControllerFiles(): Array<{ service: string; source: string }> {
  const results: Array<{ service: string; source: string }> = []
  const serviceDirs = readdirSync(SERVICES_DIR, { withFileTypes: true }).filter((e) => e.isDirectory())
  for (const serviceDir of serviceDirs) {
    const srcDir = join(SERVICES_DIR, serviceDir.name, 'src')
    let files: string[]
    try {
      files = walkControllerFiles(srcDir)
    } catch {
      continue
    }
    for (const filePath of files) {
      results.push({ service: serviceDir.name, source: readFileSync(filePath, 'utf8') })
    }
  }
  return results
}

/**
 * Finds every `@Get`/`@Post`/`@Put`/`@Patch`/`@Delete(...)`-decorated handler
 * in `source` and reports whether a `@Public()` decorator appears anywhere in
 * the contiguous run of decorator lines directly above the handler's method
 * signature — the exact shape every controller in this codebase uses
 * (`@Get('health')` then `@Public()` then the method), matching how
 * `@RequirePermission(...)` is written directly below its own `@Get`/`@Post`.
 */
function parsePublicRoutes(service: string, source: string): PublicRoute[] {
  const controllerMatch = /@Controller\(([^)]*)\)/.exec(source)
  const prefix = controllerMatch ? extractStringArg(controllerMatch[1] ?? '') : ''

  const lines = source.split('\n')
  const methodDecoratorRe = new RegExp(`^@(${HTTP_METHODS.join('|')})\\(([^)]*)\\)$`)
  const routes: PublicRoute[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim()
    const match = methodDecoratorRe.exec(line)
    if (!match) continue

    const decorator = match[1] as HttpMethodDecorator | undefined
    if (!decorator) continue
    const routePath = extractStringArg(match[2] ?? '')

    let isPublic = false
    for (let j = i + 1; j < lines.length; j++) {
      const nextLine = (lines[j] ?? '').trim()
      if (!nextLine.startsWith('@')) break // reached the method signature line
      if (nextLine === '@Public()') isPublic = true
    }

    if (isPublic) {
      routes.push({ service, method: decorator.toUpperCase(), path: joinPath(prefix, routePath) })
    }
  }

  return routes
}

function actualPublicRoutes(): PublicRoute[] {
  return findControllerFiles().flatMap(({ service, source }) => parsePublicRoutes(service, source))
}

function loadManifestEntries(): ManifestEntry[] {
  const raw = readFileSync(MANIFEST_PATH, 'utf8')
  const parsed = JSON.parse(raw) as { routes?: ManifestEntry[] }
  return parsed.routes ?? []
}

describe('@Public() route audit (Task 16e) — reconciled with web/ui-coverage.json', () => {
  const actual = actualPublicRoutes()
  const manifest = loadManifestEntries()
  const manifestByKey = new Map<string, ManifestEntry>()
  for (const entry of manifest) {
    if (entry.service && entry.method && entry.path !== undefined) {
      manifestByKey.set(routeKeyString({ service: entry.service, method: entry.method, path: entry.path }), entry)
    }
  }

  it('parser sanity: found at least one real @Public() route', () => {
    expect(actual.length).toBeGreaterThan(0)
  })

  it('the exact set of @Public() routes in source matches the reviewed, named expectation', () => {
    const actualKeys = actual.map(routeKeyString).sort()
    const expectedKeys = EXPECTED_PUBLIC_ROUTES.map(routeKeyString).sort()
    expect(actualKeys).toEqual(expectedKeys)
  })

  it('every @Public() route has a corresponding web/ui-coverage.json manifest entry, and that entry is an exemption (not a screen)', () => {
    const problems = actual
      .filter((route) => {
        const entry = manifestByKey.get(routeKeyString(route))
        return entry === undefined || entry.exempt === undefined
      })
      .map(routeKeyString)
    expect(problems).toEqual([])
  })

  it('every @Public() route\'s manifest entry carries a non-empty reason', () => {
    const missingReason = actual
      .filter((route) => {
        const entry = manifestByKey.get(routeKeyString(route))
        return !entry?.reason || entry.reason.trim().length === 0
      })
      .map(routeKeyString)
    expect(missingReason).toEqual([])
  })
})
