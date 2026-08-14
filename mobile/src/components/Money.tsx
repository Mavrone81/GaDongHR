import React from 'react';
import { Text, StyleSheet } from 'react-native';
import { formatTHB } from '../lib/i18n/format';
import type { Locale } from '../lib/i18n/format';
import { colors } from '../theme/tokens';

/**
 * Renders `bigint` satang via the kernel's own `formatTHB` — ported from
 * `web/src/components/Money.tsx`. Only for figures THIS app still holds as
 * raw satang (none, today — every payslip figure arrives pre-formatted
 * from `svc-payroll`, see `api/svcPayroll.ts`'s header); kept for any
 * future screen that reads a satang value directly (e.g. a leave-claim
 * amount) so the "format once, at render, never re-derive" rule has a
 * ready-made component.
 */
export function Money({ satang, locale }: { satang: bigint; locale: Locale }): React.JSX.Element {
  return <Text style={styles.numeric}>{formatTHB(satang, locale)}</Text>;
}

const styles = StyleSheet.create({
  numeric: {
    fontVariant: ['tabular-nums'],
    fontFamily: 'Courier',
    color: colors.ink,
  },
});
