# web

The GaDongHR PWA shell: OIDC login, the th/en/zh switcher, role-driven navigation, and the
`/admin/statutory-rules` console (DESIGN.md's Direction 1, "Official Record" — read that file
first, it is binding). This directory also holds the **UI-coverage gate**: `ui-coverage.json` maps
every HTTP route in the system to a screen or an explicit exemption, and `ui-coverage.test.ts`
enforces it by re-parsing every `services/**/*.controller.ts` and failing on any mismatch. See
`docs/superpowers/plans/00-PROGRAM-ROADMAP.md`, "Every endpoint has a front end — enforced, not
intended", for why this exists.

## Run it locally

1. `cp web/.env.local.example web/.env.local` and fill in the OIDC/service URLs for your machine.
2. `pnpm install` at the repo root, then `pnpm --filter @gadong/web dev` — starts Vite on
   `http://localhost:5173` against `.env.local`.
3. Need a real login? Run `deploy/docker-compose.yml`'s `keycloak` + `svc-config` + `svc-i18n`
   services and point `.env.local` at them (see that file's own docs).
4. **No Keycloak available?** Set `VITE_DEV_BYPASS=true` in `.env.local` — the "Sign in" button
   then signs you in locally with a fabricated principal, no redirect, so you can see the shell,
   nav, and i18n switcher with no backend running at all (the statutory-rules screen still needs a
   real `svc-config`/`svc-i18n` to show real data). Guaranteed dev-only, not just discouraged in
   prod: it is gated behind Vite's compile-time `import.meta.env.DEV`, which `vite build` bakes to
   `false` and dead-code-eliminates out of the shipped bundle entirely — see `src/auth/devBypass.ts`'s
   header and `src/auth/devBypass.build.test.ts`, which builds the app for real and asserts the
   bypass code is absent from `dist/`.
5. `pnpm --filter @gadong/web test` runs the Vitest suite (this package's own runner — not Jest;
   root `pnpm test` runs both).

## Known limitation: i18n and permission content this screen needs but doesn't own

Every string in this app renders through `t('some.key')` reading `svc-i18n`'s `/bundles/:locale`
(`src/i18n/I18nContext.tsx`) — never a hardcoded literal. `services/svc-i18n/bundles/*.json`
today ships keys for `common`/`auth`/`leave`/`claims`/`payroll`/`attendance`/`onboarding`/
`glossary`/`statutory.form` — not yet the `shell.*`, `admin.statutoryRules.*`, `config.error.*` or
`authz.error.*` keys this shell and console call. Extending those bundles is `svc-i18n`'s own
workstream (`web`'s ownership boundary for this task is `web/` only, not `services/`), so `t()`
falls back to rendering the raw key string for anything not yet translated — the exact "never
blank, always diagnosable" fallback `services/svc-i18n/src/bundles.service.ts`'s own
`BundlesService.resolveKey` already uses for a key missing from one locale. Nothing here is
hardcoded to paper over the gap; the screen upgrades to real copy the moment those keys ship, with
no code change.

Similarly, role-driven nav (`src/auth/permissions.ts`) reads `CurrentUser.permissions`, populated
from a `permissions` claim on the access token (or the dev-bypass token). A real Keycloak login
issued by `deploy/keycloak/realm-gadonghr.json` today carries no such claim — permission grants
live in `svc-authz`'s own database, reachable only via `POST /decide`, which `ui-coverage.json`
marks service-to-service-only and never callable from a browser. Until a `/me`-shaped endpoint or
a token claim exists, a real (non-bypass) login sees an empty permission set and no gated nav
destination renders — fail-safe, matching this system's deny-by-default design, not a bug. See
`src/auth/AuthContext.tsx`'s `CurrentUser` doc comment for the full explanation.

## Adding an endpoint without breaking the gate

1. Add the `@Get`/`@Post`/`@Put`/`@Patch`/`@Delete` route to your controller as normal.
2. Add one entry to `ui-coverage.json`'s `routes` array with matching `service`/`method`/`path`.
3. Either point it at a screen (`"screen": "/admin/whatever"`, plus the guarding `"permission"`,
   which must already be in the roadmap's permission catalog) or mark it `"exempt"` with a
   non-empty `"reason"` — `exempt` must be exactly one of `service-to-service`, `operational`, or
   `consumed-not-displayed`. "Not needed yet" is not a reason; that's a missing screen.
4. Reuse an existing `screen` route where the endpoint belongs with something already there (e.g.
   a new statutory-rules route belongs on `/admin/statutory-rules`) rather than inventing a new one.
5. Run `pnpm test -- web/ui-coverage.test.ts` — it fails and names the exact route if you skipped
   a step above.
