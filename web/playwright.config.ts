import { defineConfig, devices } from '@playwright/test'

/**
 * "Check all the URLs and buttons are working for all pages" (task brief) —
 * this is `web`'s real-BROWSER suite, deliberately separate from
 * `vitest.config.ts`'s unit/component tests (jsdom, no real rendering
 * engine, no service worker). The whole reason this suite exists: this
 * project shipped a blank white page to production twice, and the second
 * time every `curl`-shaped check passed (200, correct bundle, healthy
 * containers, no console errors) because a stale service worker + nginx's
 * SPA fallback served dead asset hashes as 200-and-HTML — a failure mode
 * only a real rendering engine, looking at real pixels, can catch. See
 * `web/e2e/*.spec.ts` for what's actually covered.
 *
 * `webServer` runs `vite dev --mode e2e` (NOT `vite build` + `vite
 * preview`) — deliberately. `import.meta.env.DEV` is a Vite
 * *command*-level constant (true for `serve`, false for `build`), so `vite
 * dev` is the only thing that can ever compile in `src/auth/devBypass.ts`'s
 * dev-bypass login path (`src/env.ts`'s `DEV_BYPASS_ENABLED`) — the ONLY
 * way this suite can authenticate at all. Production Keycloak has exactly
 * one real user whose first login forces a password change + OTP
 * enrolment; it cannot be scripted, and this suite does not try. A
 * production `vite build` bundle strips the dev-bypass code entirely
 * (`src/auth/devBypass.build.test.tsx` proves it), so it is not an option
 * here regardless.
 *
 * `.env.e2e` (this directory) supplies fake-but-valid config, including
 * `VITE_SVC_CONFIG_URL`/`VITE_SVC_I18N_URL` pointed at ports nothing is
 * listening on — every test either mocks those endpoints itself
 * (`web/e2e/mockApis.ts`, real bundle/rule content, no live process) or is
 * deliberately testing the unreachable-backend fallback path. No test in
 * this suite depends on any other service, container, or the production
 * server being up.
 */
const PORT = 5183
const BASE_URL = `http://localhost:${String(PORT)}`

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // One worker in CI: `webServer` is a single shared `vite dev` instance,
  // and every test drives its own isolated `page`/context already — extra
  // CI workers buy speed, not correctness, and this suite is not large
  // enough to need them. Local runs use the machine's default (parallel,
  // for a fast inner loop).
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: `pnpm exec vite dev --mode e2e --port ${String(PORT)} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
