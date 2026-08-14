import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { ReactNode } from 'react';
import { colors, space } from '../theme/tokens';

export interface ScreenProps {
  children: ReactNode;
  /** `reversed`: the kiosk-mode dark ground (DESIGN.md's "two deliberate departures"). Every other screen is `paper` (default). */
  tone?: 'paper' | 'reversed';
  scroll?: boolean;
  testID?: string;
}

/**
 * The one place every screen gets its background + safe-area handling —
 * so a notched iPhone or a gesture-nav Android never draws content under
 * the status bar / home indicator (task brief's device-test checklist
 * calls this out explicitly as something to verify on a real device;
 * `react-native-safe-area-context` is what makes it correct on Expo Go
 * even before that check happens).
 */
export function Screen({ children, tone = 'paper', scroll = true, testID }: ScreenProps): React.JSX.Element {
  const background = tone === 'reversed' ? colors.carapaceShadow : colors.paper;
  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: background }]} testID={testID}>
      {scroll ? (
        <ScrollView style={styles.flex} contentContainerStyle={styles.scrollContent}>
          {children}
        </ScrollView>
      ) : (
        <View style={[styles.flex, styles.scrollContent]}>{children}</View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  flex: { flex: 1 },
  scrollContent: { padding: space[4], flexGrow: 1 },
});
