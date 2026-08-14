import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { useI18n } from '../lib/i18n/I18nContext';
import { useAuth } from '../auth/AuthContext';
import { useApiClients } from '../api/clients';
import type { PayslipSummary } from '../api/svcPayroll';
import { useIsTablet } from '../lib/useIsTablet';
import { Screen } from '../components/Screen';
import { Button } from '../components/Button';
import { RuleRow } from '../components/RuleRow';
import { colors, space } from '../theme/tokens';

/**
 * Screen 5 (task brief): list + detail; THB figures already
 * satang-formatted server-side (`api/svcPayroll.ts`'s header — never
 * re-formatted here); PDF via svc-docs render "where available" — this
 * screen surfaces `pdfRef` (the object key) and a note that the actual
 * download/render wiring is a follow-up, rather than pretending a working
 * download button exists (see the unverified list in
 * `.superpowers/sdd/02-modules/mobile-app.md`).
 *
 * Tablet: list (left) + detail (right) simultaneously, per the task
 * brief's two-pane requirement. Phone: list, tap through to detail,
 * tap back — both driven by the same local `selected` state rather than a
 * second registered route, since there is nothing else this screen needs
 * from a navigator.
 */
export function PayslipScreen(): React.JSX.Element {
  const { t, locale } = useI18n();
  const { tokenSource } = useAuth();
  const clients = useApiClients(tokenSource);
  const isTablet = useIsTablet();

  const [payslips, setPayslips] = useState<PayslipSummary[]>([]);
  const [error, setError] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    clients.payroll
      .myPayslips(locale)
      .then((list) => {
        setPayslips(list);
        setSelectedId((current) => current ?? list[0]?.payslipId ?? null);
      })
      .catch(() => setError(true));
  }, [clients, locale]);

  const selected = payslips.find((p) => p.payslipId === selectedId) ?? null;

  const list = (
    <View style={styles.pane}>
      <Text style={styles.sectionLabel}>{t('mobile.payslip.list')}</Text>
      {error && <Text style={styles.empty}>{t('mobile.common.offline')}</Text>}
      {!error && payslips.length === 0 && <Text style={styles.empty}>{t('mobile.payslip.empty')}</Text>}
      {payslips.map((p) => (
        <Pressable key={p.payslipId} onPress={() => setSelectedId(p.payslipId)} testID={`payslip-row-${p.payslipId}`}>
          <RuleRow label={p.period} value={p.net} testID={`payslip-row-value-${p.payslipId}`} />
        </Pressable>
      ))}
    </View>
  );

  const detail = selected ? (
    <View style={styles.pane}>
      {!isTablet && (
        <Button variant="quiet" onPress={() => setSelectedId(null)} style={styles.backBtn}>
          {t('common.back')}
        </Button>
      )}
      <Text style={styles.sectionLabel}>{selected.period}</Text>
      <RuleRow label={t('payroll.payslip.salary')} value={selected.gross} />
      <RuleRow label={t('payroll.payslip.overtime')} value={selected.lines.find((l) => l.kind === 'overtime')?.amount ?? '-'} />
      <RuleRow label={t('payroll.payslip.social_security')} value={selected.ssoEmployee} />
      <RuleRow label={t('payroll.payslip.withholding_tax')} value={selected.wht} />
      <RuleRow label={t('payroll.payslip.net')} value={selected.net} />
      <RuleRow label={t('mobile.payslip.payDate')} value={selected.payDate ?? '-'} />
      <Text style={styles.pdfNote}>{t('mobile.payslip.pdfNote')}</Text>
    </View>
  ) : null;

  return (
    <Screen>
      <Text style={styles.title}>{t('mobile.payslip.title')}</Text>
      {isTablet ? (
        <View style={styles.twoPane}>
          {list}
          {detail}
        </View>
      ) : selected ? (
        detail
      ) : (
        list
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 22, fontWeight: '700', color: colors.ink, marginBottom: space[4] },
  twoPane: { flexDirection: 'row', gap: space[6] },
  pane: { flex: 1 },
  sectionLabel: { color: colors.muted, fontSize: 14, marginBottom: space[1] },
  backBtn: { alignSelf: 'flex-start', marginBottom: space[2] },
  pdfNote: { marginTop: space[4], color: colors.muted, fontSize: 12 },
  empty: { color: colors.muted },
});
