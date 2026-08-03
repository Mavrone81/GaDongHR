# GaDongHR — deploy

Everything needed to run GaDongHR on `gadonghr-prod` (`157.230.38.96`, sgp1,
**dedicated** 2 vCPU / 4 GB / 80 GB, Ubuntu 24.04, Docker 29.7.1, 4 GB swap,
`live-restore: true`, firewall 22/80/443 only). Because the host is
dedicated, Traefik owns `:80`/`:443` and terminates TLS itself with Let's
Encrypt — there is **no host nginx and no loopback-port overlay**. An
earlier plan targeted a *shared* droplet (`165`) and needed exactly that
workaround; it does not apply here. (A repo-wide search for `165` /
`21000` / `loopback` found no leftover loopback-port config anywhere — the
only `165` references are `docs/superpowers/plans/00-PROGRAM-ROADMAP.md`
and `01-foundation-platform.md`, both legitimately documenting the DNS
cutover *from* the old droplet's IP, not a stale workaround.)

## Files

| File | What |
|---|---|
| `docker-compose.yml` | Base stack. All 15 containers (7 platform services + `web` + traefik/postgres/rabbitmq/redis/minio/vault/keycloak), each with a `build:` (local/dev/CI use). |
| `docker-compose.prod.yml` | Production overlay: replaces every service's `build:` with a pinned `ghcr.io/mavrone81/gadonghr-<service>:<sha>` image and `pull_policy: always`. Never used alone — always `-f docker-compose.yml -f docker-compose.prod.yml`. |
| `postgres/init/01-roles.sql` | Runs once, automatically, on a fresh `postgres` volume. Creates the 12 business-schema roles + `keycloak`, each owning exactly one schema. |
| `vault/vault.hcl` | Vault server config (raft storage, no auto-unseal). **Read this file's header before doing anything else with Vault.** |
| `keycloak/realm-gadonghr.json` | Task 15b: the `gadonghr` realm import — clients `web` (public PWA) and `seeder` (confidential service account). Imported automatically by the `keycloak` service's `--import-realm` flag. See `keycloak/README.md`. |
| `keycloak/README.md` | Why redirect URIs are literal (not parameterised), how the `seeder` client's secret is provisioned without ever being committed, and how the seeder's identity reaches svc-authz as a grant. |
| `scripts/auto-deploy-gadonghr.sh` | Cron-driven pull-and-deploy. |
| `scripts/prune-gadonghr-images.sh` | Cron-driven image cleanup (keep 4 newest SHA tags per repo). |
| `scripts/seed.sh` | Statutory rule packs + role catalog + (Task 15b) pins the `seeder` client secret and grants it its svc-authz permissions. Run once after first `up -d`. |
| `scripts/bootstrap-admin.sh` | Task 15b: creates the first HR/System Admin (forced password change + OTP enrolment) and grants them `hr-system-admin` in svc-authz. Idempotent — run once, after `seed.sh`. |
| `scripts/backup.sh` | Nightly Postgres + Vault + MinIO backup, encrypted, 30 daily / 12 monthly. |
| `.env.example` | Copy to `.env`, fill every `CHANGE_ME`. Never commit `.env`. |
| `compose-validation.test.ts` | The test suite for the two compose files (`pnpm test` runs it — see below). |

## Install order (first deploy)

```bash
git clone https://github.com/Mavrone81/GaDongHR && cd GaDongHR/deploy
cp .env.example .env                 # fill every CHANGE_ME (openssl rand -base64 32)
docker compose -f docker-compose.yml -f docker-compose.prod.yml pull
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d postgres vault
# --- Vault key ceremony here (vault-init.sh, NOT part of this task — see "Out of scope" below) ---
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
./scripts/seed.sh
./scripts/bootstrap-admin.sh
```

**What breaks if a step is skipped:**

- **Skip `.env` entirely / leave `CHANGE_ME` in place**: every role/service
  password is the literal string `CHANGE_ME` — `01-roles.sql` still runs
  (it doesn't validate password strength), so the stack comes up but with
  a trivially guessable password on every database role and Keycloak
  admin account. `docker compose config` will not catch this; only a
  human reviewing `.env` before `up -d` does.
- **Skip the Vault ceremony, go straight to `up -d`**: `svc-crypto` starts
  but Vault has no unseal keys generated yet, or (after a later reboot) is
  sealed — every S2/S3 field operation returns `503 CRY-503` (fail
  closed, no plaintext fallback). `/health` reports `degraded`, not down —
  correct behaviour, see `vault/vault.hcl`'s header — but nothing that
  touches encrypted data works until 3 key officers unseal it.
- **Skip `seed.sh`**: `svc-authz`'s role/permission catalog seeds itself
  automatically on every boot regardless (see `scripts/seed.sh`'s header
  comment — this is not something `seed.sh` needs to trigger). What is
  actually skipped is svc-config's statutory rule packs
  (`TH-STATUTORY-v1`, `TH-HOLIDAYS-2026`) — `GET /rules/:key` returns
  nothing for any rule key until they're imported, so any calculation
  that resolves a statutory value through `svc-config` (the roadmap's
  "statutory values are data, never code" contract) has nothing to
  resolve.
- **Skip `postgres/init/01-roles.sql` (i.e. reuse an existing `pg_data`
  volume from before this task)**: it never re-runs on a non-empty
  volume (Postgres's own `docker-entrypoint-initdb.d` contract) — the
  twelve roles simply won't exist, and every service's `DATABASE_URL`
  connection will fail at boot. There is no idempotent "add the missing
  roles" path here by design (re-running a role-creation script against
  live production data is exactly the kind of action that should require
  a human to write and review it for that specific situation, not a
  cron-safe default).

## Closed by Task 15b: `seed.sh`'s pack import now has a realm to authenticate against

Task 13c's `OidcMiddleware` (`packages/kernel/src/authz/oidc.middleware.ts`)
has validated bearer tokens since it shipped — the gap was that **nothing
issued them**: Keycloak ran with no realm, no clients, no users.
`deploy/keycloak/realm-gadonghr.json` (Task 15b) closes that: `POST
/packs/import` (guarded by `config.pack.import`) now succeeds, because
`seed.sh` obtains a real client-credentials token from the `seeder`
service account and that account has a real grant in svc-authz — see
`deploy/keycloak/README.md` for the full identity/authorisation split.

## Out of scope for this task

The Runbook (`docs/07-operations/OPERATIONS-RUNBOOK.md` §1–2) also
references `scripts/vault-init.sh` (the unseal-share ceremony),
`scripts/rotate-approle.sh`, `scripts/rotate-keks.sh`, and
`scripts/verify-restore.sh`. Those four do not exist yet and are not
silently assumed to — restore-drill instructions above stop where they'd
need one of them. (`scripts/bootstrap-admin.sh` is no longer in this list —
Task 15b delivered it.)

## Memory budget — the binding constraint

4 GB total RAM. `mem_limit` is set explicitly on every one of the 15
containers (`compose-validation.test.ts` asserts this, plus that the sum
leaves >= 512 MB for the OS — brief §1/§5). Actual committed total below
leaves considerably more than the 512 MB floor, deliberately: 4 GB is
razor-thin even before Phase 3, and OOM-killing Postgres on a host with
`live-restore: true` is exactly the failure the brief calls out to avoid.

| Container | `mem_limit` | Why this size |
|---|---:|---|
| `keycloak` | 768 MB | Explicitly called out in the brief as one of "the two large ones" — JVM baseline + realm data. |
| `postgres` | 512 MB | The other explicitly-called-out large one — 14 schemas, `shared_buffers` etc. |
| `svc-docs` | 512 MB | Heaviest of the seven Node services: spawns headless Chromium per PDF render (`ChromiumPdfRenderer`) on top of Node/Nest's own baseline — Chromium alone routinely wants 300–400+ MB. |
| `vault` | 224 MB | Raft storage + transit engine; modest but not trivial. |
| `minio` | 192 MB | Object storage server, handles PDF/document uploads for `svc-docs`. |
| `svc-config` | 192 MB | Node/Nest + Postgres pool + statutory-rule read paths. |
| `svc-authz` | 192 MB | Node/Nest + Postgres pool; every other service's `/decide` caller. |
| `rabbitmq` | 160 MB | Management plugin loaded; provisioned ahead of use (see below). |
| `svc-notify` | 160 MB | Node/Nest + Postgres pool + SMTP client. |
| `traefik` | 96 MB | Edge proxy only, no app logic. |
| `svc-crypto` | 96 MB | Node/Nest, no DB — Vault HTTP client only. |
| `svc-audit` | 96 MB | Node/Nest + Postgres pool, append-only, low traffic. |
| `svc-i18n` | 96 MB | Node/Nest, no DB — bundles held in memory but small (th/en/zh JSON). |
| `redis` | 80 MB | `--maxmemory 64mb` caps Redis's own working set below this ceiling; provisioned ahead of use (see below). |
| `web` | 64 MB | Task 15c: unprivileged nginx serving a static Vite bundle — no Node runtime, no DB pool, no in-memory cache. 64 MB is generous headroom over nginx's actual working set for this. |
| **Total committed** | **3,440 MB** | 3,376 MB (Task 13) + 64 MB (`web`, Task 15c). |
| **OS headroom** | **4,096 − 3,440 = 656 MB** | Still comfortably above the 512 MB floor. |

`rabbitmq` and `redis` are provisioned because the brief requires them as
standing infra, **not because any of the seven services currently use
either**: a repo-wide check found no AMQP/RabbitMQ or Redis client
anywhere in `packages/kernel` or `services/*/src` — the outbox relay's
live broker adapter doesn't exist yet (`services/svc-audit`'s own source
comment: "driven by a future message-bus adapter — none exists anywhere
in this repo yet"). They're sized small and idle-ready for when that
lands, not tuned for load they don't yet carry.

### Before CompreFace arrives (Phase 3)

CompreFace needs 2–3 GB by itself (roadmap's own "Open items" table).
**This does not fit.** 3,440 MB already committed + a 2,000–3,000 MB
CompreFace footprint is 5,440–6,440 MB against a 4,096 MB host — there is
no trimming of the current 15 containers that closes a gap that size
without cutting into Postgres or Keycloak, which is precisely what this
budget exists to avoid. Two real options, to be decided before Phase 3
starts (already flagged as an open item in
`docs/superpowers/plans/00-PROGRAM-ROADMAP.md`):

1. **Resize `gadonghr-prod`** to at least 8 GB RAM before deploying
   CompreFace — the straightforward fix, a DigitalOcean droplet resize
   (brief downtime, no architecture change).
2. **Move CompreFace to a second, dedicated host** and have
   `svc-attendance` call it over the network — avoids touching this
   droplet's budget at all, at the cost of a second machine to operate.

Either way: do not attempt to squeeze CompreFace into headroom trimmed
from Postgres, Keycloak, or `svc-docs` — those three are sized against
real, measured-shape workloads (a full relational schema set, a JVM
identity provider, and headless Chromium), not padding.

## `packages/kernel/src/db/pool.ts` ↔ `01-roles.sql` reconciliation

`pool.ts` claims (comments, unchanged by this task): `MAX_POOL_SIZE = 10`,
and "`01-roles.sql` grants each service's DB role a 20-connection limit;
10 per pool leaves headroom for the relay ... and any short-lived
migration/admin connections." `01-roles.sql` did not exist when that
comment was written (Task 4 review). It exists now, and the claim holds,
by construction:

```
MAX_POOL_SIZE (10)        — pool.ts: this service's own connection pool
+ 1                       — pool.ts: OutboxRelay's dedicated withConnection session
+ up to 9                 — headroom: a migration connection at boot + a human psql session
= 20                      — CONNECTION LIMIT set on every one of the 12 business roles + audit
```

`20 > MAX_POOL_SIZE (10)` holds. `01-roles.sql` also sets
`statement_timeout = '30s'` on every role, matching `pool.ts`'s
`STATEMENT_TIMEOUT_MS = 30_000` — belt (role-level) and suspenders
(pool-level client option), as `pool.ts`'s own comment describes.
`keycloak`'s role is sized independently (`CONNECTION LIMIT 15`) since
it's a Java/Quarkus process, not a `@gadong/kernel` consumer — `pool.ts`'s
constants don't apply to it and this is noted explicitly in
`01-roles.sql` rather than left to look like an oversight.

**One residual gap, not silently closed**: `svc-audit`'s migration
(`1754100000000_audit-schema.js`) creates its own tables and then issues
`REVOKE ALL ... FROM audit; GRANT SELECT, INSERT ... TO audit;` — running
as the `audit` role itself, because `main.ts` reuses the single
`DATABASE_URL` env var for both the migration step and the runtime pool
(no second, more-privileged connection string is available to the
container). Verified empirically against a real `postgres:16` container
(not assumed): after that `REVOKE`/`GRANT` sequence, `audit` genuinely
cannot `UPDATE`/`DELETE` a row — Postgres treats an owner's initial "all
privileges" grant as a revocable ACL entry, and revoking it is
enforced — but `audit` still owns the table, so it retains
owner-inherent `DROP`/`ALTER` rights that no `REVOKE` can touch. Closing
that fully needs a second, non-login "owner" role and splitting
`svc-audit`'s single `DATABASE_URL` into a migration credential and a
runtime credential — a change to `services/svc-audit/src/main.ts`, out of
scope here ("No service code"). The primary defence against the invariant
this exists to protect (append-only) is already code-level —
`EntriesRepository` exposes no `updateEntry`/`deleteEntry` method at
all — and the DB grant is the documented belt-and-suspenders on top of
it, not the sole defence. See the long comment on `audit`'s block in
`postgres/init/01-roles.sql` for the full detail.

## Traefik routing (Task 15c: `web` wired in)

Every one of the six externally-callable platform services now carries a
router alongside `keycloak`; `svc-crypto` still does not (it has no route
any browser is meant to call directly — Vault HTTP client only, called
server-side by other services over the internal network). Routers are
ordered by explicit `priority` label, not left to Traefik's default
rule-length heuristic, because `compose-validation.test.ts` inspects the
label values directly (`docker compose config` never invokes Traefik's
routing engine, so there is no other way to assert the ordering that
keeps `/api/*` from being swallowed by the PWA).

| Router | Rule | Priority | Forwards to |
|---|---|---:|---|
| `web` | `Host(\`${PUBLIC_HOST}\`)` | 1 | `web:8080` (catch-all — must lose every match it shares with a router below) |
| `kc` | `Host(\`${PUBLIC_HOST}\`) && PathPrefix(\`/auth\`)` | *(default)* | `keycloak:8080` |
| `svc-config` | `Host(\`${PUBLIC_HOST}\`) && PathPrefix(\`/api/config\`)` | 100 | `svc-config:3000` (prefix stripped) |
| `svc-authz` | `Host(\`${PUBLIC_HOST}\`) && PathPrefix(\`/api/authz\`)` | 100 | `svc-authz:3000` (prefix stripped) |
| `svc-audit` | `Host(\`${PUBLIC_HOST}\`) && PathPrefix(\`/api/audit\`)` | 100 | `svc-audit:3000` (prefix stripped) |
| `svc-i18n` | `Host(\`${PUBLIC_HOST}\`) && PathPrefix(\`/api/i18n\`)` | 100 | `svc-i18n:3000` (prefix stripped) |
| `svc-notify` | `Host(\`${PUBLIC_HOST}\`) && PathPrefix(\`/api/notify\`)` | 100 | `svc-notify:3000` (prefix stripped) |
| `svc-docs` | `Host(\`${PUBLIC_HOST}\`) && PathPrefix(\`/api/docs\`)` | 100 | `svc-docs:3000` (prefix stripped) |

Every `/api/*` router carries a `stripprefix` middleware (e.g.
`traefik.http.middlewares.svc-config-strip.stripprefix.prefixes=/api/config`)
because each service's own NestJS routes are unprefixed — `rules.controller.ts`
exposes `GET /rules`, not `GET /api/config/rules` — so the browser's
same-origin call to `/api/config/rules` needs the `/api/config` segment
removed before Traefik forwards it. `kc` needs no such middleware:
Keycloak's own `--http-relative-path=/auth` already expects requests to
arrive with `/auth` still attached.

`https://<PUBLIC_HOST>/` now reaches `web`'s `index.html` (previously
Traefik's own 404 — there was no `web` router at all before this task).
`web/nginx.conf`'s `try_files $uri $uri/ /index.html` is what makes a
direct load or hard refresh of a client-routed deep link (e.g.
`/admin/statutory-rules`) return the SPA shell instead of a 404 — the
Traefik router above only has to get out of the way of that path (by
sitting at the lowest priority), not implement the fallback itself.

**The published `gadonghr-web:main` image cannot serve real users as
pushed today.** `web`'s `VITE_OIDC_ISSUER`, `VITE_OIDC_CLIENT_ID`,
`VITE_OIDC_REDIRECT_URI`, `VITE_OIDC_AUDIENCE`, `VITE_SVC_CONFIG_URL`, and
`VITE_SVC_I18N_URL` are read via `import.meta.env` and baked in at `vite
build` time (`web/src/env.ts`), not at container start — and CI's
`build-images` matrix (`.github/workflows/ci.yml`) passes only
`GADONG_BUILD_SHA` as a build-arg to `web/Dockerfile`, none of the six
`VITE_*` vars. Pulling and inspecting the actual published image confirms
this empirically: its bundled JS contains no `localhost` string at all
(so it does not merely point at the wrong host, as `web/.env.local.example`'s
dev defaults might suggest) — every `VITE_*` var is genuinely undefined in
the built bundle, so `env.ts`'s `required()` throws `missing required env
var VITE_OIDC_ISSUER` (the first one read, from `svcI18n.ts`'s top-level
`loadConfig()` call) during module evaluation, before React ever mounts.
The image loads a blank page and throws immediately — not a
misconfigured backend call, a hard crash before any UI renders.

**CI must pass six additional `--build-arg`s to `web/Dockerfile`** (a
change to `.github/workflows/ci.yml`, out of scope for this task — this
task owns `deploy/` only), using same-origin relative paths for the two
service URLs so the browser always talks to Traefik on whatever host it
loaded from, never a hardcoded dev host:

```
VITE_OIDC_ISSUER=https://${PUBLIC_HOST}/auth/realms/gadonghr
VITE_OIDC_CLIENT_ID=web
VITE_OIDC_REDIRECT_URI=https://${PUBLIC_HOST}/auth/callback
VITE_OIDC_AUDIENCE=gadonghr-services
VITE_SVC_CONFIG_URL=/api/config
VITE_SVC_I18N_URL=/api/i18n
```

Until CI is updated to pass these and a fresh image is published, `web`
should still be deployed (it is a strict improvement — Traefik answering
`/` with a crashing SPA shell is diagnosable in a way a bare 404 is not),
but the owner will see a blank page / console error, not a working login
screen.

## Validation

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml config   # must parse cleanly
pnpm test -- deploy                                                       # compose-validation.test.ts
for f in scripts/*.sh; do bash -n "$f"; done
```
