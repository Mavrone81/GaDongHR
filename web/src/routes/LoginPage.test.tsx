import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LoginPage } from './LoginPage'
import { renderWithProviders } from '../test/testUtils'
import { flattenBundle } from '../i18n/flattenBundle'
import { I18nProvider } from '../i18n/I18nContext'
import { AuthContext } from '../auth/AuthContext'
import type { AuthContextValue } from '../auth/AuthContext'
import { fetchBundle } from '../api/svcI18n'
import { LOCALE_STORAGE_KEY } from '../i18n/locale'
import type { Locale } from '../i18n/locale'

vi.mock('../api/svcI18n', () => ({
  fetchBundle: vi.fn(),
}))

const mockFetchBundle = vi.mocked(fetchBundle)

/**
 * The real bundles — not a test fixture — so "no untranslated key" means
 * what it says: every string `LoginPage.tsx` resolves through `t()` really
 * has a th/en/zh entry in `services/svc-i18n/bundles/*.json`, not just in
 * a hand-written test double. Mirrors the path `fallbackBundle.sync.test.tsx`
 * already uses from this same directory depth.
 */
const BUNDLES_DIR = join(__dirname, '..', '..', '..', 'services', 'svc-i18n', 'bundles')
const REAL_BUNDLES: Record<Locale, Record<string, string>> = {
  en: flattenBundle(JSON.parse(readFileSync(join(BUNDLES_DIR, 'en.json'), 'utf-8'))),
  th: flattenBundle(JSON.parse(readFileSync(join(BUNDLES_DIR, 'th.json'), 'utf-8'))),
  zh: flattenBundle(JSON.parse(readFileSync(join(BUNDLES_DIR, 'zh.json'), 'utf-8'))),
}

const KEYS_USED_BY_LOGIN_PAGE = [
  'shell.brandMark.alt',
  'shell.brandMark.wordmarkGadong',
  'shell.brandMark.wordmarkHr',
  'auth.login.statement',
  'auth.login.title',
  'auth.session.expired',
  'shell.locale.chooseLanguage',
  'shell.locale.th',
  'shell.locale.en',
  'shell.locale.zh',
  'auth.login.submit',
  'auth.login.footer',
]

function buildAuthValue(overrides: Partial<AuthContextValue> = {}): AuthContextValue {
  return {
    status: 'unauthenticated',
    currentUser: null,
    login: vi.fn(),
    handleCallback: vi.fn(async () => undefined),
    logout: vi.fn(),
    tokenSource: { getAccessToken: () => null, refresh: vi.fn(async () => null), onUnauthorized: vi.fn() },
    ...overrides,
  }
}

describe('LoginPage — real bundle coverage (no untranslated key)', () => {
  it.each(['th', 'en', 'zh'] as const)('every key LoginPage uses has a real, non-empty translation in "%s"', (locale) => {
    const bundle = REAL_BUNDLES[locale]
    for (const key of KEYS_USED_BY_LOGIN_PAGE) {
      expect(bundle[key], `missing/empty key "${key}" in ${locale}.json`).toBeTruthy()
      // A raw key never contains a space; every real translation below does
      // (or, for th/zh, is simply not equal to the dotted key string).
      expect(bundle[key]).not.toBe(key)
    }
  })

  it.each(['th', 'en', 'zh'] as const)('renders the real bundle for locale "%s" with no raw i18n key visible', (locale) => {
    renderWithProviders(<LoginPage />, { i18n: { locale, bundle: REAL_BUNDLES[locale] } })

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(REAL_BUNDLES[locale]['auth.login.title'])
    expect(screen.getByText(REAL_BUNDLES[locale]['auth.login.statement'] ?? '')).toBeInTheDocument()
    for (const key of KEYS_USED_BY_LOGIN_PAGE) {
      expect(screen.queryByText(key)).not.toBeInTheDocument()
    }
  })
})

describe('LoginPage — expired vs first-visit', () => {
  it('renders a different message for reason="expired" than a first visit', () => {
    const bundle = REAL_BUNDLES.en
    const { unmount } = renderWithProviders(<LoginPage />, { i18n: { bundle } })
    const firstVisitText = screen.getByRole('heading', { level: 1 }).textContent
    unmount()

    renderWithProviders(<LoginPage reason="expired" />, { i18n: { bundle } })
    const expiredText = screen.getByRole('heading', { level: 1 }).textContent

    expect(expiredText).toBe(bundle['auth.session.expired'])
    expect(firstVisitText).toBe(bundle['auth.login.title'])
    expect(expiredText).not.toBe(firstVisitText)
  })
})

describe('LoginPage — the brand mark', () => {
  it('renders with an accessible name', () => {
    renderWithProviders(<LoginPage />, { i18n: { bundle: REAL_BUNDLES.en } })
    expect(screen.getByRole('img', { name: REAL_BUNDLES.en['shell.brandMark.alt'] })).toBeInTheDocument()
  })
})

describe('LoginPage — language switcher works before sign-in, with no reload', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    window.localStorage.clear()
  })

  it('changes the rendered language immediately and persists the choice, with no navigation', async () => {
    mockFetchBundle.mockImplementation(async (locale: Locale) => REAL_BUNDLES[locale])
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'en')
    const user = userEvent.setup()

    render(
      <AuthContext.Provider value={buildAuthValue()}>
        <I18nProvider>
          <LoginPage />
        </I18nProvider>
      </AuthContext.Provider>,
    )

    await waitFor(() => expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(REAL_BUNDLES.en['auth.login.title']))

    const switcher = screen.getByRole('group', { name: REAL_BUNDLES.en['shell.locale.chooseLanguage'] })
    await user.click(within(switcher).getByRole('button', { name: REAL_BUNDLES.en['shell.locale.th'] }))

    // Same document, same render tree — no reload/navigation, just the
    // context re-rendering with the new locale's bundle.
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(REAL_BUNDLES.th['auth.login.title']))

    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('th')
  })
})
