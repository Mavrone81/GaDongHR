import type { Locale } from '@gadong/kernel/dist/i18n/format'

export type { Locale }

export const SUPPORTED_LOCALES: readonly Locale[] = ['th', 'en', 'zh']

export const LOCALE_STORAGE_KEY = 'gadonghr.locale'

/** Not a token — a bare three-letter locale preference is not sensitive, unlike an access/refresh token (see auth/AuthContext.tsx's header for why those never touch storage). */
export function loadStoredLocale(): Locale | null {
  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY)
    return isLocale(stored) ? stored : null
  } catch {
    return null
  }
}

export function storeLocale(locale: Locale): void {
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale)
  } catch {
    // localStorage unavailable (private browsing, quota) — the locale just
    // won't survive a reload; not worth failing the app over.
  }
}

export function isLocale(value: string | null): value is Locale {
  return value !== null && (SUPPORTED_LOCALES as readonly string[]).includes(value)
}

/**
 * THAI-FIRST DEFAULT (task brief, verbatim: "As it is Thai so the default
 * language must be Thai"). An explicit, already-made choice always wins —
 * `loadStoredLocale()` above is checked first and, if present, returned
 * unconditionally; nothing here ever overrides a preference a user
 * actually set.
 *
 * For everyone else, this deliberately does NOT consult
 * `navigator.language`, even though the browser might report `en` or `zh`.
 * That was the previous behaviour, and it is exactly backwards for this
 * product's real userbase: GaDongHR's Thai staff very often run
 * English-language Windows/browser installs (a common corporate-IT default
 * in Thailand), so `navigator.language` is not a trustworthy signal of a
 * Thai user's actual preferred language here — trusting it would silently
 * hand English to the exact audience the "Thai by default" requirement is
 * for, on a first visit, with no way for them to know why. Real English
 * speakers and the Chinese-speaking migrant workforce are still fully
 * served: `LoginPage` (the first screen anyone sees, before sign-in) puts
 * an explicit ไทย/English/中文 switcher above the sign-in action itself, one
 * click sets and persists a real preference via `storeLocale`, and that
 * stored choice is what `loadStoredLocale()` above returns from then on —
 * asked once, honored forever, never guessed from a header.
 */
export function detectInitialLocale(): Locale {
  const stored = loadStoredLocale()
  return stored ?? 'th'
}
