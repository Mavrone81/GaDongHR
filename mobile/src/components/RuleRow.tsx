import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import type { ReactNode } from 'react';
import { colors, space } from '../theme/tokens';

/**
 * DESIGN.md's Layout rule, ported to a native primitive: "Label left,
 * value right, hairline between." No card, no shadow, no rounded corner —
 * a ruled document row, the base unit almost every screen in this app is
 * built from (today's status, a timesheet day, a leave balance line, a
 * payslip figure).
 */
export function RuleRow({ label, value, testID }: { label: ReactNode; value: ReactNode; testID?: string }): React.JSX.Element {
  return (
    <View style={styles.row} testID={testID}>
      <View style={styles.label}>{typeof label === 'string' ? <Text style={styles.labelText}>{label}</Text> : label}</View>
      <View style={styles.value}>{typeof value === 'string' ? <Text style={styles.valueText}>{value}</Text> : value}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: space[3],
    borderBottomWidth: 1,
    borderBottomColor: colors.rule,
  },
  label: { flexShrink: 1, paddingRight: space[2] },
  labelText: { color: colors.muted, fontSize: 15 },
  value: { flexShrink: 0 },
  valueText: { color: colors.ink, fontSize: 15, fontWeight: '600' },
});
