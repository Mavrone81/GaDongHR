import { expect, test } from '@playwright/test'
import { signInAsDevUser } from './auth'
import { assertNoEmptyOrRawKeyText } from './assertions'
import { mockI18nReachable, realBundle, FIXTURE_AUDIT_ENTRY, FIXTURE_ROLES, FIXTURE_NOTIFICATION } from './mockApis'
import { clientSideNavigate } from './nav'
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

test.describe('/compliance/audit — every interactive control', () => {
  test.beforeEach(async ({ page }) => {
    await signInAsDevUser(page)
    await clientSideNavigate(page, '/compliance/audit')
    await expect(page.locator('.page__title')).toBeVisible()
  })

  test('applying filters fires a real GET request carrying the filter values, and View expands the hash-chain detail', async ({
    page,
  }) => {
    await page.locator('#audit-filter-entity').fill('employee')
    await page.locator('#audit-filter-entity-id').fill('emp-e2e-1')

    const [request] = await Promise.all([
      page.waitForRequest((req) => req.url().includes('/entries') && req.url().includes('entity=employee')),
      page.getByRole('button', { name: realBundle('th')['audit.filters.apply'] }).click(),
    ])
    expect(request.url()).toContain('entityId=emp-e2e-1')

    const entryHashText = page.getByText(FIXTURE_AUDIT_ENTRY.entryHash)
    await expect(entryHashText).toHaveCount(0)
    await page.getByRole('button', { name: realBundle('th')['common.view'] }).click()
    await expect(entryHashText).toBeVisible()
  })

  test('the quick filter narrows the visible rows client-side, over the page already loaded', async ({ page }) => {
    const row = page.getByRole('cell', { name: FIXTURE_AUDIT_ENTRY.action })
    await expect(row).toBeVisible()

    await page.locator('#audit-quick-filter').fill('no-such-actor-or-action')
    await expect(row).toHaveCount(0)

    await page.locator('#audit-quick-filter').fill('')
    await expect(row).toBeVisible()
  })

  test('Verify chain fires a real GET /verify and renders the result', async ({ page }) => {
    const [request] = await Promise.all([
      page.waitForRequest((req) => req.url().includes('/verify')),
      page.getByRole('button', { name: realBundle('th')['audit.verify.cta'] }).click(),
    ])
    expect(request.method()).toBe('GET')
    await expect(page.locator('.audit-verify__result--valid')).toBeVisible()
    await assertNoEmptyOrRawKeyText(page)
  })
})

test.describe('/documents — every interactive control', () => {
  test.beforeEach(async ({ page }) => {
    await signInAsDevUser(page)
    await clientSideNavigate(page, '/documents')
    await expect(page.locator('.page__title')).toBeVisible()
  })

  test('retrieving a document by id renders its metadata and a real PDF download', async ({ page }) => {
    await page.locator('#documents-lookup-id').fill('e2e-doc-1')
    await page.locator('#documents-lookup-purpose').fill('e2e access review')

    const [request] = await Promise.all([
      page.waitForRequest((req) => req.url().includes('/documents/e2e-doc-1')),
      page.getByRole('button', { name: realBundle('th')['documents.lookup.submit'] }).click(),
    ])
    expect(request.url()).toContain('purpose=e2e%20access%20review')

    const downloadButton = page.getByRole('button', { name: realBundle('th')['documents.download.cta'] })
    await expect(downloadButton).toBeVisible()

    const [download] = await Promise.all([page.waitForEvent('download'), downloadButton.click()])
    expect(download.suggestedFilename()).toContain('e2e-doc-1')
  })

  test('generating a document fires a real POST /render, then "Look up this document" retrieves it', async ({ page }) => {
    await page.locator('#documents-generate-kind').fill('letter')
    await page.locator('#documents-generate-entity-type').fill('employee')
    await page.locator('#documents-generate-entity-id').fill('emp-e2e-1')
    await page.locator('#documents-generate-html').fill('<p>hello</p>')

    const [request] = await Promise.all([
      page.waitForRequest((req) => req.url().includes('/render') && req.method() === 'POST'),
      page.getByRole('button', { name: realBundle('th')['documents.generate.submit'] }).click(),
    ])
    expect(request.method()).toBe('POST')

    const lookupNowButton = page.getByRole('button', { name: realBundle('th')['documents.generate.lookupNow'] })
    await expect(lookupNowButton).toBeVisible()

    const [lookupRequest] = await Promise.all([
      page.waitForRequest((req) => req.url().includes('/documents/e2e-doc-1')),
      lookupNowButton.click(),
    ])
    expect(lookupRequest.url()).toContain('/documents/e2e-doc-1')
    await expect(page.getByRole('button', { name: realBundle('th')['documents.download.cta'] })).toBeVisible()
  })
})

