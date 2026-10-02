import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * Every `@sha256:` pin in a tracked compose file must be a real digest —
 * exactly 64 lowercase hex characters.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT THE SAME AS THE DEPLOY-TIME CHECK.
 * `deploy/scripts/assert-images-available.sh` already refuses an unresolved
 * or unobtainable image, and `compose pull` under `set -e` fails on an
 * invalid reference. Both of those are correct and both run at DEPLOY time —
 * on the box, inside the release window. Nothing in `.github/workflows/ci.yml`
 * invokes either (measured: 0 mentions of `assert-images-available`,
 * `compose config` or `sha256` in its 320 lines), so a branch carrying a
 * non-functional image reference merges GREEN and the failure surfaces under
 * release pressure.
 *
 * Fail-closed answers "will it break safely". It does not answer "WHEN will we
 * find out". This moves the answer to merge time.
 *
 * The second-order cost is the one worth naming: the e2e suite keeps passing
 * with a broken pin, so its greenness stops implying the stack can start.
 *
 * It is deliberately HERMETIC — pure file reads, no registry, no network, no
 * docker — so it runs in CI's `verify` job via the existing `pnpm test`, and
 * locally, without the docker dependency `compose-validation.test.ts` needs.
 *
 * And it is deliberately a SHAPE check rather than a check for the current
 * placeholder's text: keyed on the literal
 * `sha256:UNRESOLVED-PENDING-MIRROR-PUBLISH` it would pass the day someone
 * truncates a real digest or pastes one with an uppercase character. The shape
 * rule catches a future malformed pin that no by-name check could.
 */

const DEPLOY_DIR = __dirname
const REPO_ROOT = join(DEPLOY_DIR, '..')

/**
 * The compose files to scan are DERIVED, not listed.
 *
 * A hard-coded list closed "a listed file vanished" and left "a new compose file
 * was never listed" wide open — and an override file is exactly what someone adds
 * without thinking to update a constant in a test. A 5th
 * `docker-compose.override.yml` carrying a malformed pin would have been invisible.
 *
 * ⚠ But deriving ALONE trades one blind spot for another: a glob that matches
 * nothing passes vacuously, which is the defect this suite has already been
 * corrected for twice. So the derived set is also asserted to be a SUPERSET of the
 * four paths known to exist today, and to be non-empty. Derive-plus-superset has
 * neither blind spot: a new file is picked up, and a broken derivation is caught.
 */
const KNOWN_COMPOSE_FILES = [
  join(DEPLOY_DIR, 'docker-compose.yml'),
  join(DEPLOY_DIR, 'docker-compose.prod.yml'),
  join(DEPLOY_DIR, 'docker-compose.eventbus-test.yml'),
  join(REPO_ROOT, 'test', 'e2e', 'docker-compose.yml'),
]

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.next', 'build'])
const COMPOSE_NAME = /^docker-compose[^/]*\.ya?ml$/

function deriveComposeFiles(dir: string, found: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return found
  }
  for (const name of entries) {
    const full = join(dir, name)
    let isDir = false
    try {
      isDir = statSync(full).isDirectory()
    } catch {
      continue
    }
    if (isDir) {
      if (!SKIP_DIRS.has(name)) deriveComposeFiles(full, found)
    } else if (COMPOSE_NAME.test(name)) {
      found.push(full)
    }
  }
  return found
}

const COMPOSE_FILES = deriveComposeFiles(REPO_ROOT).sort()

/** `name@sha256:<anything up to the next whitespace or quote>` — captured loosely ON PURPOSE, so a
 *  malformed pin is CAUGHT here rather than skipped by a strict pattern that only matches valid ones. */
const DIGEST_REF = /@sha256:([^\s"']*)/g
const VALID_DIGEST = /^[0-9a-f]{64}$/

interface Pin {
  file: string
  line: number
  value: string
}

function collectPins(): { pins: Pin[]; filesRead: number; bytesRead: number } {
  const pins: Pin[] = []
  let filesRead = 0
  let bytesRead = 0
  for (const f of COMPOSE_FILES) {
    if (!existsSync(f)) continue
    const text = readFileSync(f, 'utf8')
    filesRead += 1
    bytesRead += text.length
    text.split('\n').forEach((lineText, i) => {
      for (const m of lineText.matchAll(DIGEST_REF)) {
        pins.push({ file: f.replace(`${REPO_ROOT}/`, ''), line: i + 1, value: m[1] ?? '' })
      }
    })
  }
  return { pins, filesRead, bytesRead }
}

describe('compose image pins are real digests (hermetic — no registry, no docker)', () => {
  const { pins, filesRead, bytesRead } = collectPins()
  // NOTE: a third test here once asserted `valid + invalid === total`. That is a
  // tautology — a partition always sums to the whole, including over zero pins —
  // so it was a green tick implying verification and supplying none, sitting
  // directly below a guard that does real work. Removed rather than reworded.
  // The test to apply: what input would make this line fail? If the answer is
  // "none", strengthen it or delete it.

  // A zero needs a non-empty haystack: without this, a wrong path would make the
  // assertion below pass over nothing at all.
  //
  // THREE SEPARATE PROPERTIES, asserted separately rather than collapsed: the
  // derived set is non-empty, every known file is PRESENT, and none of them is
  // MISSED BY THE DERIVATION. Collapsing presence into the superset condition is
  // how the presence property was lost once already — see the note on `absent`.
  test('the derived compose-file set is non-empty, covers every known file, and was read', () => {
    // Non-empty: a derivation that matched nothing would make the pin assertion
    // below pass over zero pins.
    expect(COMPOSE_FILES.length).toBeGreaterThan(0)

    // PRESENT: every known compose file still exists. This is a separate property
    // from the superset check below and must not be folded into it — an earlier
    // version wrote `existsSync(f) && !derived.has(f)`, and that `existsSync(f) &&`
    // filtered out precisely the file that had gone, so deleting or renaming a
    // watched compose file left the suite green while one of four files was no
    // longer scanned at all.
    //
    // The cost is deliberate and correct: deleting a watched file now fails until
    // KNOWN_COMPOSE_FILES is updated. Removing a file from the set being guarded
    // should require editing the list that names it.
    const absent = KNOWN_COMPOSE_FILES.filter((f) => !existsSync(f)).map((f) => relative(REPO_ROOT, f))
    expect(absent).toEqual([])

    // SUPERSET: of the known files, none is missed by the derivation. Catches a
    // scan that silently stopped finding files (a renamed directory, a changed
    // name pattern, a skip-list entry added too broadly) rather than trusting it.
    const derived = new Set(COMPOSE_FILES)
    const missingKnown = KNOWN_COMPOSE_FILES.filter((f) => !derived.has(f)).map((f) => relative(REPO_ROOT, f))
    expect(missingKnown).toEqual([])

    // And every derived file was actually opened and had content.
    expect(filesRead).toBe(COMPOSE_FILES.length)
    expect(bytesRead).toBeGreaterThan(1000)
  })

  test('every @sha256: pin is exactly 64 lowercase hex characters', () => {
    const bad = pins.filter((p) => !VALID_DIGEST.test(p.value))
    expect(
      bad.map((p) => `${p.file}:${p.line} -> @sha256:${p.value || '<empty>'}`),
    ).toEqual([])
  })

})
