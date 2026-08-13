import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { I18nProvider, useI18n } from './I18nContext'
import { fetchBundle } from '../api/svcI18n'
import { FALLBACK_BUNDLE } from './fallbackBundle'

vi.mock('../api/svcI18n', () => ({
  fetchBundle: vi.fn(),
}))

const mockFetchBundle = vi.mocked(fetchBundle)

function Probe({ tKey }: { tKey: string }): React.JSX.Element {
  const { t, ready } = useI18n()
  return (
    <div>
      <span data-testid="ready">{String(ready)}</span>
      <span data-testid="value">{t(tKey)}</span>
    </div>
  )
}

describe('I18nProvider — fallback chain when svc-i18n is unreachable', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  /**
   * THE bug this task fixes: with no backend running at all, `fetchBundle`
   * rejects for every locale. Before this change, `t()` resolved every key
   * to `''` — a blank screen with a single unlabelled `<button>`. Now it
   * must resolve through the bundle compiled into the app at build time —
   * Thai, since that is this product's default language (`i18n/locale.ts`,
   * `fallbackBundle.ts`'s header) and the audience this last resort exists
   * to protect.
   */
  it('resolves to the compiled-in Thai bundle, never an empty string, when the fetch rejects', async () => {
    mockFetchBundle.mockRejectedValue(new Error('svc-i18n unreachable'))
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    render(
      <I18nProvider>
        <Probe tKey="auth.login.title" />
      </I18nProvider>,
    )

    await waitFor(() => expect(screen.getByTestId('ready').textContent).toBe('true'))

    expect(screen.getByTestId('value').textContent).toBe(FALLBACK_BUNDLE['auth.login.title'])
    expect(screen.getByTestId('value').textContent).not.toBe('')
  })

  it('logs exactly one warning naming the failure, not one per missing key', async () => {
    mockFetchBundle.mockRejectedValue(new Error('svc-i18n unreachable'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    render(
      <I18nProvider>
        <>
          <Probe tKey="auth.login.title" />
          <Probe tKey="auth.login.submit" />
          <Probe tKey="shell.brand" />
          <Probe tKey="common.loading" />
        </>
      </I18nProvider>,
    )

    await waitFor(() => expect(screen.getAllByTestId('ready')[0]?.textContent).toBe('true'))

    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0]?.[0]).toContain('svc-i18n')
  })

  it('falls back to a raw key (never empty) for a key absent from every layer', async () => {
    mockFetchBundle.mockRejectedValue(new Error('svc-i18n unreachable'))
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    render(
      <I18nProvider>
        <Probe tKey="this.key.does.not.exist.anywhere" />
      </I18nProvider>,
    )

    await waitFor(() => expect(screen.getByTestId('ready').textContent).toBe('true'))
    expect(screen.getByTestId('value').textContent).toBe('this.key.does.not.exist.anywhere')
  })

  it('prefers the fetched locale bundle over the compiled-in fallback when the fetch succeeds', async () => {
    mockFetchBundle.mockResolvedValue({ 'auth.login.title': 'จากเซิร์ฟเวอร์' })

    render(
      <I18nProvider>
        <Probe tKey="auth.login.title" />
      </I18nProvider>,
    )

    await waitFor(() => expect(screen.getByTestId('ready').textContent).toBe('true'))
    expect(screen.getByTestId('value').textContent).toBe('จากเซิร์ฟเวอร์')
  })

  it('does not warn at all when the fetch succeeds', async () => {
    mockFetchBundle.mockResolvedValue({ 'auth.login.title': 'Sign in' })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    render(
      <I18nProvider>
        <Probe tKey="auth.login.title" />
      </I18nProvider>,
    )

    await waitFor(() => expect(screen.getByTestId('ready').textContent).toBe('true'))
    expect(warnSpy).not.toHaveBeenCalled()
  })
})
