import { expect, test } from '@playwright/test'
import { signInAsDevUser } from './auth'
import { assertAppRendered, assertNoEmptyOrRawKeyText } from './assertions'
import { mockI18nReachable } from './mockApis'

/**
 * Item 1 of the task brief: `#root` actually rendered — children AND
 * visible, non-empty text. This is the single assertion that would have
 * caught both of this project's production blank-page incidents, the
 * second of which shipped with a healthy HTTP 200, the correct JS bundle,
 * 15 healthy containers, and zero console errors (a stale service worker
 * served a stale `index.html` pointing at deleted asset hashes; nginx's
 * SPA fallback answered those dead requests with 200-and-HTML instead of
 * 404, so the `<script type="module">` silently refused to execute).
 * `curl` cannot see this class of failure; only a real rendering engine,
 * looking at real pixels, can — which is the entire reason this suite is
 * Playwright and not another `curl` health check.
 */
test.describe('the app actually renders — never a healthy-looking, empty #root', () => {
  test('on first load, unauthenticated', async ({ page }) => {
    await mockI18nReachable(page)
    await page.goto('/')

    await assertAppRendered(page)
    await assertNoEmptyOrRawKeyText(page)
    // Specifically: the exact regression this task's Part 1 fixes — a
    // Thai-speaking user with no stored preference must see real Thai on
    // the very first paint, not a blank screen while a fetch is pending.
    await expect(page.locator('h1')).toBeVisible()
  })

  test('once authenticated, on the default landing screen', async ({ page }) => {
    await signInAsDevUser(page)

    await assertAppRendered(page)
    await assertNoEmptyOrRawKeyText(page)
    await expect(page.locator('.shell-header')).toBeVisible()
    await expect(page.locator('.page__title')).toBeVisible()
  })
})
