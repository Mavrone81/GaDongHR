import { expect, test } from '@playwright/test'
import { signInAsDevUser } from './auth'
import { assertAppRendered, assertNoEmptyOrRawKeyText } from './assertions'
import { clientSideNavigate } from './nav'
import { mockI18nReachable, realBundle } from './mockApis'
import { NAV_DESTINATIONS } from '../src/routes/navigation'

/**
 * Item 2 of the task brief: every route in the router table
 * (`web/src/App.tsx`'s `ShellRoutes`) is visited and asserted to render
 * its EXPECTED screen — a placeholder rendering its placeholder is a PASS,
 * not a failure, so the day someone builds the real screen behind it, this
 * test starts telling the truth about that instead of silently continuing
 * to pass either way.
 *
 * `NAV_DESTINATIONS` (`web/src/routes/navigation.ts`) is imported, not
 * hand-copied — the exact same array `Shell.tsx`'s nav renders from — so
 * this list can't silently drift from the real route table.
 *
 * Every authenticated navigation below uses `clientSideNavigate` (see
 * `nav.ts`), never `page.goto`, because the dev-bypass session lives only
 * in React state and a real browser navigation would drop it — see that
 * file's header.
 */
const PLACEHOLDER_ROUTES = NAV_DESTINATIONS.filter((d) => d.path !== '/admin/statutory-rules')

test.describe('every route renders its expected screen (authenticated)', () => {
  test('the index route ("/") redirects to the default nav destination on sign-in', async ({ page }) => {
    // `signInAsDevUser` itself lands on "/" and submits — `App.tsx`'s index
    // route (`<Navigate to={DEFAULT_NAV_PATH} replace/>`) is what carries
    // the freshly-authenticated app from there to `/admin/statutory-rules`,
    // so reaching that URL IS the assertion.
    await signInAsDevUser(page)

    await expect(page).toHaveURL(/\/admin\/statutory-rules$/)
    await assertAppRendered(page)
  })

  test('/admin/statutory-rules renders the real, built screen — not a placeholder', async ({ page }) => {
    await signInAsDevUser(page)
    // Already here via the index redirect (previous test), but navigate
    // explicitly so this test does not depend on that ordering.
    await clientSideNavigate(page, '/admin/statutory-rules')

    await assertAppRendered(page)
    await expect(page.locator('.page__title')).toHaveText(realBundle('th')['admin.statutoryRules.title'] ?? '')
    // The fixture rule (`e2e/mockApis.ts`'s `FIXTURE_RULE`) actually renders —
    // proves this screen's data path end-to-end, not just its static chrome.
    await expect(page.locator('.rule-row__key')).toHaveText('minimum_wage.bangkok')
    await assertNoEmptyOrRawKeyText(page)
  })

  for (const destination of PLACEHOLDER_ROUTES) {
    test(`${destination.path} renders the ComingSoon placeholder (deliberate — not yet built)`, async ({ page }) => {
      await signInAsDevUser(page)
      await clientSideNavigate(page, destination.path)

      await assertAppRendered(page)
      await expect(page.locator('.coming-soon__title')).toHaveText(realBundle('th')['shell.comingSoon.title'] ?? '')
      await assertNoEmptyOrRawKeyText(page)
    })
  }

  test('an unknown path under the shell hits the catch-all route and renders ComingSoon', async ({ page }) => {
    await signInAsDevUser(page)
    await clientSideNavigate(page, '/this-path-does-not-exist-anywhere')

    await assertAppRendered(page)
    await expect(page.locator('.shell-header')).toBeVisible()
    await expect(page.locator('.coming-soon__title')).toBeVisible()
    await assertNoEmptyOrRawKeyText(page)
  })
})

test.describe('every guarded route renders SOMETHING readable when unauthenticated (never a blank/broken screen)', () => {
  for (const destination of NAV_DESTINATIONS) {
    test(`${destination.path} redirects an unauthenticated visitor to sign-in`, async ({ page }) => {
      await mockI18nReachable(page)
      await page.goto(destination.path)

      await assertAppRendered(page)
      // `AuthGate` (`App.tsx`) swaps the whole tree for `LoginPage` — the
      // guarded screen's own content must NOT be reachable without a
      // session.
      await expect(page.locator('.login-page__sheet')).toBeVisible()
      await assertNoEmptyOrRawKeyText(page)
    })
  }
})

test.describe('/auth/callback — the OIDC redirect handler', () => {
  /**
   * NOT COVERED: a successful `?code=&state=` exchange against a real
   * Keycloak. That requires a live OIDC provider issuing a real
   * authorization code — this suite deliberately never scripts a real
   * login (see `playwright.config.ts`'s header; production Keycloak's one
   * real user forces a password change + OTP enrolment on first login).
   * What IS covered: the callback route is reachable directly, does not
   * crash or blank-screen on a missing/invalid code, and correctly routes
   * back to sign-in — the exact path a user lands on if they bookmark,
   * refresh, or revisit this URL without a live authorization in flight.
   */
  test('with no code/state in the URL, ends back on the sign-in screen (not blank, not stuck)', async ({ page }) => {
    await mockI18nReachable(page)
    await page.goto('/auth/callback')

    await expect(page).toHaveURL(/\/$/)
    await assertAppRendered(page)
    await expect(page.locator('.login-page__sheet')).toBeVisible()
    await assertNoEmptyOrRawKeyText(page)
  })
})
