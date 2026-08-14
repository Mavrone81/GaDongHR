import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useI18n } from '../lib/i18n/I18nContext';
import { SUPPORTED_LOCALES } from '../lib/i18n/locale';
import { useAuth } from '../auth/AuthContext';
import { useKioskMode } from '../lib/KioskModeContext';
import { Screen } from '../components/Screen';
import { Button } from '../components/Button';
import { RuleRow } from '../components/RuleRow';
import { colors, space } from '../theme/tokens';

/** Screen 6 (task brief): language, profile basics, sign out — plus, on a device wide enough to plausibly be a mounted kiosk tablet, the entry point into Kiosk mode (`lib/KioskModeContext.tsx`). */
export function SettingsScreen(): React.JSX.Element {
  const { t, locale, setLocale } = useI18n();
  const { currentUser, logout } = useAuth();
  const kiosk = useKioskMode();

  return (
    <Screen>
      <Text style={styles.title}>{t('mobile.settings.title')}</Text>

      <View style={styles.section}>
        <Text style={styles.sectionLabel}>{t('mobile.settings.profile')}</Text>
        <RuleRow label={t('auth.login.username')} value={currentUser?.username ?? '-'} />
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionLabel}>{t('mobile.settings.language')}</Text>
        <View style={styles.localeRow}>
          {SUPPORTED_LOCALES.map((l) => (
            <Button key={l} variant="quiet" selected={l === locale} onPress={() => setLocale(l)} style={styles.localeBtn}>
              {t(`shell.locale.${l}`)}
            </Button>
          ))}
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionLabel}>{t('mobile.settings.kioskMode')}</Text>
        <Text style={styles.hint}>{t('mobile.settings.kioskModeHint')}</Text>
        <Button variant="primary" onPress={kiosk.enter} style={styles.kioskBtn} testID="enter-kiosk-mode">
          {t('mobile.settings.kioskMode')}
        </Button>
      </View>

      <Button variant="quiet" onPress={logout} style={styles.signOut}>
        {t('auth.logout')}
      </Button>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 22, fontWeight: '700', color: colors.ink, marginBottom: space[4] },
  section: { marginBottom: space[6] },
  sectionLabel: { color: colors.muted, fontSize: 14, marginBottom: space[1] },
  hint: { color: colors.muted, fontSize: 13, marginBottom: space[3] },
  localeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space[4] },
  localeBtn: { minHeight: 0, paddingVertical: space[1] },
  kioskBtn: { alignSelf: 'flex-start', paddingHorizontal: space[6] },
  signOut: { marginTop: space[4], alignSelf: 'flex-start' },
});
