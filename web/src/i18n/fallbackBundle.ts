import fallbackBundleJson from './fallbackBundle.th.json'
import { flattenBundle } from './flattenBundle'
import type { FlatBundle } from './flattenBundle'

/**
 * The Thai bundle, shipped WITH the app as a compile-time import — never
 * fetched. This is the last resort in `I18nContext.tsx`'s fallback chain
 * (`requested locale -> fetched English -> BUNDLED Thai -> the raw key`):
 * when svc-i18n is unreachable (no backend running at all — the "blank
 * screen" defect this file exists to fix, since a plain-object fetch
 * failure used to collapse every `t()` call to `''`) or simply hasn't
 * shipped a key yet, every `t()` call still resolves to real, readable
 * text instead of an invisible empty string.
 *
 * Thai, not English (task brief: "As it is Thai so the default language
 * must be Thai" — see `i18n/locale.ts`'s `detectInitialLocale` for the
 * matching decision on the default *requested* locale). The previous
 * version of this file bundled English, which meant that the moment
 * svc-i18n was unreachable, EVERY user — including Thai-speaking staff who
 * never asked for English — silently landed on English with no way to
 * change it (this app's login screen, the one place to switch language
 * pre-auth, is itself rendered through this exact fallback chain). A
 * Thai-first product's last-resort text has to be Thai for that fallback
 * to be usable by the audience it exists to protect.
 *
 * `fallbackBundle.th.json` is a vendored, byte-for-byte copy of
 * `services/svc-i18n/bundles/th.json` — kept in sync by
 * `fallbackBundle.sync.test.ts`, which fails loudly (naming this exact
 * file and the drifted key) the moment the two disagree. It is a copy
 * rather than a direct import of the canonical file because that file
 * lives outside `web`'s TypeScript `rootDir` (`web/tsconfig.json`'s
 * composite build) and outside Vite's dev-server filesystem boundary —
 * importing across that line breaks both `tsc -b` and `vite build`. This
 * app owns both files (see this task's brief), so keeping them identical
 * is a one-copy-command chore whenever `th.json` changes, mechanically
 * checked rather than trusted to memory.
 */
export const FALLBACK_BUNDLE: FlatBundle = flattenBundle(fallbackBundleJson)
