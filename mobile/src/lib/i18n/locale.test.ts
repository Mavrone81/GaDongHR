import AsyncStorage from '@react-native-async-storage/async-storage';
import { isLocale, loadStoredLocale, storeLocale, DEFAULT_LOCALE, SUPPORTED_LOCALES, LOCALE_STORAGE_KEY } from './locale';

describe('locale', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('DEFAULT_LOCALE is Thai (task brief: "the default language must be Thai")', () => {
    expect(DEFAULT_LOCALE).toBe('th');
  });

  it('SUPPORTED_LOCALES is exactly th/en/zh', () => {
    expect(SUPPORTED_LOCALES).toEqual(['th', 'en', 'zh']);
  });

  it('isLocale accepts only supported locales', () => {
    expect(isLocale('th')).toBe(true);
    expect(isLocale('en')).toBe(true);
    expect(isLocale('fr')).toBe(false);
    expect(isLocale(null)).toBe(false);
  });

  it('loadStoredLocale returns null when nothing was ever stored', async () => {
    expect(await loadStoredLocale()).toBeNull();
  });

  it('storeLocale then loadStoredLocale round-trips a real choice', async () => {
    await storeLocale('zh');
    expect(await loadStoredLocale()).toBe('zh');
  });

  it('loadStoredLocale rejects a corrupted/unsupported stored value rather than trusting it', async () => {
    await AsyncStorage.setItem(LOCALE_STORAGE_KEY, 'fr');
    expect(await loadStoredLocale()).toBeNull();
  });
});
