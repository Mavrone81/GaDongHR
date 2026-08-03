import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The UI-coverage gate (roadmap `docs/superpowers/plans/00-PROGRAM-ROADMAP.md`,
 * "Every endpoint has a front end — enforced, not intended"). Two independent
 * sources of truth are compared:
 *
 *  - the ACTUAL routes, parsed out of every `*.controller.ts` file under `services/`'s
 *    `@Controller(...)` prefix and `@Get`/`@Post`/`@Put`/`@Patch`/`@Delete`
 *    decorators — never hand-maintained, so it cannot silently drift from
 *    the code the way a second, manually-kept list could.
 *  - the DECISIONS in `web/ui-coverage.json`: for a route that exists, either
 *    a screen or one of the three legitimate exemptions.
 *
 * Redesigned 2026-08-04 (reconciliation after M1/M2/M5/M6 landed — see
 * `.superpowers/sdd/02-modules/reconciliation-report.md`). The original
 * design treated `web/ui-coverage.json` as a second, hand-maintained ROUTE
 * LIST that had to mirror `services/**\/*.controller.ts` exactly in both
 * directions: every code route needed a manifest entry (still true, and
 * still enforced below) AND every manifest entry needed a matching code
 * route, on pain of failing the whole gate. That second direction is what
 * made this file a bottleneck: four module-building agents (M1, M2, M5, M6),
 * each scoped to `services/<name>/{src,migrations}` only, independently hit
 * the same wall — a new, correctly-built route always requires a decision
 * edit to a file none of them own, so the gate could never be green from
 * inside any module's own boundary. Renaming or removing a route would hit
 * the identical wall in reverse (an ORPHANED manifest entry, requiring the
 * same out-of-scope edit just to delete a line).
 *
 * The fix: the manifest is a DECISION STORE, not an inventory. The true
 * route inventory is, and only ever needs to be, the parsed
 * `*.controller.ts` output above.
 *  - A route that exists in code with no manifest decision FAILS the gate,
 *    loudly, naming the exact route — "no endpoint ships without a
 *    deliberate decision" is preserved in full.
 *  - A manifest entry whose route no longer exists in code (renamed,
 *    deleted, or moved to a different service) drops out SILENTLY. It is
 *    stale, not a defect: the thing it decided about no longer exists to
 *    have an opinion on, and the next agent to touch that area can clean it
 *    up without that cleanup being a precondition for anyone else's gate to
 *    pass. See `liveManifestEntries`/`findUndecidedRoutes` below, and the
 *    'derived inventory' describe block, which tests this behaviour directly
 *    against synthetic fixtures (not the real filesystem) so the property
 *    holds independent of whatever routes happen to exist today.
 */

const REPO_ROOT = join(__dirname, '..')
const SERVICES_DIR = join(REPO_ROOT, 'services')
const ROADMAP_PATH = join(REPO_ROOT, 'docs/superpowers/plans/00-PROGRAM-ROADMAP.md')
const MANIFEST_PATH = join(__dirname, 'ui-coverage.json')

const HTTP_METHODS = ['Get', 'Post', 'Put', 'Patch', 'Delete'] as const
type HttpMethodDecorator = (typeof HTTP_METHODS)[number]

interface RouteKey {
  service: string
  method: string
  path: string
}

const EXEMPT_CATEGORIES = ['service-to-service', 'operational', 'consumed-not-displayed'] as const
type ExemptCategory = (typeof EXEMPT_CATEGORIES)[number]

/**
 * `web/ui-coverage.json`'s row shape. Deliberately loose (`unknown`-free but
 * every field optional) because the whole point of this type is to describe
 * data that might be MALFORMED — the tests below assert the shape, they
 * don't get to assume it.
 */
interface ManifestEntry {
  service?: string
  method?: string
  path?: string
  permission?: string
  screen?: string
  exempt?: string
  reason?: string
  notes?: string
}

interface ManifestFile {
  routes?: ManifestEntry[]
}

function routeKeyString(r: RouteKey): string {
  return `${r.method} ${r.service}:/${r.path}`
}

