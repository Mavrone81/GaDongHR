import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FALLBACK_EN_BUNDLE } from './fallbackBundle'
import { flattenBundle } from './flattenBundle'

/**
 * `fallbackBundle.en.json` (this directory) is a vendored copy of
 * `services/svc-i18n/bundles/en.json` — `fallbackBundle.ts`'s header
 * explains why it is a copy rather than a cross-package import. A copy
 * with no automatic sync is a drift risk: this test IS the sync mechanism,
 * failing loudly and naming the exact missing/differing keys the moment
 * someone edits one file and not the other (a new `t('...')` key added to
 * `services/svc-i18n/bundles/en.json` per this task's other half, but
 * never copied here — or vice versa).
 */
const CANONICAL_EN_PATH = join(__dirname, '..', '..', '..', 'services', 'svc-i18n', 'bundles', 'en.json')

describe('web/src/i18n/fallbackBundle.en.json stays in sync with services/svc-i18n/bundles/en.json', () => {
  it('flattens to the exact same key/value map as the canonical en bundle', () => {
    const canonicalRaw: unknown = JSON.parse(readFileSync(CANONICAL_EN_PATH, 'utf-8'))
    const canonicalFlat = flattenBundle(canonicalRaw)

    expect(FALLBACK_EN_BUNDLE).toEqual(canonicalFlat)
  })

  it('is non-empty (parser/fixture sanity)', () => {
    expect(Object.keys(FALLBACK_EN_BUNDLE).length).toBeGreaterThan(0)
  })
})
