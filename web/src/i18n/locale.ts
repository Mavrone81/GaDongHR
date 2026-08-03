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

export function detectInitialLocale(): Locale {
  const stored = loadStoredLocale()
  if (stored) return stored
  const nav = typeof navigator !== 'undefined' ? navigator.language.slice(0, 2) : 'en'
  return isLocale(nav) ? nav : 'en'
}
