import { Injectable, Logger } from '@nestjs/common'
import type { Locale } from '@gadong/kernel'
import { flattenBundle } from './flatten'
import type { FlatBundle } from './flatten'

/** The three locales this whole product ships in — see kernel `i18n/format.ts`'s `Locale`, reused here rather than redeclared. */
export const SUPPORTED_LOCALES: readonly Locale[] = ['th', 'en', 'zh']

export interface RawBundles {
  th: unknown
  en: unknown
  zh: unknown
}

export interface MissingKeyCounts {
  th: number
  en: number
  zh: number
}

/**
 * The subset of Nest's `Logger` this service actually calls. Accepting the
 * narrow shape (rather than importing `Logger` as a hard dependency type)
 * makes it trivial for tests to inject a `{ warn: jest.fn() }` double and
 * assert on exactly what gets logged, per Task 10 brief: "Fallback chain:
 * th-missing → en value + warning logged".
 */
export interface WarnLogger {
  warn(message: string): void
}

/**
 * Loads the three bundles once at construction (Task 10 brief: "loaded at
 * boot"), flattens each to `"namespace.key" -> string`, and serves lookups
 * with the fallback chain that is this service's entire reason to exist:
 *
 *   1. Key present in the requested locale → that value.
 *   2. Missing in `th` or `zh` → the `en` value, AND a warning is logged
 *      naming the key and the locale it was missing from.
 *   3. Missing in `en` too → the key string itself. Never `''`, never
 *      `undefined` — an empty label is invisible in the UI; a raw key is at
 *      least diagnosable (Task 10 brief, "Missing-key behaviour").
 *
 * `en` is treated as the canonical key set (I18N-GUIDE.md §1 rule 9: "en is
 * the source language") — the bundle a locale is served with, and the
 * parity check, are both built by walking `en`'s keys, not the union of all
 * three files.
 */
@Injectable()
export class BundlesService {
  private readonly bundles: Record<Locale, FlatBundle>
  private readonly missingKeyCounts: MissingKeyCounts

  constructor(
    raw: RawBundles,
    private readonly logger: WarnLogger = new Logger('svc-i18n'),
  ) {
    this.bundles = {
      th: flattenBundle(raw.th),
      en: flattenBundle(raw.en),
      zh: flattenBundle(raw.zh),
    }
    this.missingKeyCounts = {
      th: this.missingKeys('th').length,
      en: this.missingKeys('en').length,
      zh: this.missingKeys('zh').length,
    }
  }

  static isSupportedLocale(locale: string): locale is Locale {
    return (SUPPORTED_LOCALES as readonly string[]).includes(locale)
  }

  /**
   * Keys present in `en` (the canonical set) but absent from `locale`'s own
   * bundle. Always `[]` for `en` itself. This is the exact list the parity
   * test asserts is empty for `th` and `zh` — and, when it isn't, names
   * every offending key rather than only a count (Task 10 brief: "must fail
   * loudly and NAME the missing keys, not just report a count").
   */
  missingKeys(locale: Locale): string[] {
    if (locale === 'en') return []
    const localeBundle = this.bundles[locale]
    return Object.keys(this.bundles.en).filter((key) => localeBundle[key] === undefined)
  }

  /** Snapshot computed once at construction — `GET /health` reports this so the gap is measurable, not discovered by a user (Task 10 brief). */
  getMissingKeyCounts(): MissingKeyCounts {
    return { ...this.missingKeyCounts }
  }

  /** Resolves one key for one locale, applying the fallback chain documented on the class. Never throws. */
  resolveKey(locale: Locale, key: string): string {
    const direct = this.bundles[locale][key]
    if (direct !== undefined) return direct

    if (locale !== 'en') {
      this.logger.warn(`svc-i18n: missing key "${key}" in locale "${locale}" — falling back to en`)
      const enValue = this.bundles.en[key]
      if (enValue !== undefined) return enValue
    }

    return key
  }

  /**
   * The full (or namespace-filtered) bundle for `locale`, with every key
   * resolved through the fallback chain above. Iterates `en`'s key set, not
   * `locale`'s own — so a locale bundle missing a key still returns it
   * (falling back), rather than silently omitting it from the response.
   */
  getBundle(locale: Locale, namespace?: string): FlatBundle {
    const prefix = namespace ? `${namespace}.` : undefined
    const result: FlatBundle = {}
    for (const key of Object.keys(this.bundles.en)) {
      if (prefix && !key.startsWith(prefix)) continue
      result[key] = this.resolveKey(locale, key)
    }
    return result
  }

  /** `glossary.*` keys, zipped across all three locales — the payload for `GET /glossary` (Task 10 brief's HR glossary, I18N-GUIDE.md §2). */
  getGlossary(): Array<{ key: string; en: string; th: string; zh: string }> {
    const glossaryKeys = Object.keys(this.bundles.en).filter((key) => key.startsWith('glossary.'))
    return glossaryKeys.map((key) => ({
      key: key.slice('glossary.'.length),
      en: this.resolveKey('en', key),
      th: this.resolveKey('th', key),
      zh: this.resolveKey('zh', key),
    }))
  }
}
