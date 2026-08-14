import React, { createContext, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * Kiosk mode is a MODE of this same app (task brief: "not a separate
 * app"), not a separate route tree with its own auth — entering it does
 * not sign anyone out and does not require re-authentication (the tablet
 * itself is presumed to be the trusted, site-mounted device; the identity
 * check that matters is the PER-PUNCH employee-code + PIN, not "who is
 * signed into this tablet's own app session" — mirroring
 * `svc-attendance/src/punch.controller.ts`'s own `/punches/code` route,
 * which accepts either the signed-in caller or an explicit `employeeId`
 * in the body for exactly this device/self ambiguity).
 *
 * EXIT REQUIRES ADMIN (task brief) — `exit(code)` below is the one guarded
 * seam: a plain 4-digit code checked client-side. This is a soft,
 * UX-level speed bump against a worker accidentally backing out of a
 * kiosk mounted at a site entrance, NOT a security boundary — nothing
 * about leaving kiosk mode grants or removes any permission; every real
 * write this app makes is still enforced server-side by the resource
 * server's own `PermissionGuard`, exactly as `web`'s `CurrentUser` doc
 * describes for its own UI-only permission set. A real deployment should
 * treat this code the same way a physical kiosk's exit PIN is treated
 * (rotated, not shared with line workers) — it is intentionally NOT the
 * same PIN a worker punches with.
 */
export const DEFAULT_KIOSK_EXIT_CODE = '0000';

export interface KioskModeContextValue {
  active: boolean;
  enter: () => void;
  /** Returns `true` if `code` matched and kiosk mode was exited; `false` (and stays in kiosk mode) otherwise. */
  exit: (code: string) => boolean;
}

const KioskModeContext = createContext<KioskModeContextValue | null>(null);

export function KioskModeProvider({ children, exitCode = DEFAULT_KIOSK_EXIT_CODE }: { children: ReactNode; exitCode?: string }): React.JSX.Element {
  const [active, setActive] = useState(false);

  const value = useMemo<KioskModeContextValue>(
    () => ({
      active,
      enter: () => setActive(true),
      exit: (code: string) => {
        if (code !== exitCode) return false;
        setActive(false);
        return true;
      },
    }),
    [active, exitCode],
  );

  return <KioskModeContext.Provider value={value}>{children}</KioskModeContext.Provider>;
}

export function useKioskMode(): KioskModeContextValue {
  const ctx = useContext(KioskModeContext);
  if (!ctx) throw new Error('useKioskMode must be used within a KioskModeProvider');
  return ctx;
}
