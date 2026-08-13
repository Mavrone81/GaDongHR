import { expect } from '@playwright/test'
import type { Page } from '@playwright/test'

/**
 * Item 1 of the task brief, and the single assertion that would have
 * caught BOTH production blank-page incidents: `#root` must have actual
 * child nodes AND real, non-empty, human-visible text. A service worker
 * serving a stale `index.html` against deleted asset hashes still returns
 * HTTP 200 with a perfectly healthy-looking `<div id="root"></div>` — only
 * checking what's actually IN it catches that.
 */
export async function assertAppRendered(page: Page): Promise<void> {
  const root = page.locator('#root')
  await expect(root).toBeVisible()

  const childCount = await root.locator('> *').count()
  expect(childCount, '#root has no child elements — the app never mounted').toBeGreaterThan(0)

  const text = (await root.innerText()).trim()
  expect(
    text,
    '#root has children but no visible text — the "healthy DOM, blank screen" failure mode curl cannot see',
  ).not.toBe('')
}

/**
 * Raw, unresolved i18n keys look exactly like `auth.login.submit` or
 * `shell.nav.statutoryRules` — a lowercase-leading, dot-separated
 * identifier. `I18nContext.tsx`'s fallback chain guarantees `t()` never
 * returns `''`, but its LAST resort is the raw key string itself — this is
 * what makes that "diagnosable, not invisible" guarantee show up as a
 * genuine defect if it's ever the key literally on screen.
 */
const RAW_I18N_KEY_PATTERN = /\b[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*){1,}\b/

/**
 * Item 4 of the task brief: no empty strings anywhere in the UI, and no
 * unrendered i18n key visible anywhere in the UI. Two checks:
 *
 *  1. The whole page's visible text is scanned for anything shaped like a
 *     raw i18n key (catches a missing translation surfacing as
 *     `auth.login.submit` instead of real text).
 *  2. Every interactive control (button, link, form field) is walked in
 *     the page itself and must resolve to a non-empty accessible name —
 *     `aria-label`, an associated `<label for>` (every `Field` in this app
 *     sets one — `src/components/Field.tsx`), or, for buttons/links, its
 *     own text content. An empty accessible name is the exact failure
 *     mode the task brief calls "the worst" — it looks like nothing is
 *     wrong, which is how "the lousy sign-in page" and both blank-page
 *     incidents went unnoticed.
 */
export async function assertNoEmptyOrRawKeyText(page: Page): Promise<void> {
  const bodyText = await page.locator('body').innerText()
  const match = RAW_I18N_KEY_PATTERN.exec(bodyText)
  expect(match, `page shows what looks like a raw, unresolved i18n key: "${String(match?.[0])}"`).toBeNull()

  const problems = await page.evaluate(() => {
    function accessibleName(el: Element): string {
      const ariaLabel = el.getAttribute('aria-label')
      if (ariaLabel && ariaLabel.trim() !== '') return ariaLabel.trim()

      const id = el.getAttribute('id')
      if (id) {
        const label = document.querySelector(`label[for="${CSS.escape(id)}"]`)
        if (label?.textContent && label.textContent.trim() !== '') return label.textContent.trim()
      }

      const text = (el as HTMLElement).innerText ?? el.textContent ?? ''
      return text.trim()
    }

    const found: string[] = []
    document.querySelectorAll('button, a[href], input, select, textarea, [role="button"]').forEach((el) => {
      // A hidden template/placeholder element (e.g. a `display:none` select
      // option host) is not something a user can perceive at all — only
      // controls actually laid out on the page are in scope here.
      const visible = (el as HTMLElement).offsetParent !== null
      if (!visible) return
      const name = accessibleName(el)
      if (name === '') found.push(el.outerHTML.slice(0, 160))
    })
    return found
  })

  expect(problems, `control(s) with an empty accessible name:\n${problems.join('\n')}`).toEqual([])
}
