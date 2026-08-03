import fallbackBundleJson from './fallbackBundle.en.json'
import { flattenBundle } from './flattenBundle'
import type { FlatBundle } from './flattenBundle'

/**
 * The English bundle, shipped WITH the app as a compile-time import — never
 * fetched. This is the last resort in `I18nContext.tsx`'s fallback chain
 * (`requested locale -> fetched English -> BUNDLED English -> the raw
 * key`): when svc-i18n is unreachable (no backend running at all — the
 * "blank screen" defect this file exists to fix, since a plain-object
 * fetch failure used to collapse every `t()` call to `''`) or simply
 * hasn't shipped a key yet, every `t()` call still resolves to real,
 * readable English text instead of an invisible empty string.
 *
 * `fallbackBundle.en.json` is a vendored, byte-for-byte copy of
 * `services/svc-i18n/bundles/en.json` — kept in sync by
 * `fallbackBundle.sync.test.ts`, which fails loudly (naming this exact
 * file and the drifted key) the moment the two disagree. It is a copy
 * rather than a direct import of the canonical file because that file
 * lives outside `web`'s TypeScript `rootDir` (`web/tsconfig.json`'s
 * composite build) and outside Vite's dev-server filesystem boundary —
 * importing across that line breaks both `tsc -b` and `vite build`. This
 * app owns both files (see this task's brief), so keeping them identical
 * is a one-copy-command chore whenever `en.json` changes, mechanically
 * checked rather than trusted to memory.
 */
export const FALLBACK_EN_BUNDLE: FlatBundle = flattenBundle(fallbackBundleJson)
