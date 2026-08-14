import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useI18n } from '../lib/i18n/I18nContext';
import { SUPPORTED_LOCALES } from '../lib/i18n/locale';
import { useAuth } from '../auth/AuthContext';
import { loadConfig } from '../api/env';
import { hostFromUrl } from '../lib/hostFromUrl';
import { CarapaceMark } from '../components/CarapaceMark';
import { Button } from '../components/Button';
import { Screen } from '../components/Screen';
import { colors, space, lineHeightFor } from '../theme/tokens';

/**
 * Mirrors `web/src/routes/LoginPage.tsx`'s composition exactly: mark +
 * two-tone wordmark, statement, pre-login ไทย/English/中文 switcher
 * (reachable before sign-in — the ONLY screen an unauthenticated user can
 * reach, same as web), sign-in action, host footer. `reversed` tone is the
 * primary lockup (task brief: "the version workers see daily"), so this
 * screen renders on a light paper ground with the reversed (dark-ground)
 * mark boxed in its own carapace-shadow chip — same visual pairing web
 * gets from its dark-hexagon-on-paper CSS composition.
 */
export function LoginScreen({ reason }: { reason?: 'expired' }): React.JSX.Element {
  const { t, locale, setLocale } = useI18n();
  const { login, status } = useAuth();
  const host = hostFromUrl(loadConfig().oidcIssuer);

  return (
    <Screen>
      <View style={styles.sheet}>
        <View style={styles.brandRow}>
          <View style={styles.markChip}>
            <CarapaceMark tone="reversed" size={44} title={t('shell.brandMark.alt')} />
          </View>
          <Text style={styles.wordmark}>
            <Text style={styles.wordmarkGa}>{t('shell.brandMark.wordmarkGadong')}</Text>
            <Text style={styles.wordmarkHr}>{t('shell.brandMark.wordmarkHr')}</Text>
          </Text>
        </View>

        <Text style={[styles.statement, { lineHeight: lineHeightFor(locale, 16) }]}>{t('auth.login.statement')}</Text>

        <Text style={[styles.title, { lineHeight: lineHeightFor(locale, 24) }]}>{reason === 'expired' ? t('auth.session.expired') : t('auth.login.title')}</Text>

        <View style={styles.localeRow} accessibilityRole="radiogroup" accessibilityLabel={t('shell.locale.chooseLanguage')}>
          {SUPPORTED_LOCALES.map((l) => (
            <Button key={l} variant="quiet" selected={l === locale} onPress={() => setLocale(l)} style={styles.localeBtn}>
              {t(`shell.locale.${l}`)}
            </Button>
          ))}
        </View>

        <Button variant="primary" onPress={() => void login()} disabled={status === 'authenticating'} style={styles.submit}>
          {status === 'authenticating' ? t('common.loading') : t('auth.login.submit')}
        </Button>

        <Text style={styles.footer}>{t('auth.login.footer', { host })}</Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  sheet: { maxWidth: 420, width: '100%', alignSelf: 'center', paddingTop: space[6], borderTopWidth: 3, borderTopColor: colors.carapace },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: space[3], marginBottom: space[6] },
  markChip: { backgroundColor: colors.carapaceShadow, padding: space[1] },
  wordmark: { fontSize: 24, fontWeight: '700' },
  wordmarkGa: { color: colors.ink },
  wordmarkHr: { color: colors.brass },
  statement: { color: colors.muted, fontSize: 16, marginBottom: space[4] },
  title: { fontSize: 22, fontWeight: '700', color: colors.ink, marginBottom: space[6] },
  localeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space[4],
    paddingVertical: space[3],
    marginBottom: space[6],
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: colors.rule,
  },
  localeBtn: { minHeight: 0, paddingVertical: space[1] },
  submit: { width: '100%', minHeight: 44 },
  footer: { marginTop: space[8], paddingTop: space[3], borderTopWidth: 1, borderTopColor: colors.rule, color: colors.muted, fontSize: 13 },
});
