import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FALLBACK_BUNDLES } from './fallbackBundle';
import { flattenBundle } from './flattenBundle';
import type { FlatBundle } from './flattenBundle';
import type { Locale } from './locale';

/**
 * Mirrors `web/src/i18n/fallbackBundle.sync.test.tsx`, extended to all
 * three locales (mobile bundles th/en/zh — see `fallbackBundle.ts`'s
 * header for why). For each locale this asserts every CANONICAL key
 * (`services/svc-i18n/bundles/<locale>.json`) is present with the exact
 * same value in `FALLBACK_BUNDLES[locale]` — a subset check, not exact
 * equality, because `FALLBACK_BUNDLES[locale]` additionally carries this
 * app's own `mobile.*` keys (`mobileStrings.json`) that no canonical
 * bundle has yet. A missing/drifted CANONICAL key still fails loudly,
 * naming the exact key, the moment `services/svc-i18n/bundles/*.json`
 * changes and the vendored copy here does not.
 */
const LOCALES: readonly Locale[] = ['th', 'en', 'zh'];

function canonicalPath(locale: Locale): string {
  return join(__dirname, '..', '..', '..', '..', 'services', 'svc-i18n', 'bundles', `${locale}.json`);
}

describe('mobile/src/lib/i18n/fallbackBundle.*.json stay in sync with services/svc-i18n/bundles/*.json', () => {
  for (const locale of LOCALES) {
    it(`${locale}: every canonical key is present with the same value in FALLBACK_BUNDLES.${locale}`, () => {
      const canonicalRaw: unknown = JSON.parse(readFileSync(canonicalPath(locale), 'utf-8'));
      const canonicalFlat: FlatBundle = flattenBundle(canonicalRaw);
      const mobileBundle = FALLBACK_BUNDLES[locale];

      const mismatched = Object.entries(canonicalFlat).filter(([key, value]) => mobileBundle[key] !== value);
      expect(mismatched).toEqual([]);
    });

    it(`${locale}: is non-empty (parser/fixture sanity)`, () => {
      expect(Object.keys(FALLBACK_BUNDLES[locale]).length).toBeGreaterThan(0);
    });
  }
});
