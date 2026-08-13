import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FALLBACK_BUNDLE } from './fallbackBundle'
import { flattenBundle } from './flattenBundle'

/**
 * `fallbackBundle.th.json` (this directory) is a vendored copy of
 * `services/svc-i18n/bundles/th.json` — `fallbackBundle.ts`'s header
 * explains why it is a copy rather than a cross-package import, and why
 * the bundled fallback is Thai (not English) now that Thai is this app's
 * default language (task brief). A copy with no automatic sync is a drift
 * risk: this test IS the sync mechanism, failing loudly and naming the
 * exact missing/differing keys the moment someone edits one file and not
 * the other (a new `t('...')` key added to `services/svc-i18n/bundles/th.json`
 * per this task's other half, but never copied here — or vice versa).
 */
const CANONICAL_TH_PATH = join(__dirname, '..', '..', '..', 'services', 'svc-i18n', 'bundles', 'th.json')

describe('web/src/i18n/fallbackBundle.th.json stays in sync with services/svc-i18n/bundles/th.json', () => {
  it('flattens to the exact same key/value map as the canonical th bundle', () => {
    const canonicalRaw: unknown = JSON.parse(readFileSync(CANONICAL_TH_PATH, 'utf-8'))
    const canonicalFlat = flattenBundle(canonicalRaw)

    expect(FALLBACK_BUNDLE).toEqual(canonicalFlat)
  })

  it('is non-empty (parser/fixture sanity)', () => {
    expect(Object.keys(FALLBACK_BUNDLE).length).toBeGreaterThan(0)
  })
})
