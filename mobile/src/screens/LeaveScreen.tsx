import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, TextInput, StyleSheet } from 'react-native';
import { useI18n } from '../lib/i18n/I18nContext';
import { useAuth } from '../auth/AuthContext';
import { useApiClients } from '../api/clients';
import type { BalanceSummary, LeaveRequestRow, LeaveTypeRow } from '../api/svcLeave';
import { useIsTablet } from '../lib/useIsTablet';
import { Screen } from '../components/Screen';
import { Button } from '../components/Button';
import { RuleRow } from '../components/RuleRow';
import { colors, space } from '../theme/tokens';

/**
 * Screen 4 (task brief): balances, request submission, request history.
 * Tablet gets the two-pane layout the brief asks for — balances/history
 * on the left, the new-request form on the right, simultaneously, rather
 * than a phone-style single-column stack with a mode toggle.
 *
 * API REALITY: `svc-leave` is not part of `test/e2e`'s stack and not yet
 * publicly routed (task brief) — this screen's calls WILL fail against
 * both environments today. That failure renders as `mobile.leave.unavailable`
 * rather than a crash or an infinite spinner; nothing about this screen's
 * logic is a stub, it is simply unverified against a live `svc-leave` (see
 * `.superpowers/sdd/02-modules/mobile-app.md`'s unverified list).
 */
export function LeaveScreen(): React.JSX.Element {
  const { t } = useI18n();
  const { tokenSource } = useAuth();
  const clients = useApiClients(tokenSource);
  const isTablet = useIsTablet();

  const [balances, setBalances] = useState<BalanceSummary[]>([]);
  const [types, setTypes] = useState<LeaveTypeRow[]>([]);
  const [unavailable, setUnavailable] = useState(false);

  const [selectedTypeId, setSelectedTypeId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [submitted, setSubmitted] = useState<LeaveRequestRow[]>([]);
  const [formMessage, setFormMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    Promise.all([clients.leave.myBalances(), clients.leave.listTypes()])
      .then(([b, ty]) => {
        setBalances(b);
        setTypes(ty);
        setSelectedTypeId((current) => current || ty[0]?.id || '');
      })
      .catch(() => setUnavailable(true));
  }, [clients]);

  const submit = useCallback(async () => {
    if (!selectedTypeId || !startDate || !endDate) return;
    setSubmitting(true);
    setFormMessage(null);
    try {
      const request = await clients.leave.submitRequest({ leaveTypeId: selectedTypeId, startDate, endDate });
      setSubmitted((prev) => [request, ...prev]);
      setFormMessage(t('mobile.leave.submitSuccess'));
      setStartDate('');
      setEndDate('');
    } catch {
      setFormMessage(t('mobile.leave.submitError'));
    } finally {
      setSubmitting(false);
    }
  }, [clients, selectedTypeId, startDate, endDate, t]);

  if (unavailable) {
    return (
      <Screen>
        <Text style={styles.title}>{t('mobile.leave.title')}</Text>
        <Text style={styles.empty}>{t('mobile.leave.unavailable')}</Text>
      </Screen>
    );
  }

  const leftPane = (
    <View style={styles.pane}>
      <Text style={styles.sectionLabel}>{t('mobile.leave.balances')}</Text>
      {balances.map((b) => (
        <RuleRow key={`${b.leaveTypeId}-${b.year}`} label={types.find((ty) => ty.id === b.leaveTypeId)?.name ?? b.leaveTypeId} value={`${b.remaining} / ${b.entitled}`} />
      ))}

      <Text style={[styles.sectionLabel, styles.sectionSpacer]}>{t('mobile.leave.history')}</Text>
      {submitted.length === 0 && <Text style={styles.empty}>{t('mobile.leave.empty')}</Text>}
      {submitted.map((r) => (
        <RuleRow key={r.id} label={`${r.startDate} – ${r.endDate}`} value={t(`leave.status.${r.status === 'cancelled' ? 'rejected' : r.status}`)} />
      ))}
    </View>
  );

  const rightPane = (
    <View style={styles.pane}>
      <Text style={styles.sectionLabel}>{t('mobile.leave.newRequest')}</Text>
      <Text style={styles.fieldLabel}>{t('mobile.leave.selectType')}</Text>
      <View style={styles.typeRow}>
        {types.map((ty) => (
          <Button key={ty.id} variant="quiet" selected={ty.id === selectedTypeId} onPress={() => setSelectedTypeId(ty.id)} style={styles.typeBtn}>
            {ty.name}
          </Button>
        ))}
      </View>

      <Text style={styles.fieldLabel}>{t('leave.request.start_date')}</Text>
      <TextInput value={startDate} onChangeText={setStartDate} placeholder="YYYY-MM-DD" style={styles.input} testID="leave-start-date" />

      <Text style={styles.fieldLabel}>{t('leave.request.end_date')}</Text>
      <TextInput value={endDate} onChangeText={setEndDate} placeholder="YYYY-MM-DD" style={styles.input} testID="leave-end-date" />

      <Button variant="primary" onPress={() => void submit()} disabled={submitting} style={styles.submitBtn}>
        {t('leave.request.submit')}
      </Button>
      {formMessage && <Text style={styles.message}>{formMessage}</Text>}
    </View>
  );

  return (
    <Screen>
      <Text style={styles.title}>{t('mobile.leave.title')}</Text>
      {isTablet ? (
        <View style={styles.twoPane}>
          {leftPane}
          {rightPane}
        </View>
      ) : (
        <>
          {leftPane}
          {rightPane}
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 22, fontWeight: '700', color: colors.ink, marginBottom: space[4] },
  twoPane: { flexDirection: 'row', gap: space[6] },
  pane: { flex: 1 },
  sectionLabel: { color: colors.muted, fontSize: 14, marginBottom: space[1] },
  sectionSpacer: { marginTop: space[6] },
  fieldLabel: { color: colors.muted, fontSize: 13, marginTop: space[3], marginBottom: space[1] },
  typeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space[3] },
  typeBtn: { minHeight: 0, paddingVertical: space[1] },
  input: { borderWidth: 1, borderColor: colors.rule, padding: space[2], color: colors.ink },
  submitBtn: { marginTop: space[4] },
  message: { marginTop: space[3], color: colors.carapace },
  empty: { color: colors.muted },
});
