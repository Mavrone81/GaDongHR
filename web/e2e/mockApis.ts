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

/**
 * Fixed base URLs `web/.env.e2e` gives the four newer services'
 * `VITE_SVC_*_URL` — same "point at a port nothing is listening on, so a
 * `page.route()` interception is the only thing that can ever answer"
 * convention `.env.e2e`'s own header describes for `VITE_SVC_CONFIG_URL`/
 * `VITE_SVC_I18N_URL`.
 *
 * The mocks below match against these ORIGINS explicitly (a `URL`
 * predicate, not a bare `'**\/documents/**'`-style glob) — deliberately,
 * after a real regression: `web`'s own route folders are named
 * `routes/documents/`, `routes/notifications/`, etc. (the same words these
 * APIs use), so `vite dev`'s SAME-ORIGIN module requests for
 * `src/routes/documents/DocumentsPage.tsx` also contain the literal
 * substring `/documents/` — a loose `'**\/documents/**'` glob (`**`
 * crosses `/`) matched that request too, answered it with `{"...":...}`
 * JSON instead of JavaScript, and broke the ENTIRE module graph (`App.tsx`
 * imports `DocumentsPage` eagerly), which is why every screen — not just
 * Documents — failed to render at all. Anchoring on `url.origin` makes
 * that class of collision structurally impossible: a same-origin dev-server
 * asset request can never match an intercept scoped to a different fake
 * origin.
 */
const E2E_SVC_AUDIT_ORIGIN = 'http://localhost:4912'
const E2E_SVC_DOCS_ORIGIN = 'http://localhost:4913'
const E2E_SVC_AUTHZ_ORIGIN = 'http://localhost:4914'
const E2E_SVC_NOTIFY_ORIGIN = 'http://localhost:4915'

/** One hash-chained `audit.entry` row, shaped like `services/svc-audit/src/entries.repository.ts`'s `StoredEntry` — real chain fields (not fabricated), so `AuditPage.tsx`'s detail panel has real hashes to display. */
export const FIXTURE_AUDIT_ENTRY = {
  id: '1',
  occurredAt: '2026-01-15T09:30:00.000Z',
  actorId: 'e2e-hr-officer',
  actorRole: 'hr-officer',
  action: 'employee.update',
  entity: 'employee',
  entityId: 'emp-e2e-1',
  purpose: 'onboarding review',
  beforeHash: 'e2e-before-hash',
  afterHash: 'e2e-after-hash',
  prevEntryHash: '0'.repeat(64),
  entryHash: 'e2e-entry-hash-1',
}

/**
 * Intercepts svc-audit's `GET /entries` and `GET /verify`
 * (`services/svc-audit/src/entries.controller.ts`) — no live svc-audit
 * process, same reasoning as `mockSvcConfig`. `/verify` reports the fixture
 * chain as intact; the "chain broken" shape is exercised at the unit level
 * (`AuditPage.test.tsx`), not here, since forging a genuinely-broken
 * `VerifyResult` from this fixture would just be typing the shape by hand
 * either way.
 */
export async function mockSvcAudit(page: Page): Promise<void> {
  await page.route(
    (url) => url.origin === E2E_SVC_AUDIT_ORIGIN && url.pathname === '/entries',
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ entries: [FIXTURE_AUDIT_ENTRY], page: 1 }),
      })
    },
  )

  await page.route(
    (url) => url.origin === E2E_SVC_AUDIT_ORIGIN && url.pathname === '/verify',
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ valid: true, entryCount: 1, issues: [] }),
      })
    },
  )
}

/** One `docs.document` row, shaped like `services/svc-docs/src/documents.controller.ts`'s `DocumentResponseBody` — `contentBase64` is a tiny real base64 payload (not the string `"base64"`), so `DocumentsPage.tsx`'s `base64ToBlob` has real bytes to decode. */
export const FIXTURE_DOCUMENT_ID = 'e2e-doc-1'
export const FIXTURE_DOCUMENT = {
  id: FIXTURE_DOCUMENT_ID,
  kind: 'contract',
  entityType: 'employee',
  entityId: 'emp-e2e-1',
  lang: 'en',
  sha256: 'e2e0000000000000000000000000000000000000000000000000000000000',
  createdAt: '2026-01-10T00:00:00.000Z',
  contentBase64: 'JVBERi1mYWtl', // "%PDF-fake", base64
}

/**
 * Intercepts svc-docs' `GET /documents/:id` and `POST /render`
 * (`services/svc-docs/src/documents.controller.ts`) — no live svc-docs
 * process, same reasoning as `mockSvcConfig`. `/render` always answers with
 * `FIXTURE_DOCUMENT_ID`, so the generate-then-look-up flow
 * (`DocumentsPage.tsx`'s `GeneratePanel`/`onGenerated`) resolves to a
 * document `/documents/:id` also serves.
 */
