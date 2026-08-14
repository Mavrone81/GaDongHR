import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { useI18n } from '../lib/i18n/I18nContext';
import { useAuth } from '../auth/AuthContext';
import { useKioskMode } from '../lib/KioskModeContext';
import { LoginScreen } from '../screens/LoginScreen';
import { HomeClockScreen } from '../screens/HomeClockScreen';
import { TimesheetScreen } from '../screens/TimesheetScreen';
import { LeaveScreen } from '../screens/LeaveScreen';
import { PayslipScreen } from '../screens/PayslipScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { KioskScreen } from '../screens/KioskScreen';
import { colors } from '../theme/tokens';

export type TabParamList = {
  Home: undefined;
  Timesheet: undefined;
  Leave: undefined;
  Payslip: undefined;
  Settings: undefined;
};

const Tab = createBottomTabNavigator<TabParamList>();

/**
 * Three top-level states, guarded in this order:
 *
 *  1. Kiosk mode active (`KioskModeContext`) — renders `KioskScreen` alone,
 *     no tab bar, regardless of sign-in status (task brief: kiosk mode is
 *     entered from the signed-in Settings screen and stays active
 *     independent of the underlying session — see that context's header).
 *  2. Not authenticated — `LoginScreen` alone, the ONLY screen reachable
 *     pre-auth, same rule web's `App.tsx`/`AuthGate` enforces.
 *  3. Authenticated — the five-tab shell (task brief's phone-first
 *     screens 2-6). Tablet two-pane adaptation happens INSIDE
 *     `LeaveScreen`/`PayslipScreen` (`lib/useIsTablet.ts`), not by
 *     swapping navigators, since a tab bar is still the right chrome on
 *     an iPad.
 */
export function RootNavigator(): React.JSX.Element {
  const { status } = useAuth();
  const kiosk = useKioskMode();
  const { t } = useI18n();

  if (kiosk.active) return <KioskScreen />;
  if (status !== 'authenticated') return <LoginScreen />;

  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.carapace,
        tabBarInactiveTintColor: colors.muted,
        tabBarStyle: { backgroundColor: colors.paper, borderTopColor: colors.rule },
      }}
    >
      <Tab.Screen name="Home" component={HomeClockScreen} options={{ title: t('mobile.nav.home') }} />
      <Tab.Screen name="Timesheet" component={TimesheetScreen} options={{ title: t('mobile.nav.timesheet') }} />
      <Tab.Screen name="Leave" component={LeaveScreen} options={{ title: t('mobile.nav.leave') }} />
      <Tab.Screen name="Payslip" component={PayslipScreen} options={{ title: t('mobile.nav.payslip') }} />
      <Tab.Screen name="Settings" component={SettingsScreen} options={{ title: t('mobile.nav.settings') }} />
    </Tab.Navigator>
  );
}
