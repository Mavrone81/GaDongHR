import { expect, test } from '@playwright/test'
import { signInAsDevUser } from './auth'
import { assertNoEmptyOrRawKeyText } from './assertions'
import { mockI18nReachable, realBundle } from './mockApis'
import { NAV_DESTINATIONS } from '../src/routes/navigation'

/**
 * Item 3 of the task brief: every nav item and every button is clicked,
 * and each click must produce something OBSERVABLE — navigation, a state
 * change, a request firing, a form opening. A button whose click produces
 * no observable effect is a failure, not a skip.
 */

test.describe('the sign-in button', () => {
  test('clicking it transitions from the sign-in screen to the authenticated shell', async ({ page }) => {
    await mockI18nReachable(page)
    await page.goto('/')
    await expect(page.locator('.login-page__sheet')).toBeVisible()

    await page.locator('.login-page__submit').click()

    await expect(page.locator('.shell-header')).toBeVisible()
    await expect(page.locator('.login-page__sheet')).toHaveCount(0)
  })
})

test.describe('every nav item navigates to its own screen', () => {
  for (const destination of NAV_DESTINATIONS) {
    test(`clicking "${destination.labelKey}" navigates to ${destination.path}`, async ({ page }) => {
      await signInAsDevUser(page)

      const link = page.getByRole('link', { name: realBundle('th')[destination.labelKey] })
      await link.click()

      await expect(page).toHaveURL(new RegExp(`${destination.path.replace(/\//g, '\\/')}$`))
      await expect(link).toHaveAttribute('aria-current', 'page')
      await assertNoEmptyOrRawKeyText(page)
    })
  }
})

test.describe('the shell locale switcher (post-login)', () => {
  const LOCALE_ORDER = ['th', 'en', 'zh'] as const

  for (const [index, locale] of LOCALE_ORDER.entries()) {
    test(`clicking "${locale}" re-renders the shell's own chrome in that language`, async ({ page }) => {
      await signInAsDevUser(page)

      const switcher = page.locator('.shell-locale .shell-locale__btn').nth(index)
      await switcher.click()

      await expect(switcher).toHaveAttribute('aria-pressed', 'true')
      await expect(page.locator('.page__title')).toHaveText(realBundle(locale)['admin.statutoryRules.title'] ?? '')
      await expect(page.locator('html')).toHaveAttribute('lang', locale)
    })
  }
})

test.describe('logout', () => {
  test('clicking it drops the session and returns to the sign-in screen', async ({ page }) => {
    await signInAsDevUser(page)
    await expect(page.locator('.shell-header')).toBeVisible()

    await page.getByRole('button', { name: realBundle('th')['auth.logout'] }).click()

    await expect(page.locator('.login-page__sheet')).toBeVisible()
    // `AuthGate` (`App.tsx`) renders `reason="expired"` copy once a session
    // has existed and ended — distinct text from a first-ever visit,
    // proving logout is a real state transition, not a no-op re-render.
    await expect(page.locator('h1')).toHaveText(realBundle('th')['auth.session.expired'] ?? '')
  })
})

test.describe('/admin/statutory-rules — every interactive control', () => {
  test.beforeEach(async ({ page }) => {
    await signInAsDevUser(page)
    await expect(page.locator('.page__title')).toBeVisible()
  })

  test('the Propose button opens the form, and Cancel closes it again', async ({ page }) => {
    const proposeButton = page.getByRole('button', { name: realBundle('th')['admin.statutoryRules.propose.cta'] })
    await expect(page.locator('#propose-rule-key')).toHaveCount(0)

    await proposeButton.click()
    await expect(page.locator('#propose-rule-key')).toBeVisible()

    await page.getByRole('button', { name: realBundle('th')['common.cancel'] }).click()
    await expect(page.locator('#propose-rule-key')).toHaveCount(0)
  })

  test('submitting the Propose form fires a real POST request and shows the success message', async ({ page }) => {
    await page.getByRole('button', { name: realBundle('th')['admin.statutoryRules.propose.cta'] }).click()

    await page.locator('#propose-rule-key').fill('e2e.test_rule')
    await page.locator('#propose-value').fill('123')
    await page.locator('#propose-unit').fill('THB')
    await page.locator('#propose-citation').fill('e2e citation')
    await page.locator('#propose-floor').fill('100')
    await page.locator('#propose-effective-from').fill('2026-01-01')
    await page.locator('#propose-reason').fill('e2e reason')

    const [request] = await Promise.all([
      page.waitForRequest((req) => req.url().includes('/rules') && req.method() === 'POST'),
      page.getByRole('button', { name: realBundle('th')['admin.statutoryRules.propose.submit'] }).click(),
    ])

    expect(request.method()).toBe('POST')
    await expect(page.getByText(realBundle('th')['admin.statutoryRules.propose.success'] ?? '')).toBeVisible()
  })

  test('the View button expands the "as of" detail panel for a rule row', async ({ page }) => {
    const dateInput = page.locator('#as-of-minimum_wage\\.bangkok')
    await expect(dateInput).toHaveCount(0)

    await page.getByRole('button', { name: realBundle('th')['common.view'] }).click()
    await expect(dateInput).toBeVisible()

    // Toggles back off — the same button, clicked again, is a real state
    // change too, not a one-way reveal.
    await page.getByRole('button', { name: realBundle('th')['common.view'] }).click()
    await expect(dateInput).toHaveCount(0)
  })

  test('the Approve button fires a real POST .../approve request', async ({ page }) => {
    // `FIXTURE_RULE` (`e2e/mockApis.ts`) is proposed by someone other than
    // the dev-bypass principal, so `RuleRow.tsx`'s segregation-of-duties
    // check renders a real, clickable Approve button here.
    const approveButton = page.getByRole('button', { name: realBundle('th')['admin.statutoryRules.approve.cta'] })
    await expect(approveButton).toBeVisible()

    const [request] = await Promise.all([
      page.waitForRequest((req) => req.url().includes('/approve') && req.method() === 'POST'),
      approveButton.click(),
    ])

    expect(request.url()).toContain('/approve')
  })
})
