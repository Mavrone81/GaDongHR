import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, TextInput, StyleSheet } from 'react-native';
import { useI18n } from '../lib/i18n/I18nContext';
import { useAuth } from '../auth/AuthContext';
import { useApiClients } from '../api/clients';
import { newIdemKey } from '../lib/idemKey';
import { useKioskMode } from '../lib/KioskModeContext';
import { CarapaceMark } from '../components/CarapaceMark';
import { Button } from '../components/Button';
import { Screen } from '../components/Screen';
import { colors, space } from '../theme/tokens';

/**
 * Tablet Kiosk mode (task brief): dark surface, reversed carapace mark,
 * large clock, employee-code + PIN punch flow — "a tablet mounted at a
 * site entrance". DESIGN.md's own "two deliberate departures" already
 * calls kiosk mode out as the one place this system is dark by design
 * ("different physics: a wall-mounted tablet at 1.5m, glanced at while
 * walking, often backlit"); `Screen`'s `tone="reversed"` is exactly that
 * ground, matching `--carapace-shadow` + brass linework.
 *
 * PIN NOTE — same API-reality caveat as `HomeClockScreen`: this device
 * calls the identical `svc-attendance` `POST /punches/code` route with
 * `kind: 'pin'`, and 4xx's the same way for any employee code without a
 * separately-enrolled PIN credential (out of this app's scope).
 */
export function KioskScreen(): React.JSX.Element {
  const { t } = useI18n();
  const { tokenSource } = useAuth();
  const clients = useApiClients(tokenSource);
  const kiosk = useKioskMode();

  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const [employeeCode, setEmployeeCode] = useState('');
  const [pin, setPin] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [exitOpen, setExitOpen] = useState(false);
  const [exitCode, setExitCode] = useState('');
  const [exitError, setExitError] = useState(false);

  const punch = useCallback(
    async (direction: 'in' | 'out') => {
      setBusy(true);
      setMessage(null);
      try {
        await clients.attendance.punchByCode({
          idemKey: newIdemKey(direction),
          direction,
          siteCode: 'KIOSK',
          punchedAt: new Date().toISOString(),
          deviceId: 'kiosk-tablet',
          kind: 'pin',
          code: pin,
          employeeId: employeeCode || undefined,
        });
        setMessage(t('mobile.home.punchSuccess'));
        setPin('');
      } catch {
        setMessage(t('mobile.home.punchError'));
      } finally {
        setBusy(false);
      }
    },
    [clients, pin, employeeCode, t],
  );

  const attemptExit = useCallback(() => {
    const ok = kiosk.exit(exitCode);
    setExitError(!ok);
    if (ok) {
      setExitOpen(false);
      setExitCode('');
    }
  }, [kiosk, exitCode]);

  return (
    <Screen tone="reversed" scroll={false}>
      <View style={styles.center}>
        <CarapaceMark tone="reversed" size={72} title={t('shell.brandMark.alt')} />
        <Text style={styles.title}>{t('mobile.kiosk.title')}</Text>
        <Text style={styles.clock} testID="kiosk-clock">
          {now.toLocaleTimeString()}
        </Text>

        <TextInput
          value={employeeCode}
          onChangeText={setEmployeeCode}
          placeholder={t('mobile.kiosk.employeeCode')}
          placeholderTextColor={colors.muted}
          style={styles.input}
          testID="kiosk-employee-code"
        />
        <TextInput
          value={pin}
          onChangeText={setPin}
          placeholder={t('mobile.kiosk.pin')}
          placeholderTextColor={colors.muted}
          style={styles.input}
          keyboardType="number-pad"
          secureTextEntry
          testID="kiosk-pin"
        />

        <View style={styles.punchRow}>
          <Button variant="kiosk" onPress={() => void punch('in')} disabled={busy} style={styles.punchBtn}>
            {t('mobile.kiosk.punchIn')}
          </Button>
          <Button variant="kiosk" onPress={() => void punch('out')} disabled={busy} style={styles.punchBtn}>
            {t('mobile.kiosk.punchOut')}
          </Button>
        </View>

        {message && (
          <Text style={styles.message} testID="kiosk-message">
            {message}
          </Text>
        )}
      </View>

      <View style={styles.exitCorner}>
        {!exitOpen ? (
          <Button variant="quiet" onPress={() => setExitOpen(true)} style={styles.exitToggle} testID="kiosk-exit-toggle">
            {t('mobile.kiosk.exit')}
          </Button>
        ) : (
          <View style={styles.exitPanel}>
            <Text style={styles.exitLabel}>{t('mobile.kiosk.exitAdminCode')}</Text>
            <TextInput
              value={exitCode}
              onChangeText={(v) => {
                setExitCode(v);
                setExitError(false);
              }}
              style={styles.exitInput}
              keyboardType="number-pad"
              secureTextEntry
              testID="kiosk-exit-code"
            />
            {exitError && <Text style={styles.exitError}>{t('common.error')}</Text>}
            <View style={styles.exitButtons}>
              <Button variant="quiet" onPress={attemptExit} style={styles.exitBtn} testID="kiosk-exit-confirm">
                {t('mobile.kiosk.exitConfirm')}
              </Button>
              <Button
                variant="quiet"
                onPress={() => {
                  setExitOpen(false);
                  setExitCode('');
                  setExitError(false);
                }}
                style={styles.exitBtn}
              >
                {t('mobile.kiosk.exitCancel')}
              </Button>
            </View>
          </View>
        )}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: space[3], padding: space[6] },
  title: { color: colors.paper, fontSize: 20, fontWeight: '700' },
  clock: { color: colors.brass, fontSize: 56, fontWeight: '700', fontVariant: ['tabular-nums'], marginBottom: space[4] },
  input: { width: '100%', maxWidth: 360, borderWidth: 1, borderColor: colors.brass, color: colors.paper, padding: space[3], fontSize: 18, marginBottom: space[3] },
  punchRow: { flexDirection: 'row', gap: space[4], width: '100%', maxWidth: 480, marginTop: space[4] },
  punchBtn: { flex: 1 },
  message: { color: colors.paper, marginTop: space[4], fontSize: 16 },
  exitCorner: { position: 'absolute', bottom: space[4], right: space[4] },
  exitToggle: { opacity: 0.6 },
  exitPanel: { backgroundColor: colors.carapaceShadow, borderWidth: 1, borderColor: colors.brass, padding: space[4], width: 220 },
  exitLabel: { color: colors.paper, fontSize: 13, marginBottom: space[2] },
  exitInput: { borderWidth: 1, borderColor: colors.brass, color: colors.paper, padding: space[2], marginBottom: space[2] },
  exitError: { color: colors.seal, fontSize: 12, marginBottom: space[2] },
  exitButtons: { flexDirection: 'row', gap: space[2] },
  exitBtn: { flex: 1 },
});
