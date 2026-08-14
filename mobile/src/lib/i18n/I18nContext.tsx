import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Locale } from './locale';
import { DEFAULT_LOCALE, loadStoredLocale, storeLocale } from './locale';
import { fetchBundle } from '../../api/svcI18n';
import { FALLBACK_BUNDLES } from './fallbackBundle';

export type Bundle = Record<string, string>;
export type TranslateVars = Record<string, string | number>;

export interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, vars?: TranslateVars) => string;
  ready: boolean;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function interpolate(template: string, vars?: TranslateVars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = vars[name];
    return value === undefined ? match : String(value);
  });
}

/** Same test-only escape hatch as `web/src/i18n/I18nContext.tsx`'s `createTranslator` — builds a `t()` from a plain bundle map, no provider/fetch needed. */
export function createTranslator(bundle: Bundle): (key: string, vars?: TranslateVars) => string {
  return (key, vars) => interpolate(bundle[key] ?? key, vars);
}

/**
 * Ported from `web/src/i18n/I18nContext.tsx` — same four-deep fallback
 * chain (`requested locale -> fetched English -> bundled Thai -> raw key`,
 * NEVER `''`) and the same reason it exists (svc-i18n unreachable must not
 * mean a blank screen). Two differences from web, both because this is a
 * native app, not a browser:
 *
 *  1. Initial locale is synchronous-Thai + async-stored-override (see
 *     `locale.ts`'s header) rather than a single synchronous
 *     `detectInitialLocale()` call — `AsyncStorage` has no sync API.
 *  2. There is no `document.documentElement.lang` to set; RN has no DOM.
 *     `locale` itself is what every consumer (line-height choice in
 *     `theme/tokens.ts`'s `lineHeightFor`, `RTL`-equivalent concerns if
 *     ever needed) reads directly from this context instead.
 */
export function I18nProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);
  const [localeBundle, setLocaleBundle] = useState<Bundle | null>(null);
  const [englishBundle, setEnglishBundle] = useState<Bundle | null>(null);
  const [ready, setReady] = useState(false);
  const storedLocaleApplied = useRef(false);

  // One-time, on mount: apply a previously-stored locale choice, if any —
  // see locale.ts's header for why this cannot happen synchronously.
  useEffect(() => {
    let cancelled = false;
    void loadStoredLocale().then((stored) => {
      if (cancelled || storedLocaleApplied.current) return;
      storedLocaleApplied.current = true;
      if (stored && stored !== DEFAULT_LOCALE) setLocaleState(stored);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setReady(false);

    const localeFetch = fetchBundle(locale);
    const englishFetch = locale === 'en' ? localeFetch : fetchBundle('en');

    Promise.allSettled([localeFetch, englishFetch]).then(([localeResult, englishResult]) => {
      if (cancelled) return;

      const localeFailed = localeResult.status === 'rejected';
      const englishFailed = locale !== 'en' && englishResult.status === 'rejected';
      if (localeFailed || englishFailed) {
        console.warn(`[i18n] could not fetch translations for locale "${locale}" from svc-i18n — falling back to the Thai bundle shipped with the app.`);
      }

      setLocaleBundle(localeResult.status === 'fulfilled' ? localeResult.value : null);
      setEnglishBundle(englishResult.status === 'fulfilled' ? englishResult.value : null);
      setReady(true);
    });

    return () => {
      cancelled = true;
    };
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    void storeLocale(next);
    setLocaleState(next);
  }, []);

  const t = useCallback(
    (key: string, vars?: TranslateVars): string => {
      // Chain: fetched requested locale -> fetched English -> bundled
      // SAME locale (covers this app's own `mobile.*` keys, which no
      // live svc-i18n bundle has yet — see fallbackBundle.ts's header) ->
      // bundled Thai (the network-fully-down last resort) -> raw key.
      const value = localeBundle?.[key] ?? englishBundle?.[key] ?? FALLBACK_BUNDLES[locale][key] ?? FALLBACK_BUNDLES.th[key] ?? key;
      return interpolate(value, vars);
    },
    [localeBundle, englishBundle, locale],
  );

  const value = useMemo<I18nContextValue>(() => ({ locale, setLocale, t, ready }), [locale, setLocale, t, ready]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used within an I18nProvider');
  return ctx;
}

export { I18nContext };