test.describe('/admin/roles — every interactive control', () => {
  test.beforeEach(async ({ page }) => {
    await signInAsDevUser(page)
    await clientSideNavigate(page, '/admin/roles')
    await expect(page.locator('.page__title')).toBeVisible()
  })

  /**
   * "Guard destructive actions behind confirmation naming the person and
   * role — this screen moves real authority" (task brief). `page.on
   * ('dialog', ...)` is Playwright's real handle on the native
   * `window.confirm` `RolesPage.tsx`'s Grant/Revoke panels call — accepting
   * it here is the end-to-end proof that confirmation, not just a click,
   * is what gates the request.
   */
  test('granting a role requires confirming the exact person and role, then fires a real POST', async ({ page }) => {
    const roleCode = FIXTURE_ROLES[0]?.code ?? ''
    await expect(page.getByRole('cell', { name: roleCode })).toBeVisible()

    page.once('dialog', (dialog) => {
      expect(dialog.message()).toContain(roleCode)
      expect(dialog.message()).toContain('e2e-target-user')
      void dialog.accept()
    })

    await page.locator('#roles-grant-user-id').fill('e2e-target-user')
    const [request] = await Promise.all([
      page.waitForRequest((req) => req.url().includes('/roles') && req.method() === 'POST'),
      page.getByRole('button', { name: realBundle('th')['admin.roles.grant.submit'] }).click(),
    ])
    expect(request.method()).toBe('POST')
    await expect(page.getByText(realBundle('th')['admin.roles.grant.success']?.replace('{role}', roleCode).replace('{userId}', 'e2e-target-user') ?? '')).toBeVisible()
  })

  test('dismissing the grant confirmation sends no request', async ({ page }) => {
    page.once('dialog', (dialog) => void dialog.dismiss())

    await page.locator('#roles-grant-user-id').fill('e2e-target-user')
    let posted = false
    page.on('request', (req) => {
      if (req.url().includes('/roles') && req.method() === 'POST') posted = true
    })
    await page.getByRole('button', { name: realBundle('th')['admin.roles.grant.submit'] }).click()
    await page.waitForTimeout(200)

    expect(posted).toBe(false)
  })

  test('revoking a role requires confirmation, then fires a real DELETE', async ({ page }) => {
    const roleCode = FIXTURE_ROLES[0]?.code ?? ''
    page.once('dialog', (dialog) => void dialog.accept())

    await page.locator('#roles-revoke-user-id').fill('e2e-target-user')
    const [request] = await Promise.all([
      page.waitForRequest((req) => req.url().includes('/roles/') && req.method() === 'DELETE'),
      page.getByRole('button', { name: realBundle('th')['admin.roles.revoke.submit'] }).click(),
    ])
    expect(request.method()).toBe('DELETE')
    await expect(
      page.getByText(realBundle('th')['admin.roles.revoke.success']?.replace('{role}', roleCode).replace('{userId}', 'e2e-target-user') ?? ''),
    ).toBeVisible()
  })
})

test.describe('/notifications — every interactive control', () => {
  test.beforeEach(async ({ page }) => {
    await signInAsDevUser(page)
    FIXTURE_NOTIFICATION.readAt = null
    await clientSideNavigate(page, '/notifications')
    await expect(page.locator('.page__title')).toBeVisible()
  })

  test('Mark read fires a real POST .../read, and the unread badge disappears', async ({ page }) => {
    // `.notification-row__badge`, not `getByText(...)` — the "Unread only"
    // filter button's own Thai label ("เฉพาะที่ยังไม่ได้อ่าน") contains the
    // badge's Thai text ("ยังไม่ได้อ่าน") as a literal substring, so a
    // plain text query matches both and Playwright's strict mode rejects
    // the ambiguity. The badge has its own class precisely so a test (and
    // a screen reader — see `notifications.css`'s header) can address it
    // unambiguously.
    const badge = page.locator('.notification-row__badge')
    await expect(badge).toBeVisible()

    const [request] = await Promise.all([
      page.waitForRequest((req) => req.url().includes('/read') && req.method() === 'POST'),
      page.getByRole('button', { name: realBundle('th')['notifications.markRead.cta'] }).click(),
    ])
    expect(request.method()).toBe('POST')

    await expect(badge).toHaveCount(0)
    await expect(page.getByRole('button', { name: realBundle('th')['notifications.markRead.cta'] })).toHaveCount(0)
  })

  test('"Unread only" re-fetches and hides an already-read notification', async ({ page }) => {
    await page.getByRole('button', { name: realBundle('th')['notifications.markRead.cta'] }).click()
    await expect(page.locator('.notification-row__badge')).toHaveCount(0)

    const [request] = await Promise.all([
      page.waitForRequest((req) => req.url().includes('unread=true')),
      page.getByRole('button', { name: realBundle('th')['notifications.filter.unreadOnly'] }).click(),
    ])
    expect(request.url()).toContain('unread=true')
    await expect(page.getByText(realBundle('th')['notifications.emptyState'] ?? '')).toBeVisible()
  })
})