export async function mockSvcDocs(page: Page): Promise<void> {
  await page.route(
    (url) => url.origin === E2E_SVC_DOCS_ORIGIN && url.pathname === '/render',
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: FIXTURE_DOCUMENT_ID,
          kind: 'contract',
          entityType: 'employee',
          entityId: 'emp-e2e-1',
          lang: 'en',
          sha256: FIXTURE_DOCUMENT.sha256,
        }),
      })
    },
  )

  await page.route(
    (url) => url.origin === E2E_SVC_DOCS_ORIGIN && url.pathname.startsWith('/documents/'),
    async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FIXTURE_DOCUMENT) })
    },
  )
}

/** Role templates, shaped like `services/svc-authz/src/authz.controller.ts`'s `RoleWithPermissions` — codes/permissions drawn from the real catalog (`services/svc-authz/src/seed/roles.ts`), not invented ones. */
export const FIXTURE_ROLES = [
  {
    id: 'role-hr-officer',
    code: 'hr-officer',
    nameI18n: { en: 'HR Officer', th: 'เจ้าหน้าที่ทรัพยากรบุคคล' },
    isSystem: true,
    permissions: ['employee.read', 'employee.update', 'leave.admin'],
  },
  {
    id: 'role-line-manager',
    code: 'line-manager',
    nameI18n: { en: 'Line Manager', th: 'ผู้จัดการสายงาน' },
    isSystem: true,
    permissions: ['roster.read', 'roster.write', 'leave.approve'],
  },
]

/**
 * Intercepts svc-authz's `GET /roles`, `POST /users/:id/roles` and
 * `DELETE /users/:id/roles/:roleId` (`services/svc-authz/src/authz.controller.ts`)
 * — no live svc-authz process, same reasoning as `mockSvcConfig`. This is
 * what makes `/admin/roles`'s Grant/Revoke panels exercisable end to end.
 */
export async function mockSvcAuthz(page: Page): Promise<void> {
  await page.route(
    (url) => url.origin === E2E_SVC_AUTHZ_ORIGIN && url.pathname === '/roles',
    async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ roles: FIXTURE_ROLES }) })
    },
  )

  await page.route(
    (url) => url.origin === E2E_SVC_AUTHZ_ORIGIN && /^\/users\/[^/]+\/roles$/.test(url.pathname),
    async (route) => {
      // POST /users/:id/roles — grant.
      const body = route.request().postDataJSON() as Record<string, unknown>
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'grant-e2e-1',
          userId: 'e2e-target-user',
          roleId: body['roleId'],
          orgScopeUnitId: body['orgScopeUnitId'] ?? null,
          grantedBy: body['grantedBy'],
          grantedAt: new Date().toISOString(),
        }),
      })
    },
  )

  await page.route(
    (url) => url.origin === E2E_SVC_AUTHZ_ORIGIN && /^\/users\/[^/]+\/roles\/[^/]+$/.test(url.pathname),
    async (route) => {
      // DELETE /users/:id/roles/:roleId — revoke.
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ deleted: 1 }) })
    },
  )
}

/** One `notify.notification` row, shaped like `services/svc-notify/src/notify.repository.ts`'s `NotificationRow` — starts unread (`readAt: null`) so `NotificationsPage.tsx`'s Mark-read control has something real to click. */
export const FIXTURE_NOTIFICATION = {
  id: 'notif-e2e-1',
  recipientUserId: 'gadonghr-dev-bypass-principal',
  kind: 'leave.approved',
  lang: 'en',
  subject: 'Your leave request was approved',
  body: 'Your annual leave for 2026-02-01 was approved by your manager.',
  readAt: null as string | null,
  createdAt: '2026-01-14T00:00:00.000Z',
}

/**
 * Intercepts svc-notify's `GET /notifications` and `POST
 * /notifications/:id/read` (`services/svc-notify/src/notify.controller.ts`)
 * — no live svc-notify process, same reasoning as `mockSvcConfig`. Mark-read
 * actually flips the fixture's `readAt` in place, so a subsequent
 * `GET /notifications` in the same test reflects the change — the real
 * behaviour `notify.repository.ts`'s `markRead` produces, not a canned
 * response that ignores what was clicked.
 */
export async function mockSvcNotify(page: Page): Promise<void> {
  await page.route(
    (url) => url.origin === E2E_SVC_NOTIFY_ORIGIN && url.pathname.startsWith('/notifications'),
    async (route) => {
      const request = route.request()
      const url2 = new URL(request.url())

      if (url2.pathname.endsWith('/read') && request.method() === 'POST') {
        FIXTURE_NOTIFICATION.readAt = new Date().toISOString()
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(FIXTURE_NOTIFICATION) })
        return
      }

      const unreadOnly = url2.searchParams.get('unread') === 'true'
      const notifications = unreadOnly && FIXTURE_NOTIFICATION.readAt !== null ? [] : [FIXTURE_NOTIFICATION]
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ notifications }) })
    },
  )
}
