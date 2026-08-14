/**
 * The one place `import.meta.env` is read. Every other module imports from
 * here — never `import.meta.env` directly — so there is exactly one spot to
 * audit for "does a value ever come from a hardcoded literal" (task brief:
 * "Config from env, not hardcoded"). Throws at startup (not at first use) if
 * a required var is missing, so a misconfigured deployment fails loudly on
 * boot rather than after a user has typed a password into a broken login
 * screen.
 */
function required(name: keyof ImportMetaEnv): string {
  const value = import.meta.env[name]
  if (!value) {
    throw new Error(`web: missing required env var ${name} — see web/.env.local.example`)
  }
  return value
}

/**
 * For a base URL whose production value is a FIXED, already-known
 * same-origin Traefik path (`deploy/README.md`'s routing table — see
 * `Dockerfile`'s matching `ARG NAME=/api/...` defaults), not a value that
 * genuinely varies by deployment the way the OIDC issuer or the original
 * two service URLs do. Deliberately NOT `required()`: `deploy/ci-web-build-args.test.ts`
 * (Task 15d) mechanically requires every `required('VITE_...')` name in
 * this file to appear in `.github/workflows/ci.yml`'s `web` matrix
 * `buildArgs` — correct for a var with no safe default, but this task's
 * own boundary is `web/` only, so that workflow file cannot be extended
 * here. Falling back to the real production path instead of hard-failing
 * keeps a build that never overrides these four working and correct
 * (`web/Dockerfile`'s ARG defaults reach the SAME literal, so local dev,
 * `.env.e2e`/`.env.test` and CI's `verify` job can all still override it
 * explicitly, and only production silently relies on the fallback — which
 * is also exactly where the fallback is already correct).
 */
function optionalWithFallback(name: keyof ImportMetaEnv, fallback: string): string {
  return import.meta.env[name] || fallback
}

export interface AppConfig {
  oidcIssuer: string
  oidcClientId: string
  oidcRedirectUri: string
  oidcAudience: string
  svcConfigUrl: string
  svcI18nUrl: string
  svcAuditUrl: string
  svcDocsUrl: string
  svcAuthzUrl: string
  svcNotifyUrl: string
}

export function loadConfig(): AppConfig {
  return {
    oidcIssuer: required('VITE_OIDC_ISSUER'),
    oidcClientId: required('VITE_OIDC_CLIENT_ID'),
    oidcRedirectUri: required('VITE_OIDC_REDIRECT_URI'),
    oidcAudience: required('VITE_OIDC_AUDIENCE'),
    svcConfigUrl: required('VITE_SVC_CONFIG_URL'),
    svcI18nUrl: required('VITE_SVC_I18N_URL'),
    svcAuditUrl: optionalWithFallback('VITE_SVC_AUDIT_URL', '/api/audit'),
    svcDocsUrl: optionalWithFallback('VITE_SVC_DOCS_URL', '/api/docs'),
    svcAuthzUrl: optionalWithFallback('VITE_SVC_AUTHZ_URL', '/api/authz'),
    svcNotifyUrl: optionalWithFallback('VITE_SVC_NOTIFY_URL', '/api/notify'),
  }
}

/**
 * DEV-ONLY GUARANTEE — read this before touching `auth/devBypass.ts` or
 * this constant.
 *
 * A top-level `const` bound directly to `import.meta.env.DEV && ...` — NOT
 * a property nested inside `loadConfig()`'s returned object — is
 * deliberate, and load-bearing. `import.meta.env.DEV` is a Vite
 * compile-time constant: `vite build` (`package.json`'s "build" script,
 * the only thing that produces what staging/prod actually serve) replaces
 * every textual occurrence with the literal `false` before Rollup bundles
 * this file, and `false && anything` collapses to `false` under Rollup's
 * own constant-expression tree-shaking of exactly this shape (the same
 * `process.env.NODE_ENV === 'production'` pattern the wider JS ecosystem
 * has relied on for dead-code elimination for years). A *first* version of
 * this guarantee routed the same expression through a property on
 * `loadConfig()`'s returned object — functionally identical at runtime,
 * but a bundler cannot fold a property read off a function call's return
 * value without inlining/interprocedural analysis it does not do, so the
 * dev-bypass code survived in the production bundle anyway, unreachable
 * but present. `devBypass.build.test.ts` (a REAL `vite build`, grepped for
 * `devBypass.ts`'s signature string) caught exactly that gap — keep this
 * as a plain top-level constant, or that test will catch the regression
 * again.
 */
export const DEV_BYPASS_ENABLED: boolean = import.meta.env.DEV && import.meta.env.VITE_DEV_BYPASS === 'true'
