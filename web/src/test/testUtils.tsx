import { render } from '@testing-library/react'
import type { RenderResult } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { vi } from 'vitest'
import { I18nContext, createTranslator } from '../i18n/I18nContext'
import type { Bundle, I18nContextValue } from '../i18n/I18nContext'
import type { Locale } from '../i18n/locale'
import { AuthContext } from '../auth/AuthContext'
import type { AuthContextValue, CurrentUser } from '../auth/AuthContext'
import type { AuthTokenSource } from '../api/httpClient'

/** Test-only, fully-controlled `I18nContextValue` — no fetch, no real provider. */
export function buildI18nValue(overrides: Partial<I18nContextValue> & { locale?: Locale; bundle?: Bundle } = {}): I18nContextValue {
  const { bundle = {}, ...rest } = overrides
  return {
    locale: 'en',
    setLocale: vi.fn(),
    t: createTranslator(bundle),
    ready: true,
    ...rest,
  }
}

export function buildCurrentUser(overrides: Partial<CurrentUser> = {}): CurrentUser {
  return { id: 'user-1', username: 'user-1', permissions: new Set(), ...overrides }
}

export function buildTokenSource(overrides: Partial<AuthTokenSource> = {}): AuthTokenSource {
  return {
    getAccessToken: () => 'test-access-token',
    refresh: vi.fn(async () => null),
    onUnauthorized: vi.fn(),
    ...overrides,
  }
}

export function buildAuthValue(overrides: Partial<AuthContextValue> = {}): AuthContextValue {
  return {
    status: 'authenticated',
    currentUser: buildCurrentUser(),
    authError: null,
    login: vi.fn(),
    handleCallback: vi.fn(async () => undefined),
    logout: vi.fn(),
    tokenSource: buildTokenSource(),
    ...overrides,
  }
}

export function renderWithProviders(
  ui: ReactElement,
  options: {
    i18n?: Partial<I18nContextValue> & { locale?: Locale; bundle?: Bundle }
    auth?: Partial<AuthContextValue>
    route?: string
  } = {},
): RenderResult {
  const i18nValue = buildI18nValue(options.i18n)
  const authValue = buildAuthValue(options.auth)

  return render(
    <MemoryRouter initialEntries={[options.route ?? '/']}>
      <I18nContext.Provider value={i18nValue}>
        <AuthContext.Provider value={authValue}>{ui}</AuthContext.Provider>
      </I18nContext.Provider>
    </MemoryRouter>,
  )
}
