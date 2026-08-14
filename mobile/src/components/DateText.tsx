import React from 'react';
import { Text, StyleSheet } from 'react-native';
import { formatDate } from '../lib/i18n/format';
import type { Locale } from '../lib/i18n/format';
import { colors } from '../theme/tokens';

/** Renders one ISO-8601 date via the kernel's own `formatDate` — Thai renders พ.ศ., English/Chinese render Gregorian. Ported from `web/src/components/DateText.tsx`. */
export function DateText({ iso, locale }: { iso: string; locale: Locale }): React.JSX.Element {
  return <Text style={styles.numeric}>{formatDate(iso, locale)}</Text>;
}

const styles = StyleSheet.create({
  numeric: {
    fontVariant: ['tabular-nums'],
    fontFamily: 'Courier',
    color: colors.ink,
  },
});
