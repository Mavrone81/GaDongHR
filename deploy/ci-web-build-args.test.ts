import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Task 15d: the defect this closes was CI's `build-images` matrix building
 * `gadonghr-web` with no `VITE_*` build args at all — a Vite SPA bakes its
 * config into the JS bundle at `vite build` time (`web/src/env.ts`'s
 * `required()`), so the published image had no configuration whatsoever and
 * threw before React ever mounted. See `deploy/README.md`'s "Traefik
 * routing" section for the empirical trace (pulling and inspecting the real
 * published image).
 *
 * This suite does NOT hard-code the six `VITE_*` names — a copy pasted into
 * the test would only ever agree with itself, and could drift silently from
 * `env.ts`'s actual requirements the same way the CI matrix drifted from
 * them in the first place. Instead it parses `web/src/env.ts`'s own
 * `required('VITE_...')` calls as the single source of truth, exactly the
 * way `web/src/env.ts`'s own header describes itself: "the one place
 * `import.meta.env` is read... so there is exactly one spot to audit."
 */

const REPO_ROOT = join(__dirname, '..')
const CI_YML_PATH = join(REPO_ROOT, '.github', 'workflows', 'ci.yml')
const ENV_TS_PATH = join(REPO_ROOT, 'web', 'src', 'env.ts')

/** Every `VITE_*` name passed through env.ts's `required()`. */
function parseRequiredViteVars(envTs: string): string[] {
  const names = new Set<string>()
  const pattern = /required\('(VITE_[A-Z0-9_]+)'\)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(envTs)) !== null) {
    const name = match[1]
    if (name) names.add(name)
  }
  return [...names].sort()
}

/**
 * Splits the `build-images` matrix's `include:` list into one raw text
 * chunk per entry (from one `- ` list-item marker up to, but not
 * including, the next one, or the end of the matrix). Deliberately a text
 * split rather than a YAML parse, matching `ci-image-matrix.test.ts`'s own
 * approach of not depending on a YAML library — the whole point is to read
 * the real workflow file directly, not a stand-in for it.
 */
function splitMatrixEntries(ciYml: string): Map<string, string> {
  const matrixStart = ciYml.indexOf('\n    strategy:\n')
  const stepsStart = ciYml.indexOf('\n    steps:\n', matrixStart)
  if (matrixStart === -1 || stepsStart === -1) return new Map()
  // Full-line `#` comments (e.g. the header comment above the `web` entry,
  // which itself mentions "buildArgs" in prose) are stripped before
  // splitting — otherwise a comment sitting between one entry's `- ` marker
  // and the next gets attributed to the wrong (preceding) entry's raw text.
  const section = ciYml
    .slice(matrixStart, stepsStart)
    .replace(/^\s*#.*$/gm, '')

  const itemStarts = [...section.matchAll(/\n(\s*)-\s/g)].map((m) => m.index!)
  const entries = new Map<string, string>()
  for (let i = 0; i < itemStarts.length; i++) {
    const start = itemStarts[i]
    const end = i + 1 < itemStarts.length ? itemStarts[i + 1] : section.length
    const raw = section.slice(start, end)
    const nameMatch = raw.match(/name:\s*([\w-]+)/)
    if (nameMatch?.[1]) entries.set(nameMatch[1], raw)
  }
  return entries
}

describe('CI web build-args (Task 15d)', () => {
  const requiredViteVars = parseRequiredViteVars(readFileSync(ENV_TS_PATH, 'utf8'))
  const ciYml = readFileSync(CI_YML_PATH, 'utf8')
  const entries = splitMatrixEntries(ciYml)

  test('web/src/env.ts requires at least one VITE_* var (regex is not silently matching nothing)', () => {
    expect(requiredViteVars.length).toBeGreaterThan(0)
  })

  test('the matrix splits into at least one entry, and one of them is "web" (regex is not silently matching nothing)', () => {
    expect(entries.size).toBeGreaterThan(0)
    expect(entries.has('web')).toBe(true)
  })

  test('the web matrix entry carries every VITE_* var env.ts requires', () => {
    const webEntry = entries.get('web')!
    for (const name of requiredViteVars) {
      expect([name, webEntry.includes(`${name}=`)]).toEqual([name, true])
    }
  })

  test('no service leg (every entry except "web") carries any VITE_* build arg', () => {
    for (const [name, raw] of entries) {
      if (name === 'web') continue
      for (const viteVar of requiredViteVars) {
        expect([name, viteVar, raw.includes(viteVar)]).toEqual([name, viteVar, false])
      }
    }
  })

  test('no service leg declares a buildArgs key at all', () => {
    for (const [name, raw] of entries) {
      if (name === 'web') continue
      expect([name, raw.includes('buildArgs')]).toEqual([name, false])
    }
  })
})
