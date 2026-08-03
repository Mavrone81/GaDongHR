import { createContext, useContext, useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { Locale } from './locale'
import { detectInitialLocale, storeLocale } from './locale'
import { fetchBundle } from '../api/svcI18n'

export type Bundle = Record<string, string>
export type TranslateVars = Record<string, string | number>

export interface I18nContextValue {
  locale: Locale
  setLocale: (locale: Locale) => void
  /**
   * Resolves one bundle key, interpolating `{name}` placeholders from
   * `vars`. Every user-visible string in this app is required to go
   * through this function — see `web/README.md`'s "no hard-coded strings"
   * rule and `src/i18n/__tests__/no-hardcoded-strings.test.tsx`, which
   * enforces it mechanically.
   *
   * Fallback (deliberately mirrors `svc-i18n`'s own `BundlesService.resolveKey`,
   * `services/svc-i18n/src/bundles.service.ts`): a key absent from the
   * fetched bundle renders as the key string itself, never a hardcoded
   * English literal baked into this file. Some keys this app calls (the
   * `admin.statutoryRules.*`, `config.error.*`, `authz.error.*` and
   * `shell.*` namespaces the statutory-rules console needs) do not exist in
   * `services/svc-i18n/bundles/*.json` yet — extending that content is
   * svc-i18n's own workstream, out of this task's "own web/, don't touch
   * services/" boundary. Every call site still only ever calls `t(key)`;
   * the raw-key fallback is what renders today, and it upgrades to a real
   * translation the moment svc-i18n ships one, with no code change here.
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
  const [bundle, setBundle] = useState<Bundle | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    setReady(false)
    fetchBundle(locale)
      .then((data) => {
        if (!cancelled) {
          setBundle(data)
          setReady(true)
        }
      })
      .catch(() => {
        if (!cancelled) {
          // Network/service failure: fall back to an empty bundle so `t()`
          // still returns diagnosable raw keys instead of throwing —
          // the app stays usable (if unlabeled) rather than blank.
          setBundle({})
          setReady(true)
        }
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
    (key: string, vars?: TranslateVars): string => createTranslator(bundle ?? {})(key, vars),
    [bundle],
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
