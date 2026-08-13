import type { Page } from '@playwright/test'
import { mockI18nReachable, mockSvcConfig } from './mockApis'

/**
 * Signs in via `src/auth/devBypass.ts`'s in-memory, unsigned dev session —
 * the only way this suite can reach an authenticated screen at all.
 * PRODUCTION Keycloak has exactly one real user, and that account's first
 * login forces a password change + OTP enrolment — it cannot be scripted,
 * and this suite does not attempt to (see `playwright.config.ts`'s
 * header). The dev-bypass principal (`DEV_PRINCIPAL` in `devBypass.ts`)
 * carries every permission `web/src/routes/navigation.ts` gates on, so
 * every nav destination and `RequirePermission`-guarded route is reachable
 * through it — this is real coverage of the shell's routing/permission
 * wiring, not a weaker stand-in for it.
 *
 * Mocks svc-i18n (real bundle content) and svc-config (a fixture rule)
 * BEFORE navigating, so every request the app fires from first paint
 * onward is already intercepted — no real backend is ever contacted.
 */
export async function signInAsDevUser(page: Page): Promise<void> {
  await mockI18nReachable(page)
  await mockSvcConfig(page)
  await page.goto('/')
  await page.locator('.login-page__submit').click()
  await page.locator('.shell-header').waitFor()
}
