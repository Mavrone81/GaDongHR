import { createContext, useContext, useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { Locale } from './locale'
import { detectInitialLocale, storeLocale } from './locale'
import { fetchBundle } from '../api/svcI18n'
import { FALLBACK_BUNDLE } from './fallbackBundle'

export type Bundle = Record<string, string>
export type TranslateVars = Record<string, string | number>

export interface I18nContextValue {
  locale: Locale
  setLocale: (locale: Locale) => void
  /**
   * Resolves one bundle key, interpolating `{name}` placeholders from
   * `vars`. Every user-visible string in this app is required to go
   * through this function — see `web/README.md`'s "no hard-coded strings"
   * rule and `src/i18n/noHardcodedStrings.test.tsx`, which enforces it
   * mechanically.
   *
   * FALLBACK CHAIN (the fix for the "blank screen when svc-i18n is
   * unreachable" defect — see `I18nProvider` below):
   *
   *   1. The requested locale's fetched bundle (mirrors `svc-i18n`'s own
   *      `BundlesService.resolveKey`, `services/svc-i18n/src/bundles.service.ts`
   *      — the server itself already resolves a `th`/`zh` gap against `en`
   *      before this app ever sees the response).
   *   2. A separately fetched `en` bundle, for the case the primary fetch
   *      itself is incomplete or failed while an `en` fetch still succeeds.
   *   3. `FALLBACK_BUNDLE` (`./fallbackBundle.ts`) — the Thai bundle
   *      compiled INTO this app at build time, used only when every network
   *      path above failed or is missing the key. Thai, not English,
   *      because this product's default language is Thai (`i18n/locale.ts`)
   *      — the last-resort text has to match the audience it exists to
   *      protect, not silently hand everyone English the one time the
   *      network is down. This is what keeps the login screen legible with
   *      zero backend running at all.
   *   4. The raw key string itself — ugly, but diagnosable; never `''`.
   *
   * Never returns an empty string: an empty label is invisible (the exact
   * defect this chain exists to prevent), a raw key is at least readable.
   */
  t: (key: string, vars?: TranslateVars) => string
  ready: boolean
}

const I18nContext = createContext<I18nContextValue | null>(null)

function interpolate(template: string, vars?: TranslateVars): string {
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = vars[name]
    return value === undefined ? match : String(value)
  })
}

/**
 * Builds a `t()` from a plain bundle map, with no React/fetch involved —
 * the same resolution `I18nProvider` uses internally, exported so tests can
 * construct a full `I18nContextValue` (via `src/test/testUtils.tsx`)
 * without mounting a real provider or mocking `fetch`.
 */
export function createTranslator(bundle: Bundle): (key: string, vars?: TranslateVars) => string {
  return (key, vars) => interpolate(bundle[key] ?? key, vars)
}

export function I18nProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [locale, setLocaleState] = useState<Locale>(() => detectInitialLocale())
  // Two independently-tracked network layers, resolved in this order by
  // `t()` below: the requested locale's own fetch, then (only relevant when
  // `locale !== 'en'`) a separately fetched `en` bundle. Kept as two
  // `Bundle | null` values rather than merged eagerly, so `t()` can apply
  // the exact "requested locale -> fetched English -> bundled English ->
  // raw key" order per key, not per whole-bundle merge.
  const [localeBundle, setLocaleBundle] = useState<Bundle | null>(null)
  const [englishBundle, setEnglishBundle] = useState<Bundle | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    setReady(false)

    const localeFetch = fetchBundle(locale)
    // When the requested locale IS English, re-using the same promise
    // (rather than issuing a second, identical request) means this only
    // ever makes one network call — `Promise.allSettled` below is fine
    // awaiting the same promise object twice.
    const englishFetch = locale === 'en' ? localeFetch : fetchBundle('en')

    Promise.allSettled([localeFetch, englishFetch]).then(([localeResult, englishResult]) => {
      if (cancelled) return

      const localeFailed = localeResult.status === 'rejected'
      const englishFailed = locale !== 'en' && englishResult.status === 'rejected'
      if (localeFailed || englishFailed) {
        // Exactly ONE warning naming what failed — never one per missing
        // key (that would fire dozens of times for a single dead backend;
        // `t()` below logs nothing at all). This is the "svc-i18n
        // unreachable" case that used to render a blank screen: every
        // affected `t()` call still resolves through `FALLBACK_BUNDLE`
        // (bundled at build time, Thai) or, failing that, the raw key —
        // never `''`.
        console.warn(
          `[i18n] could not fetch translations for locale "${locale}" from svc-i18n — falling back to the Thai bundle shipped with the app.`,
        )
      }

      setLocaleBundle(localeResult.status === 'fulfilled' ? localeResult.value : null)
      setEnglishBundle(englishResult.status === 'fulfilled' ? englishResult.value : null)
      setReady(true)
    })

    return () => {
      cancelled = true
    }
  }, [locale])

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  const setLocale = useCallback((next: Locale) => {
    storeLocale(next)
    setLocaleState(next)
  }, [])

  const t = useCallback(
    (key: string, vars?: TranslateVars): string => {
      const value = localeBundle?.[key] ?? englishBundle?.[key] ?? FALLBACK_BUNDLE[key] ?? key
      return interpolate(value, vars)
    },
    [localeBundle, englishBundle],
  )

  const value = useMemo<I18nContextValue>(() => ({ locale, setLocale, t, ready }), [locale, setLocale, t, ready])

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useI18n must be used within an I18nProvider')
  return ctx
}

/** Exported for `src/test/testUtils.tsx` only, so tests can supply a fully-controlled `I18nContextValue` without mounting a real provider or mocking `fetch`. */
export { I18nContext }
