import thJson from './fallbackBundle.th.json';
import enJson from './fallbackBundle.en.json';
import zhJson from './fallbackBundle.zh.json';
import mobileStrings from './mobileStrings.json';
import { flattenBundle } from './flattenBundle';
import type { FlatBundle } from './flattenBundle';
import type { Locale } from './locale';

/**
 * Bundled-with-the-app, offline-usable translations, keyed by locale —
 * `I18nContext.tsx`'s last resort before a raw key. This is a DELIBERATE
 * departure from `web/src/i18n/fallbackBundle.ts`, which ships Thai only;
 * read that file's header first for why (previously bundling English
 * meant every locale silently got English the moment svc-i18n was
 * unreachable — wrong for a Thai-first product).
 *
 * Mobile ships all three because it needs to anyway: `mobileStrings.json`
 * below carries UI text for concepts this app introduces that
 * `services/svc-i18n/bundles/*.json` does not have yet (tab labels, the
 * punch/timesheet/leave/payslip/kiosk screens — this task's brief adds a
 * worker-facing surface `svc-i18n`'s existing bundles were never written
 * for, and this task's boundary is explicit: "do NOT edit services/").
 * Since a real, hand-written translation has to exist for each of those
 * new keys in all three languages regardless, bundling the CANONICAL
 * per-locale files alongside them costs nothing extra and is strictly
 * better coverage than Thai-only: a fully offline English-preferring user
 * now sees bundled English (their own stored choice, honored even with no
 * network) rather than being forced into Thai — not a repeat of the
 * defect web's header describes (that defect was "override everyone's
 * preference to English no matter what"; this is "honor each user's own
 * already-chosen locale in the fallback too").
 *
 * `fallbackBundle.{th,en,zh}.json` are byte-for-byte copies of
 * `services/svc-i18n/bundles/{th,en,zh}.json` — kept honest by
 * `fallbackBundle.sync.test.ts`, one assertion per locale.
 * `mobileStrings.json`'s `mobile.*` keys are NOT present in any canonical
 * bundle (by construction — the sync test only compares the overlapping,
 * canonical portion) and are proposed as a follow-up PR into
 * `services/svc-i18n/bundles/*.json` for the controller — see
 * `.superpowers/sdd/02-modules/mobile-app.md`.
 */
const CANONICAL_JSON: Record<Locale, unknown> = { th: thJson, en: enJson, zh: zhJson };

function mobileFlat(locale: Locale): FlatBundle {
  const perLocale = (mobileStrings as Record<Locale, unknown>)[locale];
  return perLocale ? flattenBundle(perLocale) : {};
}

function buildBundle(locale: Locale): FlatBundle {
  return { ...flattenBundle(CANONICAL_JSON[locale]), ...mobileFlat(locale) };
}

export const FALLBACK_BUNDLES: Record<Locale, FlatBundle> = {
  th: buildBundle('th'),
  en: buildBundle('en'),
  zh: buildBundle('zh'),
};

/** The Thai bundle alone — the ultimate last resort when even `FALLBACK_BUNDLES[locale]` (e.g. a corrupt/partial locale bundle) misses a key, matching web's "Thai is the final fallback" doctrine. */
export const FALLBACK_BUNDLE: FlatBundle = FALLBACK_BUNDLES.th;
