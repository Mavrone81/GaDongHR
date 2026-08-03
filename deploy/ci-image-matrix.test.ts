import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Task 15: the whole point of `.github/workflows/ci.yml`'s `build-images`
 * matrix is that every image `deploy/docker-compose.prod.yml` (and, once
 * later tasks wire them up, `docker-compose.yml`) can ever reference
 * actually gets built and pushed. "A service added later without a CI
 * entry would otherwise deploy as a stale or missing tag, and nothing
 * would fail until runtime" (task brief) — so this suite parses the real
 * files instead of hard-coding either list, the same way
 * `deploy/compose-validation.test.ts` shells out to `docker compose
 * config` instead of asserting against a copy-pasted expectation.
 *
 * Two independent checks, not one blanket equality, because the two
 * "sides" are not supposed to be equal *yet*:
 *
 *   1. CI matrix vs. `services/*` on disk (plus `web`) — these MUST be
 *      exactly equal. Task 15's job is "build every image that exists",
 *      full stop; a mismatch here is either a typo in the matrix or a
 *      new service directory nobody wired into CI.
 *
 *   2. Every image `docker-compose.prod.yml` references MUST be a subset
 *      of the CI matrix — this is the actual "3am deploy fails" bug the
 *      brief describes. The reverse is NOT asserted: as of Task 15, only
 *      the seven original platform services are registered in
 *      `docker-compose.yml`/`docker-compose.prod.yml`
 *      (`deploy/compose-validation.test.ts`'s own hard-coded fourteen-name
 *      expectation explicitly excludes the M1-M7 module services and
 *      `web` — "Module services M1-M7 must NOT appear"). CI legitimately
 *      builds eight service images and `web` that nothing deploys yet;
 *      that is images-ready-before-infra-catches-up, not drift. The
 *      dangerous direction — compose referencing a tag CI never
 *      builds — is exactly what test 2 rules out.
 */

const REPO_ROOT = join(__dirname, '..')
const CI_YML_PATH = join(REPO_ROOT, '.github', 'workflows', 'ci.yml')
const COMPOSE_PROD_PATH = join(REPO_ROOT, 'deploy', 'docker-compose.prod.yml')
const SERVICES_DIR = join(REPO_ROOT, 'services')

/**
 * Extracts `{ name: <x>, dockerfile: <y> }` matrix entries from the
 * `build-images` job. Deliberately narrow (not a general YAML parser) so
 * it can't accidentally pick up an unrelated `name:` key elsewhere in the
 * workflow (e.g. the top-level `name: ci`).
 */
function parseCiMatrix(ciYml: string): Array<{ name: string; dockerfile: string }> {
  const entries: Array<{ name: string; dockerfile: string }> = []
  const pattern = /-\s*\{\s*name:\s*([\w-]+)\s*,\s*dockerfile:\s*([\w./-]+)\s*\}/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(ciYml)) !== null) {
    const [, name, dockerfile] = match
    if (name && dockerfile) entries.push({ name, dockerfile })
  }
  return entries
}

/** Extracts every `ghcr.io/mavrone81/gadonghr-<name>` image repository referenced. */
function parseComposeImageNames(composeYml: string): string[] {
  const names = new Set<string>()
  const pattern = /ghcr\.io\/mavrone81\/gadonghr-([\w-]+):/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(composeYml)) !== null) {
    const [, name] = match
    if (name) names.add(name)
  }
  return [...names].sort()
}

describe('CI image matrix vs. actual services on disk', () => {
  const ciYml = readFileSync(CI_YML_PATH, 'utf8')
  const matrixEntries = parseCiMatrix(ciYml)

  test('the matrix parses to at least one entry (regex is not silently matching nothing)', () => {
    expect(matrixEntries.length).toBeGreaterThan(0)
  })

  test('every services/* directory (plus `web`) has exactly one matrix entry, and vice versa', () => {
    const serviceDirs = readdirSync(SERVICES_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
    const expectedNames = [...serviceDirs, 'web'].sort()
    const actualNames = matrixEntries.map((e) => e.name).sort()
    expect(actualNames).toEqual(expectedNames)
  })

  test('no duplicate name in the matrix', () => {
    const names = matrixEntries.map((e) => e.name)
    expect(new Set(names).size).toBe(names.length)
  })

  test('every matrix entry points at a Dockerfile that actually exists', () => {
    for (const { name, dockerfile } of matrixEntries) {
      expect([name, existsSync(join(REPO_ROOT, dockerfile))]).toEqual([name, true])
    }
  })

  test('every matrix entry\'s dockerfile path matches its name (services/<name>/Dockerfile, or web/Dockerfile)', () => {
    for (const { name, dockerfile } of matrixEntries) {
      const expected = name === 'web' ? 'web/Dockerfile' : `services/${name}/Dockerfile`
      expect([name, dockerfile]).toEqual([name, expected])
    }
  })
})

describe('docker-compose.prod.yml images vs. the CI matrix', () => {
  const ciYml = readFileSync(CI_YML_PATH, 'utf8')
  const matrixNames = new Set(parseCiMatrix(ciYml).map((e) => e.name))
  const composeYml = readFileSync(COMPOSE_PROD_PATH, 'utf8')
  const composeNames = parseComposeImageNames(composeYml)

  test('the prod overlay references at least one gadonghr- image (regex is not silently matching nothing)', () => {
    expect(composeNames.length).toBeGreaterThan(0)
  })

  test('every image docker-compose.prod.yml references has a corresponding CI matrix entry', () => {
    // The safety-critical direction (see file header): a compose image
    // with no CI build would deploy a tag that has never been pushed —
    // exactly the 3am failure the brief describes. The reverse (CI
    // building images compose does not reference yet) is expected and
    // fine at this stage of the roadmap.
    const missing = composeNames.filter((name) => !matrixNames.has(name))
    expect(missing).toEqual([])
  })
})
