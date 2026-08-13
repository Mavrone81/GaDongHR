import type { Page } from '@playwright/test'

/**
 * Client-side navigation, deliberately NOT `page.goto(path)`, for any
 * already-authenticated test that needs to reach a route with no clickable
 * link pointing at it (the catch-all route; a direct deep-link).
 *
 * WHY THIS MATTERS HERE SPECIFICALLY: `AuthContext.tsx`'s header is
 * explicit — session tokens live ONLY in React state, in memory, on
 * purpose ("a page reload drops the session and forces a fresh login...
 * the cost is real and accepted"). `page.goto()` always performs a real
 * browser navigation (a fresh document load, same as a user typing a URL
 * and pressing enter), which re-runs `main.tsx` from scratch and drops
 * exactly that in-memory session — this is not a test artifact, it is
 * this app's actual, deliberate security behaviour, and asserting an
 * authenticated screen survives a `page.goto()` would be testing something
 * false. `react-router-dom`'s `BrowserRouter` reacts to the native
 * `history` API the same way clicking a `<NavLink>` does — pushing a new
 * entry, then a `popstate` event — so replicating exactly that here stays
 * inside the SPA, the same as a real click, with the session intact.
 */
export async function clientSideNavigate(page: Page, path: string): Promise<void> {
  await page.evaluate((p) => {
    window.history.pushState({}, '', p)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }, path)
}