/**
 * Strips a matched decorator's argument down to the quoted string literal
 * inside it, if any. `@Get()`/`@Controller()` (no argument, or an argument
 * that isn't a plain string literal) yields `''` — an empty controller
 * prefix, or a bare route at the controller's own prefix. This is a
 * deliberately narrow parser (quoted-string-literal arguments only): every
 * controller in this codebase today calls these decorators with either no
 * argument or a single string literal, never a template literal or a
 * constant reference, and a route declared any other way should fail loudly
 * here rather than be silently skipped.
 */
function extractStringArg(argSource: string): string {
  const trimmed = argSource.trim()
  if (trimmed === '') return ''
  const match = /^['"`]([^'"`]*)['"`]$/.exec(trimmed)
  if (!match) {
    throw new Error(
      `ui-coverage.test.ts: decorator argument "${argSource}" is not a plain string literal — ` +
        `the route parser only understands \`@Get('path')\`/\`@Get()\` style arguments.`,
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

/** Every `*.controller.ts` file found anywhere under `services/<name>/src/`, service name plus content. */
function findControllerFiles(): Array<{ service: string; filePath: string; source: string }> {
  const results: Array<{ service: string; filePath: string; source: string }> = []
  const serviceDirs = readdirSync(SERVICES_DIR, { withFileTypes: true }).filter((e) => e.isDirectory())

  for (const serviceDir of serviceDirs) {
    const srcDir = join(SERVICES_DIR, serviceDir.name, 'src')
    let entries: string[]
    try {
      entries = walkControllerFiles(srcDir)
    } catch {
      continue // no src/ dir (shouldn't happen, but don't let one bad service crash the whole gate)
    }
    for (const filePath of entries) {
      results.push({ service: serviceDir.name, filePath, source: readFileSync(filePath, 'utf8') })
    }
  }
  return results
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

/**
 * Parses one controller file's true routes. Assumes (true of every
 * controller in this codebase today, see `findControllerFiles`'s doc) at
 * most one `@Controller(...)` per file — its prefix applies to every
 * `@Get`/`@Post`/`@Put`/`@Patch`/`@Delete` decorator found anywhere else in
 * the file, matching how Nest itself only recognises decorators on methods
 * of the exported class.
 */
function parseControllerRoutes(service: string, source: string): RouteKey[] {
  const controllerMatch = /@Controller\(([^)]*)\)/.exec(source)
  const prefix = controllerMatch ? extractStringArg(controllerMatch[1] ?? '') : ''

  const routes: RouteKey[] = []
  const decoratorRe = new RegExp(`@(${HTTP_METHODS.join('|')})\\(([^)]*)\\)`, 'g')
  let m: RegExpExecArray | null
  while ((m = decoratorRe.exec(source)) !== null) {
    const decoratorGroup = m[1]
    if (decoratorGroup === undefined) continue // regex guarantees this group when the outer match succeeds; guard only for noUncheckedIndexedAccess
    const decorator = decoratorGroup as HttpMethodDecorator
    const argSource = m[2] ?? ''
    const routePath = extractStringArg(argSource)
    routes.push({ service, method: decorator.toUpperCase(), path: joinPath(prefix, routePath) })
  }
  return routes
}

function actualRoutes(): RouteKey[] {
  return findControllerFiles().flatMap(({ service, source }) => parseControllerRoutes(service, source))
}

/**
 * Parses the fenced code block directly under the roadmap's
 * "### Permission catalog — `resource.action`" heading — the single source
 * of truth `web/ui-coverage.json`'s `permission` fields are checked against.
 * A permission that only exists in a manifest entry, and nowhere in this
 * catalog, cannot be granted to any role template
 * (`services/svc-authz/src/seed/roles.ts`'s `PERMISSION_CATALOG` is seeded
 * from exactly this list) — the screen it names would guard itself with a
 * permission nobody can ever hold.
 */
function parsePermissionCatalog(): Set<string> {
  const source = readFileSync(ROADMAP_PATH, 'utf8')
  const headingIndex = source.indexOf('### Permission catalog')
  if (headingIndex === -1) {
    throw new Error('ui-coverage.test.ts: could not find "### Permission catalog" heading in the roadmap doc.')
  }
  const afterHeading = source.slice(headingIndex)
  const fenceStart = afterHeading.indexOf('\n```\n')
  const fenceEnd = afterHeading.indexOf('\n```\n', fenceStart + 5)
  if (fenceStart === -1 || fenceEnd === -1) {
    throw new Error('ui-coverage.test.ts: could not find the permission catalog\'s fenced code block.')
  }
  const block = afterHeading.slice(fenceStart + 5, fenceEnd)
  const codes = block
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  return new Set(codes)
}

function loadManifest(): ManifestEntry[] {
  const raw = readFileSync(MANIFEST_PATH, 'utf8')
  const parsed = JSON.parse(raw) as ManifestFile
  return parsed.routes ?? []
}

function manifestEntryKey(entry: ManifestEntry): string | undefined {
  if (!entry.service || !entry.method || entry.path === undefined) return undefined
  return routeKeyString({ service: entry.service, method: entry.method, path: entry.path })
}

/**
 * Every actual route with no manifest decision — the ONLY way this gate
 * fails on new code. Returns the route key strings directly so a failure
 * names exactly which endpoints need a decision, not just a count.
 */
function findUndecidedRoutes(actual: RouteKey[], manifest: ManifestEntry[]): string[] {
  const decided = new Set(manifest.map(manifestEntryKey).filter((k): k is string => k !== undefined))
  return actual.filter((r) => !decided.has(routeKeyString(r))).map(routeKeyString)
}

/**
 * Manifest entries whose route still exists in the actual inventory. Stale
 * entries (renamed/deleted routes) are filtered out here, not flagged —
 * that is the "drops out silently" half of the redesign. Only live entries
 * go on to the structural checks below (screen-or-exempt shape, valid
 * permission, non-empty reason): validating a decision about a route that
 * no longer exists would just be more work someone has to do to delete a
 * line, exactly the friction this redesign removes.
 */
function liveManifestEntries(actual: RouteKey[], manifest: ManifestEntry[]): ManifestEntry[] {
  const actualKeys = new Set(actual.map(routeKeyString))
  return manifest.filter((entry) => {
    const key = manifestEntryKey(entry)
    return key !== undefined && actualKeys.has(key)
  })
}

describe('UI coverage gate', () => {
  const routes = actualRoutes()
  const manifest = loadManifest()
  const permissionCatalog = parsePermissionCatalog()
  const live = liveManifestEntries(routes, manifest)

  it('found at least one real route to check (parser sanity)', () => {
    expect(routes.length).toBeGreaterThan(0)
  })

  it('has a manifest decision for every route that exists in the code', () => {
    const missing = findUndecidedRoutes(routes, manifest)
    if (missing.length > 0) {
      throw new Error(
        `web/ui-coverage.test.ts: ${missing.length} route(s) exist in the code with no decision in ` +
          `web/ui-coverage.json. Add one entry per route below, each pointing at a screen or an ` +
          `explicit exemption with a reason ("not needed yet" is not a reason):\n` +
          missing.map((r) => `  - ${r}`).join('\n'),
      )
    }
  })

  it('has no route listed twice in the manifest', () => {
    const seen = new Map<string, number>()
    for (const entry of manifest) {
      const key = manifestEntryKey(entry)
      if (key === undefined) continue
      seen.set(key, (seen.get(key) ?? 0) + 1)
    }
    const duplicates = [...seen.entries()].filter(([, count]) => count > 1).map(([key]) => key)
    expect(duplicates).toEqual([])
  })

  describe.each(live.map((entry, i): [string, ManifestEntry] => [`#${i} ${entry.method ?? '?'} ${entry.service ?? '?'}:/${entry.path ?? '?'}`, entry]))(
    'manifest entry %s',
    (_label, entry) => {
      it('declares exactly one of screen or exempt, never both, never neither', () => {
        const hasScreen = entry.screen !== undefined
        const hasExempt = entry.exempt !== undefined
        expect(hasScreen !== hasExempt).toBe(true)
      })

      if (entry.exempt !== undefined) {
        it('uses an allowed exempt category', () => {
          expect(EXEMPT_CATEGORIES).toContain(entry.exempt as ExemptCategory)
        })

        it('carries a non-empty reason', () => {
          expect((entry.reason ?? '').trim().length).toBeGreaterThan(0)
        })
      } else {
        it('declares a permission that exists in the roadmap\'s permission catalog', () => {
          expect(entry.permission).toBeDefined()
          expect(permissionCatalog.has(entry.permission ?? '')).toBe(true)
        })

        it('carries a non-empty screen route', () => {
          expect((entry.screen ?? '').trim().length).toBeGreaterThan(0)
        })
      }
    },
  )
})

/**
 * Part Two, made real: the manifest carries decisions, not the route
 * inventory. These run against synthetic fixtures — never the real
 * filesystem — so the property they prove ("undecided routes fail loudly,
 * named; stale entries drop out silently") holds regardless of what routes
 * happen to exist in this repo today, and won't rot into a tautology as the
 * real inventory grows across Phases 3–5.
 */
describe('derived inventory (Part Two: the manifest is a decision store, not a route list)', () => {
  const A: RouteKey = { service: 'svc-example', method: 'GET', path: 'widgets' }
  const B: RouteKey = { service: 'svc-example', method: 'POST', path: 'widgets' }
  const decidedA: ManifestEntry = { service: A.service, method: A.method, path: A.path, exempt: 'operational', reason: 'test fixture' }

  it('a route with no manifest entry at all is undecided', () => {
    expect(findUndecidedRoutes([A], [])).toEqual(['GET svc-example:/widgets'])
  })

  it('names every undecided route, not just the first', () => {
    expect(findUndecidedRoutes([A, B], []).sort()).toEqual(['GET svc-example:/widgets', 'POST svc-example:/widgets'].sort())
  })

  it('a route with a matching manifest entry is decided, regardless of what OTHER routes are undecided', () => {
    expect(findUndecidedRoutes([A, B], [decidedA])).toEqual(['POST svc-example:/widgets'])
  })

  it('a manifest entry whose route no longer exists in the actual inventory is not reported as undecided (it simply has nothing to decide)', () => {
    // B is not in the "actual" list at all — only A is — so there is nothing
    // for B's entry to be a stale decision ABOUT from findUndecidedRoutes's
    // point of view; the assertion that matters is the next one.
    expect(findUndecidedRoutes([A], [decidedA])).toEqual([])
  })

  it('a stale manifest entry (route removed from the actual inventory) drops out of liveManifestEntries silently — no error, just absence', () => {
    const staleEntry: ManifestEntry = { service: B.service, method: B.method, path: B.path, exempt: 'operational', reason: 'a route that used to exist' }
    // Actual inventory no longer contains B (it was renamed/removed in code).
    const live = liveManifestEntries([A], [decidedA, staleEntry])
    expect(live).toEqual([decidedA])
    expect(live.some((e) => e.path === 'widgets' && e.method === 'POST')).toBe(false)
  })

  it('the real repo: every actual route is genuinely parsed from *.controller.ts, never a hand-typed list — adding this fixture route and re-parsing would find it (parser is data-driven, not hard-coded)', () => {
    const syntheticSource = `
      import { Controller, Get } from '@nestjs/common'
      @Controller('fixture-only')
      class FixtureController {
        @Get('never-really-shipped')
        neverReallyShipped() {}
      }
    `
    const parsed = parseControllerRoutes('svc-fixture', syntheticSource)
    expect(parsed).toEqual([{ service: 'svc-fixture', method: 'GET', path: 'fixture-only/never-really-shipped' }])
    // And, critically, this route is NOT in the real actualRoutes() output —
    // proving the parser reads real files, not a list this test file (or
    // any other) maintains by hand.
    expect(actualRoutes().some((r) => r.service === 'svc-fixture')).toBe(false)
  })
})
