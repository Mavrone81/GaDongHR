import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { App } from './App'
import { FALLBACK_BUNDLE } from './i18n/fallbackBundle'

// The real compiled-in fallback text (Thai — task brief: "the default
// language must be Thai", `i18n/locale.ts`/`i18n/fallbackBundle.ts`), read
// from the same bundle the app itself falls back to rather than
// hand-typed, so this test can't silently drift from what `t()` actually
// resolves to.
const SIGN_IN_TEXT = FALLBACK_BUNDLE['auth.login.title']
if (!SIGN_IN_TEXT) {
  throw new Error('fixture sanity: FALLBACK_BUNDLE is missing "auth.login.title" — fallbackBundle.sync.test.tsx should already be failing')
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

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

    // `findByRole('button', { name: ... })`, not a bare `findByRole('button')`,
    // because the login screen now also carries the pre-login language
    // switcher (task brief) — several buttons, not one — so an unfiltered
    // query would throw on ambiguity rather than actually testing anything.
    const signInButton = await screen.findByRole('button', { name: SIGN_IN_TEXT })
    const heading = await screen.findByRole('heading')

    expect(signInButton.textContent?.trim()).not.toBe('')
    expect(heading.textContent?.trim()).not.toBe('')

    // Pinned to the exact fallback text (not just "is non-empty") so a
    // future change that silently reintroduces the empty-string bug is
    // caught by content, not merely by "a button exists" — which passed
    // even during the blank-screen regression this fixes.
    expect(signInButton).toHaveAccessibleName(SIGN_IN_TEXT)
    expect(heading).toHaveTextContent(SIGN_IN_TEXT)
  })

  it('has no empty-string text where a label is expected anywhere on the login screen', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('svc-i18n unreachable — no backend running')))

    render(<App />)

    await screen.findByRole('button', { name: SIGN_IN_TEXT })

    for (const button of screen.getAllByRole('button')) {
      expect(button.textContent?.trim()).not.toBe('')
    }
    for (const heading of screen.getAllByRole('heading')) {
      expect(heading.textContent?.trim()).not.toBe('')
    }
  })
})

/**
 * THE gap the "completely unreachable" suite above does not cover: svc-i18n
 * answering with HTTP 200 and valid JSON that is nonetheless the WRONG
 * shape — e.g. still nested (`svc-i18n`'s own on-disk bundle shape, see
 * `services/svc-i18n/bundles/en.json`) rather than flattened. A rejected
 * `fetch` was always handled; a *successful* fetch that `t()` cannot use
 * was not exercised anywhere. `svcI18n.test.ts` proves `fetchBundle` now
 * rejects this shape at the unit level; this proves the effect reaches all
 * the way to the rendered DOM — the login screen must still show real
 * text, and, unlike a plain "text is non-empty" assertion (which this
 * codebase's per-key `??` fallback chain would already satisfy even
 * without `fetchBundle`'s shape check — see `svcI18n.ts`'s header comment),
 * the app must also log the SAME diagnostic warning a network failure
 * gets, so a garbage-but-200 svc-i18n deploy is not a silent, undiagnosable
 * degradation.
 */
describe('App renders readable text — and warns — when svc-i18n returns 200 with an unusable body shape', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows a sign-in control with a non-empty accessible name, not a blank screen', async () => {
    // This mocked body's own strings never surface — `fetchBundle` rejects
    // it for being nested (not this bundle's flat `{key: string}` shape,
    // see `svcI18n.ts`), so the app falls through to the same compiled-in
    // Thai fallback the "completely unreachable" suite above asserts on.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(200, { auth: { login: { title: 'unusable nested shape', submit: 'unusable nested shape' } }, shell: { brand: 'GaDongHR' } }),
      ),
    )
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    render(<App />)

    const signInButton = await screen.findByRole('button', { name: SIGN_IN_TEXT })
    const heading = await screen.findByRole('heading')

    expect(signInButton.textContent?.trim()).not.toBe('')
    expect(heading.textContent?.trim()).not.toBe('')
    expect(signInButton).toHaveAccessibleName(SIGN_IN_TEXT)
    expect(heading).toHaveTextContent(SIGN_IN_TEXT)
  })

  it('logs a warning naming the failure — the successful-but-garbage response must not degrade silently', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(200, ['not', 'a', 'bundle'])))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    render(<App />)

    await screen.findByRole('button', { name: SIGN_IN_TEXT })

    expect(warnSpy).toHaveBeenCalled()
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('svc-i18n')
  })
})
