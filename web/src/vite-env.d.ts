/// <reference types="vite/client" />

/**
 * Config from env, not hardcoded (task brief): every base URL and the OIDC
 * issuer come from these Vite env vars, never a literal in source. See
 * `.env.local.example` and README.md for what to set locally, and
 * `src/env.ts` for the validated, typed accessor every module actually
 * imports (nothing reads `import.meta.env` directly outside that file).
 */
interface ImportMetaEnv {
  /** Keycloak realm issuer, e.g. `http://localhost:8080/realms/gadonghr`. */
  readonly VITE_OIDC_ISSUER: string
  /** Must match `deploy/keycloak/realm-gadonghr.json`'s public `web` client id. */
  readonly VITE_OIDC_CLIENT_ID: string
  /** Where Keycloak redirects back to after login; must be registered in the realm's `web` client `redirectUris`. */
  readonly VITE_OIDC_REDIRECT_URI: string
  /** `aud` claim every access token must carry — matches `docker-compose.yml`'s `OIDC_AUDIENCE`. */
  readonly VITE_OIDC_AUDIENCE: string
  readonly VITE_SVC_CONFIG_URL: string
  readonly VITE_SVC_I18N_URL: string
  /**
   * svc-audit's `/entries`, `/verify` — the Audit console
   * (`/compliance/audit`). Optional (`env.ts`'s `optionalWithFallback`):
   * unset falls back to the real production Traefik path `/api/audit` —
   * see that function's doc for why this one, unlike the two above, has a
   * safe default instead of failing loudly when absent.
   */
  readonly VITE_SVC_AUDIT_URL?: string
  /** svc-docs' `/documents/:id`, `/render` — the Documents console (`/documents`). Optional, same fallback pattern as `VITE_SVC_AUDIT_URL` (`/api/docs`). */
  readonly VITE_SVC_DOCS_URL?: string
  /** svc-authz's `/roles`, `/users/:id/roles*` — the Roles console (`/admin/roles`). Optional, same fallback pattern as `VITE_SVC_AUDIT_URL` (`/api/authz`). */
  readonly VITE_SVC_AUTHZ_URL?: string
  /** svc-notify's `/notifications*` — the Notifications inbox (`/notifications`). Optional, same fallback pattern as `VITE_SVC_AUDIT_URL` (`/api/notify`). */
  readonly VITE_SVC_NOTIFY_URL?: string
  /**
   * Opt-in dev-only login bypass (skips the OIDC redirect, signs in as a
   * fixed local principal) so the shell is usable with no Keycloak running.
   * Read ONLY behind `import.meta.env.DEV` — see `src/auth/devBypass.ts`'s
   * header for how a production build makes this impossible to enable even
   * if this flag is left `true` in a shipped `.env` file.
   */
  readonly VITE_DEV_BYPASS?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
