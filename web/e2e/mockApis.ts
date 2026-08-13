import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'

export type Locale = 'th' | 'en' | 'zh'

// `web`'s `package.json` sets `"type": "module"`, so this file runs as real
// ESM under Playwright's runner — no `__dirname` — hence `import.meta.url`,
// the same pattern `vite.config.ts` already uses for the same reason.
const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLES_DIR = join(HERE, '..', '..', 'services', 'svc-i18n', 'bundles')

/**
 * A small, deliberately-duplicated copy of `web/src/i18n/flattenBundle.ts`'s
 * logic — this file is Playwright test tooling (Node-side, not shipped in
 * the app bundle), and importing the real app source across
 * `playwright.config.ts`'s `testDir` boundary is more coupling than a
 * ten-line flatten function is worth. `services/svc-i18n/src/flatten.ts`
 * (the real server's own flattener) is the third copy of this same shape;
 * see `web/src/i18n/flattenBundle.ts`'s header for why the app itself
 * can't import it directly either.
 */
function flatten(value: unknown, path = ''): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = path ? `${path}.${key}` : key
    if (typeof child === 'string') {
      result[childPath] = child
    } else {
      Object.assign(result, flatten(child, childPath))
    }
  }
  return result
}

function loadBundle(locale: Locale): Record<string, string> {
  const raw: unknown = JSON.parse(readFileSync(join(BUNDLES_DIR, `${locale}.json`), 'utf-8'))
  return flatten(raw)
}

const REAL_BUNDLES: Record<Locale, Record<string, string>> = {
  th: loadBundle('th'),
  en: loadBundle('en'),
  zh: loadBundle('zh'),
}

/** Read-only export so a spec can assert against the exact real translated text, not a hand-typed guess that could drift from `services/svc-i18n/bundles/*.json`. */
export function realBundle(locale: Locale): Record<string, string> {
  return REAL_BUNDLES[locale]
}

/**
 * Intercepts `GET /bundles/:locale` (`services/svc-i18n/src/bundles.controller.ts`)
 * with the REAL, current translation content — read straight from
 * `services/svc-i18n/bundles/*.json` at test-run time, never hand-copied —
 * so "test all three languages" (task brief) proves real Thai/English/
 * Chinese text renders, not fixture strings that could silently drift from
 * what svc-i18n actually ships. No live svc-i18n process is ever
 * contacted: `.env.e2e` points `VITE_SVC_I18N_URL` at a port nothing is
 * listening on, and this intercepts the request before it ever reaches
 * the network.
 */
export async function mockI18nReachable(page: Page): Promise<void> {
  await page.route('**/bundles/*', async (route) => {
    const url = new URL(route.request().url())
    const locale = url.pathname.split('/').pop()
    const bundle = locale && locale in REAL_BUNDLES ? REAL_BUNDLES[locale as Locale] : undefined
    if (!bundle) {
      await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ code: 'I18N-404' }) })
      return
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(bundle) })
  })
}

/**
 * The inverse of `mockI18nReachable` — every `/bundles/:locale` request
 * fails at the network layer (`route.abort()`, not a 4xx/5xx: this is
 * "svc-i18n is unreachable," not "svc-i18n answered with an error"). Used
 * by the one spec that proves item 6 of the task brief: with svc-i18n
 * completely unreachable, the app must still show readable Thai from the
 * bundle compiled into it at build time (`src/i18n/fallbackBundle.ts`) —
 * never a blank screen, never a raw `auth.login.submit`-shaped key.
 */
export async function mockI18nUnreachable(page: Page): Promise<void> {
  await page.route('**/bundles/*', async (route) => {
    await route.abort('connectionrefused')
  })
}

export interface RuleFixture {
  id: string
  ruleKey: string
  value: number
  unit: string
  statutoryFloor: number | null
  statutoryCeiling: number | null
  citation: string
  effectiveFrom: string
  effectiveTo: string | null
  governanceClass: 'STATUTORY_FLOOR' | 'STATUTORY_FIXED' | 'COMPANY_POLICY'
  status: 'draft' | 'pending_approval' | 'active' | 'superseded'
  proposedBy: string | null
  approvedBy: string | null
  reason: string | null
  createdAt: string
}

/**
 * One draft rule, proposed by someone other than the dev-bypass principal
 * (`src/auth/devBypass.ts`'s `DEV_BYPASS_SIGNATURE`) — so `RuleRow.tsx`'s
 * `canApprove && !isProposer` segregation-of-duties check renders a real,
 * clickable Approve button for the suite to exercise (a self-proposed row
 * renders no button at all, by design; see `StatutoryRulesPage.tsx`'s
 * header).
 */
export const FIXTURE_RULE: RuleFixture = {
  id: 'e2e-rule-1',
  ruleKey: 'minimum_wage.bangkok',
  value: 400,
  unit: 'THB/day',
  statutoryFloor: 400,
  statutoryCeiling: null,
  citation: 'ประกาศคณะกรรมการค่าจ้าง ฉบับที่ 1 (e2e fixture)',
  effectiveFrom: '2024-01-01',
  effectiveTo: null,
  governanceClass: 'STATUTORY_FLOOR',
  status: 'draft',
  proposedBy: 'some-other-user',
  approvedBy: null,
  reason: null,
  createdAt: '2024-01-01T00:00:00.000Z',
}

/**
 * Intercepts `svc-config`'s `GET/POST /rules`, `GET /rules/:key` and
 * `POST /rules/:id/approve` (`services/svc-config/src/rules.controller.ts`)
 * with an in-memory fixture — no live svc-config process, same reasoning
 * as `mockI18nReachable`. This is what makes `/admin/statutory-rules`'s
 * interactive elements (Propose, View, Approve) exercisable at all: with
 * nothing mocked, `listRules()` simply fails and the page falls back to
 * its empty state, which is a legitimate render but has no rows to click.
 */
export async function mockSvcConfig(page: Page): Promise<void> {
  await page.route('**/rules', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ rules: [FIXTURE_RULE] }) })
      return
    }
    // POST /rules — propose. Echoes the submitted input back as a new draft row.
    const input = route.request().postDataJSON() as Record<string, unknown>
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ...input,
        id: 'e2e-rule-new',
        status: 'draft',
        approvedBy: null,
        createdAt: new Date().toISOString(),
      }),
    })
  })

  await page.route('**/rules/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/approve')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ...FIXTURE_RULE, status: 'active', approvedBy: 'gadonghr-dev-bypass-principal' }),
      })
      return
    }
    // GET /rules/:key?on=... — the "as of" lookup.
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FIXTURE_RULE) })
  })
}
