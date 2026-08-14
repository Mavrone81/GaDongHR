import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, TextInput, StyleSheet } from 'react-native';
import { useI18n } from '../lib/i18n/I18nContext';
import { useAuth } from '../auth/AuthContext';
import { useApiClients } from '../api/clients';
import { ApiError } from '../api/httpClient';
import type { DayRecordRow } from '../api/svcTimesheet';
import { newIdemKey } from '../lib/idemKey';
import { Screen } from '../components/Screen';
import { Button } from '../components/Button';
import { RuleRow } from '../components/RuleRow';
import { colors, space } from '../theme/tokens';

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function startOfWeekIso(): string {
  const now = new Date();
  const day = now.getUTCDay();
  const diff = (day + 6) % 7; // Monday-start week
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() - diff);
  return monday.toISOString().slice(0, 10);
}

function sumHours(days: DayRecordRow[]): number {
  return days.reduce((acc, d) => acc + Number.parseFloat(d.workedHours || '0'), 0);
}

/**
 * The daily screen (task brief screen 2): punch in/out, today's status,
 * this week's hours. Reads `svc-timesheet`'s `GET /my/days` (the
 * consolidated view — worked hours + OT + status, not raw punches) for
 * both "today" and "this week"; writes through `svc-attendance`'s
 * `POST /punches/code` for the actual punch.
 *
 * PIN NOTE (task brief, e2e findings): a punch here 4xx's with
 * `invalidAlternativeCredential` unless this employee has separately
 * completed PIN enrolment (`POST /enrolments/alternative`, out of this
 * app's scope) — that failure is surfaced as `mobile.home.punchError`,
 * not swallowed.
 */
export function HomeClockScreen(): React.JSX.Element {
  const { t } = useI18n();
  const { currentUser, tokenSource } = useAuth();
  const clients = useApiClients(tokenSource);

  const [today, setToday] = useState<DayRecordRow[]>([]);
  const [week, setWeek] = useState<DayRecordRow[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [siteCode, setSiteCode] = useState('HQ');
  const [pin, setPin] = useState('');
  const [punchMessage, setPunchMessage] = useState<string | null>(null);
  const [punching, setPunching] = useState(false);

  const load = useCallback(async () => {
    setLoadError(false);
    try {
      const [todayDays, weekDays] = await Promise.all([
        clients.timesheet.myDays(todayIso(), todayIso()),
        clients.timesheet.myDays(startOfWeekIso(), todayIso()),
      ]);
      setToday(todayDays);
      setWeek(weekDays);
    } catch {
      setLoadError(true);
    }
  }, [clients]);

  useEffect(() => {
    void load();
  }, [load]);

  const punch = useCallback(
    async (direction: 'in' | 'out') => {
      setPunching(true);
      setPunchMessage(null);
      try {
        await clients.attendance.punchByCode({
          idemKey: newIdemKey(direction),
          direction,
          siteCode,
          punchedAt: new Date().toISOString(),
          deviceId: 'mobile-app',
          kind: 'pin',
          code: pin,
          employeeId: currentUser?.id,
        });
        setPunchMessage(t('mobile.home.punchSuccess'));
        await load();
      } catch (err) {
        const detail = err instanceof ApiError && err.envelope ? ` (${err.envelope.code})` : '';
        setPunchMessage(`${t('mobile.home.punchError')}${detail}`);
      } finally {
        setPunching(false);
      }
    },
    [clients, siteCode, pin, currentUser, load, t],
  );

  const todayRow = today[0];
  const weekTotal = sumHours(week);

  return (
    <Screen>
      <Text style={styles.title}>{t('mobile.home.title')}</Text>

      <View style={styles.section}>
        <RuleRow label={t('mobile.home.todayStatus')} value={todayRow ? t(`attendance.status.${todayRow.status === 'ok' ? 'present' : 'late'}`) : t('mobile.home.noDataToday')} />
        <RuleRow label={t('mobile.home.weekHours')} value={weekTotal.toFixed(2)} />
        {loadError && <RuleRow label={t('mobile.common.offline')} value={t('mobile.common.retry')} />}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionLabel}>{t('mobile.home.punchSite')}</Text>
        <TextInput value={siteCode} onChangeText={setSiteCode} style={styles.input} autoCapitalize="characters" testID="home-site-code" />

        <Text style={styles.sectionLabel}>{t('mobile.home.punchPin')}</Text>
        <TextInput value={pin} onChangeText={setPin} style={styles.input} keyboardType="number-pad" secureTextEntry testID="home-pin" />

        <View style={styles.punchRow}>
          <Button variant="primary" onPress={() => void punch('in')} disabled={punching} style={styles.punchBtn}>
            {t('attendance.clock_in')}
          </Button>
          <Button variant="primary" onPress={() => void punch('out')} disabled={punching} style={styles.punchBtn}>
            {t('attendance.clock_out')}
          </Button>
        </View>

        {punchMessage && <Text style={styles.message}>{punchMessage}</Text>}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 22, fontWeight: '700', color: colors.ink, marginBottom: space[4] },
  section: { marginBottom: space[6] },
  sectionLabel: { color: colors.muted, fontSize: 14, marginBottom: space[1], marginTop: space[3] },
  input: { borderWidth: 1, borderColor: colors.rule, padding: space[2], color: colors.ink },
  punchRow: { flexDirection: 'row', gap: space[3], marginTop: space[4] },
  punchBtn: { flex: 1 },
  message: { marginTop: space[3], color: colors.carapace },
});
