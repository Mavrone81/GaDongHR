import { expect, test } from '@playwright/test'
import { assertAppRendered, assertNoEmptyOrRawKeyText } from './assertions'
import { mockI18nReachable, mockI18nUnreachable, realBundle } from './mockApis'

/**
 * Item 5 of the task brief: all three languages, including that Thai is
 * what loads by default (Part 1 of this task) and that switching persists
 * across a reload. Item 6: svc-i18n being unreachable must still show
 * readable Thai from the bundled fallback, never blank.
 *
 * `SUPPORTED_LOCALES` order (`web/src/i18n/locale.ts`) is `['th', 'en',
 * 'zh']`, matching both `LoginPage.tsx`'s and `Shell.tsx`'s switcher
 * button order — used below to select a specific switcher button
 * positionally, so this suite doesn't hardcode a locale's own translated
 * label as the way to find its button (that would make an English test
 * depend on already being able to read English).
 */
const LOCALE_ORDER = ['th', 'en', 'zh'] as const

test.describe('Thai is the default language (Part 1 of this task)', () => {
  test('a fresh visitor with no stored preference sees Thai, and nothing is written to storage yet', async ({ page }) => {
    await mockI18nReachable(page)
    await page.goto('/')

    await assertAppRendered(page)
    await expect(page.locator('h1')).toHaveText(realBundle('th')['auth.login.title'] ?? '')
    await expect(page.locator('html')).toHaveAttribute('lang', 'th')

    // `detectInitialLocale()` (`i18n/locale.ts`) returns the 'th' default
    // WITHOUT calling `storeLocale` — an explicit choice is only recorded
    // once the user actually makes one (clicks a switcher button). A
    // default that silently wrote itself to storage would be
    // indistinguishable from a real preference on the next visit.
    const stored = await page.evaluate(() => window.localStorage.getItem('gadonghr.locale'))
    expect(stored).toBeNull()
  })
})

test.describe('all three languages render real, non-empty translated text', () => {
  for (const [index, locale] of LOCALE_ORDER.entries()) {
    test(`switching to "${locale}" from the pre-login switcher renders that language immediately`, async ({ page }) => {
      await mockI18nReachable(page)
      await page.goto('/')

      const switcher = page.locator('.login-page__locale .login-page__locale-btn').nth(index)
      await switcher.click()

      await expect(page.locator('h1')).toHaveText(realBundle(locale)['auth.login.title'] ?? '')
      await expect(switcher).toHaveAttribute('aria-pressed', 'true')
      await expect(page.locator('html')).toHaveAttribute('lang', locale)
      await assertNoEmptyOrRawKeyText(page)
    })
  }
})

test.describe('a chosen language persists across a reload', () => {
  for (const [index, locale] of LOCALE_ORDER.entries()) {
    test(`"${locale}" survives a full reload`, async ({ page }) => {
      await mockI18nReachable(page)
      await page.goto('/')

      await page.locator('.login-page__locale .login-page__locale-btn').nth(index).click()
      await expect(page.locator('h1')).toHaveText(realBundle(locale)['auth.login.title'] ?? '')

      await page.reload()

      await assertAppRendered(page)
      await expect(page.locator('h1')).toHaveText(realBundle(locale)['auth.login.title'] ?? '')
      await expect(page.locator('html')).toHaveAttribute('lang', locale)
    })
  }

  test('an explicit choice is never overridden by the Thai default on a later visit', async ({ page }) => {
    await mockI18nReachable(page)
    await page.goto('/')
    // English — deliberately the locale furthest from the Thai default, so
    // this test cannot pass by accident.
    await page.locator('.login-page__locale .login-page__locale-btn').nth(1).click()
    await expect(page.locator('h1')).toHaveText(realBundle('en')['auth.login.title'] ?? '')

    await page.reload()

    await expect(page.locator('h1')).toHaveText(realBundle('en')['auth.login.title'] ?? '')
    const stored = await page.evaluate(() => window.localStorage.getItem('gadonghr.locale'))
    expect(stored).toBe('en')
  })
})

test.describe('svc-i18n unreachable — the app must still show readable Thai, never blank', () => {
  /**
   * No `mockI18nReachable` here — deliberately. `.env.e2e` points
   * `VITE_SVC_I18N_URL` at a port nothing is listening on, and
   * `mockI18nUnreachable` makes the failure explicit and immediate
   * (`route.abort()`) rather than relying on however long a real
   * connection-refused takes. This is the exact regression `web/src/App.
   * rendersReadableText.test.tsx` guards at the unit level (jsdom, fetch
   * mocked) — this proves it in a REAL rendering engine end to end.
   */
  test('renders the compiled-in Thai fallback text, with a real accessible sign-in control', async ({ page }) => {
    await mockI18nUnreachable(page)
    await page.goto('/')

    await assertAppRendered(page)
    const submit = page.locator('.login-page__submit')
    await expect(submit).toHaveText(realBundle('th')['auth.login.submit'] ?? '')
    await expect(page.getByRole('button', { name: realBundle('th')['auth.login.submit'] })).toBeVisible()
    await assertNoEmptyOrRawKeyText(page)
  })

  /**
   * The deliberate trade-off documented in `src/i18n/fallbackBundle.ts`'s
   * header: the compiled-in emergency fallback is Thai ONLY, even for a
   * user who explicitly chose a different language — readable Thai beats
   * a raw i18n key or a blank screen for any user when the network is
   * completely down, and this product's default audience is Thai. This
   * test pins that behaviour down so it's a documented decision, not an
   * accidental regression waiting to be "fixed" the wrong way.
   */
  test('even with English explicitly chosen, total svc-i18n failure falls back to Thai (documented trade-off)', async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem('gadonghr.locale', 'en'))
    await mockI18nUnreachable(page)
    await page.goto('/')

    await assertAppRendered(page)
    await expect(page.locator('.login-page__submit')).toHaveText(realBundle('th')['auth.login.submit'] ?? '')
  })
})
