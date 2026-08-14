import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useI18n } from '../lib/i18n/I18nContext';
import { useAuth } from '../auth/AuthContext';
import { useApiClients } from '../api/clients';
import type { DayRecordRow, PeriodRow } from '../api/svcTimesheet';
import { DateText } from '../components/DateText';
import { RuleRow } from '../components/RuleRow';
import { Screen } from '../components/Screen';
import { colors, space } from '../theme/tokens';

function last30DaysRange(): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to);
  from.setUTCDate(to.getUTCDate() - 30);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

/**
 * Screen 3 (task brief): my days, OT classified 1.5x/2x/3x as the engine
 * reports (`DayRecordRow.ot15x/ot2x/ot3x` — never re-derived here, see
 * `api/svcTimesheet.ts`'s header), period status (open/locked).
 *
 * `GET /periods` requires `timesheet.lock`, an HR-only permission — most
 * employee tokens do not hold it (API reality, not a bug). This screen
 * tries the call and, on a 403, hides the period-status section entirely
 * rather than erroring — the same "fail-safe: nothing shown, not a crash"
 * philosophy `web/src/auth/AuthContext.tsx`'s `CurrentUser` doc describes
 * for permission gaps elsewhere in this codebase.
 */
export function TimesheetScreen(): React.JSX.Element {
  const { t, locale } = useI18n();
  const { tokenSource } = useAuth();
  const clients = useApiClients(tokenSource);

  const [days, setDays] = useState<DayRecordRow[]>([]);
  const [periods, setPeriods] = useState<PeriodRow[] | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    const { from, to } = last30DaysRange();
    void clients.timesheet
      .myDays(from, to)
      .then(setDays)
      .catch(() => setLoadError(true));
    // Any failure — a 403 for lacking `timesheet.lock` (the common case for
    // an employee token) or a genuine network/5xx error — leaves `periods`
    // at its initial `null` and the section below simply does not render.
    // Fail-safe: nothing shown, never a crash.
    void clients.timesheet.listPeriods().then(setPeriods).catch(() => undefined);
  }, [clients]);

  return (
    <Screen>
      <Text style={styles.title}>{t('mobile.timesheet.title')}</Text>

      {periods && periods.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>{t('mobile.timesheet.periodStatus')}</Text>
          {periods.map((p) => (
            <RuleRow key={p.id} label={`${p.from} – ${p.to}`} value={t(p.status === 'locked' ? 'mobile.timesheet.periodLocked' : 'mobile.timesheet.periodOpen')} />
          ))}
        </View>
      )}

      <View style={styles.section}>
        {loadError && <RuleRow label={t('mobile.common.offline')} value={t('mobile.common.retry')} />}
        {!loadError && days.length === 0 && <Text style={styles.empty}>{t('mobile.timesheet.empty')}</Text>}
        {days.map((d) => (
          <View key={d.id} style={styles.dayCard}>
            <RuleRow label={<DateText iso={d.workDate} locale={locale} />} value={`${d.workedHours} ${t('mobile.timesheet.workedHours')}`} />
            {(Number.parseFloat(d.ot15x) > 0 || Number.parseFloat(d.ot2x) > 0 || Number.parseFloat(d.ot3x) > 0) && (
              <View style={styles.otRow}>
                {Number.parseFloat(d.ot15x) > 0 && <Text style={styles.otBadge}>{t('mobile.timesheet.ot15xHours', { hours: d.ot15x })}</Text>}
                {Number.parseFloat(d.ot2x) > 0 && <Text style={styles.otBadge}>{t('mobile.timesheet.ot2xHours', { hours: d.ot2x })}</Text>}
                {Number.parseFloat(d.ot3x) > 0 && <Text style={styles.otBadge}>{t('mobile.timesheet.ot3xHours', { hours: d.ot3x })}</Text>}
              </View>
            )}
          </View>
        ))}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 22, fontWeight: '700', color: colors.ink, marginBottom: space[4] },
  section: { marginBottom: space[6] },
  sectionLabel: { color: colors.muted, fontSize: 14, marginBottom: space[1] },
  dayCard: { marginBottom: space[2] },
  otRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space[2], paddingBottom: space[2] },
  otBadge: { fontSize: 12, color: colors.carapace, borderWidth: 1, borderColor: colors.carapace, paddingHorizontal: space[2], paddingVertical: 2 },
  empty: { color: colors.muted },
});
