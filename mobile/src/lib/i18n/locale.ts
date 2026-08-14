import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Locale } from './kernel/format';

export type { Locale };

export const SUPPORTED_LOCALES: readonly Locale[] = ['th', 'en', 'zh'];

export const LOCALE_STORAGE_KEY = 'gadonghr.locale';

export function isLocale(value: string | null): value is Locale {
  return value !== null && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/**
 * Ported from `web/src/i18n/locale.ts` — same "stored choice always wins,
 * default is Thai, never `navigator.language`" policy (read that file's
 * comment: an English-language-OS Thai worker is exactly the audience the
 * "Thai by default" rule protects). The one real difference from web:
 * `AsyncStorage.getItem` is asynchronous (there is no synchronous native
 * storage API), so unlike web's `detectInitialLocale()` this cannot return
 * a final answer synchronously at render time. `I18nContext.tsx` handles
 * this the same way any RN app handles async bootstrap state: render the
 * Thai default on first paint, then apply the stored locale (if any) the
 * moment `loadStoredLocale()` resolves — a user who previously chose
 * English/Chinese may see one Thai-labelled frame before their stored
 * choice applies, never the reverse (a Thai-first user never sees a wrong
 * language flash, since Thai is also the synchronous first paint).
 */
export async function loadStoredLocale(): Promise<Locale | null> {
  try {
    const stored = await AsyncStorage.getItem(LOCALE_STORAGE_KEY);
    return isLocale(stored) ? stored : null;
  } catch {
    return null;
  }
}

export async function storeLocale(locale: Locale): Promise<void> {
  try {
    await AsyncStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // AsyncStorage unavailable — the locale just won't survive a relaunch; not worth failing the app over (same tolerance as web's storeLocale).
  }
}

/** The synchronous first-paint default — see this module's header comment. */
export const DEFAULT_LOCALE: Locale = 'th';
