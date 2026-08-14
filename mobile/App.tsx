import React from 'react';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { I18nProvider } from './src/lib/i18n/I18nContext';
import { AuthProvider } from './src/auth/AuthContext';
import { KioskModeProvider } from './src/lib/KioskModeContext';
import { RootNavigator } from './src/navigation/RootNavigator';

/**
 * Provider order matters: `I18nProvider` outermost (every other provider's
 * screens read `t()`), then `AuthProvider` (gates `RootNavigator`'s
 * choice of screen), then `KioskModeProvider` (independent of auth status
 * — see that context's header). `GestureHandlerRootView` wraps everything,
 * as `react-native-gesture-handler`'s own setup docs require, since
 * `@react-navigation/native-stack` depends on it even though this app's
 * navigator today is bottom-tabs only (kept for the tablet stack-nav
 * follow-up noted in the module report).
 */
export default function App(): React.JSX.Element {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <I18nProvider>
          <AuthProvider>
            <KioskModeProvider>
              <NavigationContainer>
                <RootNavigator />
              </NavigationContainer>
            </KioskModeProvider>
          </AuthProvider>
        </I18nProvider>
        <StatusBar style="auto" />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
