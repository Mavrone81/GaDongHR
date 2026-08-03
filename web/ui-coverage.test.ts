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
 *  - the DECLARED routes in `web/ui-coverage.json`, each either pointing at a
 *    screen or carrying one of the three legitimate exemptions.
 *
 * A route in one list and not the other is a defect: either a shipped
 * endpoint nobody decided where a human sees it, or a manifest entry
 * pointing at nothing (a deleted or renamed route).
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

describe('UI coverage gate', () => {
  const routes = actualRoutes()
  const manifest = loadManifest()
  const permissionCatalog = parsePermissionCatalog()

  const routeSet = new Map<string, RouteKey>(routes.map((r) => [routeKeyString(r), r]))
  const manifestByKey = new Map<string, ManifestEntry>()
  for (const entry of manifest) {
    if (entry.service && entry.method && entry.path !== undefined) {
      manifestByKey.set(routeKeyString({ service: entry.service, method: entry.method, path: entry.path }), entry)
    }
  }

  it('found at least one real route to check (parser sanity)', () => {
    expect(routes.length).toBeGreaterThan(0)
  })

  it('has a manifest entry for every route that exists in the code', () => {
    const missing = routes.filter((r) => !manifestByKey.has(routeKeyString(r))).map(routeKeyString)
    expect(missing).toEqual([])
  })

  it('has no manifest entry pointing at a route that does not exist in the code', () => {
    const orphaned = manifest
      .filter((entry) => {
        if (!entry.service || !entry.method || entry.path === undefined) return true // malformed key, definitely orphaned
        return !routeSet.has(routeKeyString({ service: entry.service, method: entry.method, path: entry.path }))
      })
      .map((entry) => `${entry.method ?? '?'} ${entry.service ?? '?'}:/${entry.path ?? '?'}`)
    expect(orphaned).toEqual([])
  })

  it('has no route listed twice in the manifest', () => {
    const seen = new Map<string, number>()
    for (const entry of manifest) {
      if (!entry.service || !entry.method || entry.path === undefined) continue
      const key = routeKeyString({ service: entry.service, method: entry.method, path: entry.path })
      seen.set(key, (seen.get(key) ?? 0) + 1)
    }
    const duplicates = [...seen.entries()].filter(([, count]) => count > 1).map(([key]) => key)
    expect(duplicates).toEqual([])
  })

  describe.each(manifest.map((entry, i): [string, ManifestEntry] => [`#${i} ${entry.method ?? '?'} ${entry.service ?? '?'}:/${entry.path ?? '?'}`, entry]))(
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
