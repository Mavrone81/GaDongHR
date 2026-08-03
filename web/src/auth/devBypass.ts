import { encodeUnsignedJwt } from './jwt'
import type { TokenSet } from './oidcClient'

/**
 * Dev-only login bypass, for running the shell with no Keycloak available
 * (web/README.md, "Run it locally"). It fabricates an in-memory, UNSIGNED
 * token — never a real Keycloak session — so every backend this app talks
 * to still verifies it exactly as it would any other bearer token
 * (`OidcMiddleware`'s real JWKS check) and rejects it with a normal 401,
 * driving the same re-auth path a genuinely expired session would. This
 * bypass gets you the SHELL — routing, i18n, nav, the statutory-rules
 * layout — with no backend running at all; it does not and cannot forge a
 * working session against a real svc-config.
 *
 * PRODUCTION GUARANTEE — how this is impossible to enable in a shipped
 * build, not just discouraged:
 *
 *  1. Every call site gates this behind `env.devBypassEnabled`
 *     (`src/env.ts`), which is itself gated behind `import.meta.env.DEV`.
 *  2. `import.meta.env.DEV` is a Vite COMPILE-TIME constant, not a runtime
 *     env read: `vite build` (`package.json`'s "build" script — the only
 *     thing that produces what staging/prod actually serve) statically
 *     replaces every `import.meta.env.DEV` occurrence with the literal
 *     `false` before Rollup ever bundles this file, and Rollup's dead-code
 *     elimination then deletes the entire `if (env.devBypassEnabled)`
 *     branch — this file's code included — from the emitted output. There
 *     is no runtime flag, header, or query string that flips `DEV` back to
 *     `true` in that artifact; it is baked in at build time, once, by Vite
 *     itself, the same mechanism every `NODE_ENV==='production'` dead-code
 *     strip in the wider JS ecosystem relies on.
 *  3. `devBypass.build.test.ts` does not just assert this — it runs a real
 *     `vite build` and greps the emitted `dist/` bundle for this file's
 *     signature string, failing the build if it is ever found.
 *
 * A developer cannot "just set VITE_DEV_BYPASS=true in prod" to undo this:
 * that env var only ever reaches a build Vite already produced with `DEV`
 * baked to `false`, and the branch reading it is gone from that artifact.
 */
export const DEV_BYPASS_SIGNATURE = 'gadonghr-dev-bypass-principal'

export interface DevPrincipal {
  sub: string
  preferredUsername: string
  permissions: string[]
}

export const DEV_PRINCIPAL: DevPrincipal = {
  sub: DEV_BYPASS_SIGNATURE,
  preferredUsername: 'dev.bypass',
  // A generous grant so the shell's nav/permission gating has something to
  // show — this is a UI convenience token, never accepted by a real
  // resource server (see file header).
  permissions: [
    'config.rule.read',
    'config.rule.propose',
    'config.rule.approve',
    'config.pack.import',
    'audit.read',
    'authz.role.read',
    'notify.notification.read',
    'notify.notification.update',
    'document.read',
  ],
}

export function createDevSession(now: () => number = Date.now): TokenSet {
  const accessToken = encodeUnsignedJwt({
    sub: DEV_PRINCIPAL.sub,
    preferred_username: DEV_PRINCIPAL.preferredUsername,
    permissions: DEV_PRINCIPAL.permissions,
    exp: Math.floor(now() / 1000) + 3600,
  })
  return { accessToken, refreshToken: null, idToken: null, expiresAt: now() + 3600_000 }
}
