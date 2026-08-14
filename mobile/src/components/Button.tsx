import React from 'react';
import { Pressable, Text, StyleSheet } from 'react-native';
import type { StyleProp, TextStyle, ViewStyle } from 'react-native';
import { colors, space } from '../theme/tokens';

export type ButtonVariant = 'primary' | 'quiet' | 'kiosk';

export interface ButtonProps {
  children: string;
  onPress: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  /** Mirrors web's `aria-pressed` on the login language switcher — RN's `accessibilityState.selected` is the native equivalent. */
  selected?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * DESIGN.md: "No cards, no shadows, no rounded containers — this is a
 * document, not a dashboard." `primary` is a solid carapace block (the one
 * filled shape this system allows, reserved for the single main action per
 * screen); `quiet` is a plain text action (the language switcher, cancel
 * actions); `kiosk` is the one deliberately large, high-contrast exception
 * — a wall-mounted tablet punch button, tapped at arm's length (see
 * `screens/KioskScreen.tsx`).
 */
export function Button({ children, onPress, variant = 'primary', disabled = false, selected, style, testID }: ButtonProps): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [styles.base, VARIANT_STYLE[variant], disabled && styles.disabled, pressed && !disabled && styles.pressed, style]}
    >
      <Text style={[styles.text, VARIANT_TEXT_STYLE[variant], selected && styles.selectedText]}>{children}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: 44, // a generous tap target — the same "factory gate" rationale web's login-page__submit comment gives
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space[4],
    paddingVertical: space[2],
    borderRadius: 0,
  },
  primary: { backgroundColor: colors.carapace },
  quiet: { backgroundColor: 'transparent', paddingHorizontal: 0 },
  kiosk: { backgroundColor: colors.carapace, minHeight: 96, borderWidth: 2, borderColor: colors.brass },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.85 },
  text: { fontSize: 16, fontWeight: '600' },
  primaryText: { color: colors.paper },
  quietText: { color: colors.muted },
  kioskText: { color: colors.paper, fontSize: 22 },
  selectedText: { color: colors.carapace, textDecorationLine: 'underline' },
});

const VARIANT_STYLE: Record<ButtonVariant, StyleProp<ViewStyle>> = {
  primary: styles.primary,
  quiet: styles.quiet,
  kiosk: styles.kiosk,
};

const VARIANT_TEXT_STYLE: Record<ButtonVariant, StyleProp<TextStyle>> = {
  primary: styles.primaryText,
  quiet: styles.quietText,
  kiosk: styles.kioskText,
};
