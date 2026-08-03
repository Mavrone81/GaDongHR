# `deploy/keycloak/`

`realm-gadonghr.json` is a Keycloak realm import for Task 15b. It is
mounted read-only into the `keycloak` container
(`docker-compose.yml`'s `keycloak.volumes`) and imported automatically by
the `--import-realm` startup flag. Keycloak's own import strategy skips a
realm that already exists (`IGNORE_EXISTING`), so this is idempotent
across container restarts — it does **not** re-apply edits made to this
file after the first boot; see "Changing something after the first boot"
below.

## What it declares

- Realm `gadonghr`: login with email, no self-registration, no
  password-reset self-service (HR provisions every account —
  `scripts/bootstrap-admin.sh` creates the first one). Token lifetimes and
  brute-force settings match `docs/04-architecture/SECURITY-ENCRYPTION-DESIGN.md`
  §6: access token 15 min, SSO session 12 h, refresh-token rotation on
  (`revokeRefreshToken: true`, `refreshTokenMaxReuse: 0`), brute-force
  lockout on.
- Client `web`: public, PKCE `S256` required, standard flow only —
  implicit and direct-grant (resource-owner password) flows are both off.
  This is what the PWA logs in against.
- Client `seeder`: confidential, service accounts on, standard flow off.
  Its service account is what `scripts/seed.sh` uses to call
  `POST /packs/import`, and what `scripts/bootstrap-admin.sh` uses to
  grant the first admin their role.
- Both clients carry an `oidc-audience-mapper` stamping `aud: "gadonghr-services"`
  into every access token — `packages/kernel/src/authz/oidc.middleware.ts`
  checks `aud` against `OIDC_AUDIENCE` (`docker-compose.yml`'s `x-oidc-env`
  anchor, also `gadonghr-services`), and neither client's own `clientId`
  is that string, so without this mapper every token this realm issues
  would authenticate fine and then 403 on every single guarded route —
  the exact trap the task brief calls out by name. `realm-gadonghr.test.ts`
  asserts the mapper's `included.custom.audience` against the *parsed*
  `OIDC_AUDIENCE` value from `docker-compose.yml` (via `docker compose
  config`), not a copied string literal, so the two files cannot drift
  silently.

## Redirect URIs are NOT parameterised — and why

The brief asked for `web`'s `redirectUris`/`webOrigins` to be
parameterised rather than hard-coded to `hr.bevorasg.com`, if the import
format allows it. **It does not, reliably.** Keycloak's realm-import JSON
has no first-class, version-stable mechanism for substituting an
arbitrary environment variable into an arbitrary string field:
`${env.VAR}`-style substitution has been reported broken/regressed across
multiple releases in the 22–26.x line (keycloak/keycloak#12069, #20199,
#33578) and is not something this task can verify one way or the other
without a running Keycloak instance (explicitly out of scope here — "no
Keycloak running here"). Shipping a placeholder that might silently import
as the literal string `${PUBLIC_HOST}/*` — accepting no real redirect,
ever — is worse than a correct hard-coded value.

`redirectUris`/`webOrigins` are therefore the literal value of
`PUBLIC_HOST` from `deploy/.env.example` (`hr.bevorasg.com`), matching
every other place in this repo that already commits to that host
(`docker-compose.yml`'s own `--hostname=https://${PUBLIC_HOST}/auth`,
`deploy/README.md`). **A deployment to a different host must edit this
file's two arrays before the first `--import-realm` boot.**

## Changing something after the first boot

`--import-realm` only imports a realm that does not already exist. Once
`gadonghr` exists, editing this file has no effect until an operator
either (a) deletes the realm and lets it re-import (destructive — takes
every existing Keycloak user and session with it), or (b) makes the same
edit directly via `kcadm.sh` or the Admin Console. For a redirect-URI
change specifically, (b) is a single command run inside the `keycloak`
container:

```bash
docker compose exec keycloak /opt/keycloak/bin/kcadm.sh config credentials \
  --server http://127.0.0.1:8080/auth --realm master --user "$KC_ADMIN_USER" --password "$KC_ADMIN_PASSWORD" --client admin-cli
docker compose exec keycloak /opt/keycloak/bin/kcadm.sh update clients/$(
  docker compose exec keycloak /opt/keycloak/bin/kcadm.sh get clients -r gadonghr -q clientId=web --fields id --format csv --noquotes | tail -1
) -r gadonghr -s 'redirectUris=["https://NEW-HOST/*"]' -s 'webOrigins=["https://NEW-HOST"]'
```

## The `seeder` client's secret is not in this file

Realm-import JSON cannot safely carry a real secret either — the file is
checked into git. `realm-gadonghr.json` deliberately omits `seeder`'s
`secret` field; Keycloak auto-generates a throwaway value for it at
import time that nothing ever reads. `deploy/scripts/seed.sh` pins it, on
every run, to `KEYCLOAK_SEEDER_CLIENT_SECRET` (read from the environment)
via an idempotent Admin REST `PUT`, authenticating as the realm bootstrap
admin (`KC_ADMIN_USER`/`KC_ADMIN_PASSWORD`). See `seed.sh`'s own header
comment for the exact mechanism.

## How the seeder's identity reaches svc-authz as a grant

Keycloak authenticates and issues tokens; it does not know GaDongHR's
permission catalog — `svc-authz` owns that, entirely separately (this
task's brief, and `services/svc-authz/src/seed/roles.ts`'s own header). A
valid `seeder` token is therefore not sufficient on its own — its `sub`
also needs a row in `authz.user_role`, or `/decide` denies it exactly like
any other ungranted caller.

The bridge: this file **pins** the seeder service-account user's Keycloak
id (`users[0].id`, `00000000-0000-4000-8000-00005eed0001`) — Keycloak
stamps a user's own internal id verbatim into every token it issues for
that user, as the `sub` claim. `deploy/scripts/seed.sh` grants that exact
id a minimal, purpose-built role, `seeder-bootstrap`
(`config.pack.import` + `authz.role.grant` — precisely the two
permissions the brief names, not the far broader `hr-system-admin`
template), via a direct, idempotent SQL insert into
`authz.role`/`authz.role_permission`/`authz.user_role` — **not** a call
through svc-authz's own HTTP API, since the seeder cannot yet have a
grant to call the grant-guarded endpoint with. This is the one place the
brief explicitly permits reaching directly into a service's schema from
deploy tooling ("if it requires a seeded row in `authz.user_role`, say so
and add it").

`deploy/scripts/bootstrap-admin.sh` closes the loop for a real human: it
creates the first HR/System Admin in Keycloak, then uses a `seeder` token
(now holding `authz.role.grant`) to call svc-authz's
`POST /users/:id/roles` and grant that new admin `hr-system-admin` —
without which the admin could log in and be denied by every route, the
same trap the seeder itself would have fallen into without the SQL grant
above.

`SEEDER_SERVICE_ACCOUNT_ID` appears as an identical literal in three
places — this file's `users[0].id`, `seed.sh`, and `bootstrap-admin.sh` —
by necessity: it is the one value that has to be agreed on ahead of time,
before any of the three can talk to each other.
