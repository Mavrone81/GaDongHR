import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

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

/** Tracked compose files. `eventbus-test` is a ports-only overlay and declares no image. */
const COMPOSE_FILES = [
  join(DEPLOY_DIR, 'docker-compose.yml'),
  join(DEPLOY_DIR, 'docker-compose.prod.yml'),
  join(DEPLOY_DIR, 'docker-compose.eventbus-test.yml'),
  join(REPO_ROOT, 'test', 'e2e', 'docker-compose.yml'),
]

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
  // EXACT coverage, not a floor. `>= 3` of four would have TOLERATED ONE MISSING
  // FILE — so a compose file renamed or moved would be silently skipped and this
  // suite would still go green, which is precisely the failure it exists to catch.
  // Every intended path must be present, and the missing ones are NAMED.
  test('every compose file this suite intends to check is present and was read', () => {
    const missing = COMPOSE_FILES.filter((f) => !existsSync(f)).map((f) => f.replace(`${REPO_ROOT}/`, ''))
    expect(missing).toEqual([])
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
