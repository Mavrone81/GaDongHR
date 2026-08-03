import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { App } from './App'

/**
 * THE regression this test guards against: with svc-i18n completely
 * unreachable (no backend running at all — exactly `pnpm --filter
 * @gadong/web dev` with `VITE_DEV_BYPASS=true` and nothing else up), the
 * app used to render a single unlabelled `<button>` on a white background —
 * every `t()` call resolved to `''`. `App.test.tsx` (component-mount
 * assertions via `renderWithProviders`'s fully-controlled `I18nContext`
 * double) passed throughout that regression, because it never exercises
 * the real `I18nProvider`'s fetch-and-fallback path at all. This test
 * mounts the REAL `<App/>` (real `I18nProvider`, real fetch call) with
 * `fetch` rejecting, and fails on a blank screen instead of merely on a
 * missing DOM node.
 */
describe('App renders readable text even when svc-i18n is completely unreachable', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows a sign-in control with a non-empty accessible name, not a blank screen', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('svc-i18n unreachable — no backend running')))

    render(<App />)

    const signInButton = await screen.findByRole('button')
    const heading = await screen.findByRole('heading')

    expect(signInButton.textContent?.trim()).not.toBe('')
    expect(heading.textContent?.trim()).not.toBe('')

    // Pinned to the exact fallback text (not just "is non-empty") so a
    // future change that silently reintroduces the empty-string bug is
    // caught by content, not merely by "a button exists" — which passed
    // even during the blank-screen regression this fixes.
    expect(signInButton).toHaveAccessibleName('Sign in')
    expect(heading).toHaveTextContent('Sign in')
  })

  it('has no empty-string text where a label is expected anywhere on the login screen', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('svc-i18n unreachable — no backend running')))

    render(<App />)

    await screen.findByRole('button')

    for (const button of screen.getAllByRole('button')) {
      expect(button.textContent?.trim()).not.toBe('')
    }
    for (const heading of screen.getAllByRole('heading')) {
      expect(heading.textContent?.trim()).not.toBe('')
    }
  })
})
