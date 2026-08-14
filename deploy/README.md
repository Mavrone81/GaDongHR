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
| `traefik/traefik.yml` | Task 16f: Traefik's STATIC config — entrypoints 80/443, HTTP→HTTPS redirect, the `le` ACME resolver (TLS-ALPN-01), and the file provider pointed at `traefik/dynamic/`. Mounted read-only into the `traefik` service. |
| `traefik/dynamic/routes.yml` | Task 16f: Traefik's DYNAMIC config — every router/service/middleware, replacing the `traefik.*` Docker labels this repo used to carry. `Host()` rules read `PUBLIC_HOST` via Traefik's Go-template `env` function, never a literal domain. See "Traefik routing" below. |
| `postgres/init/01-roles.sql` | Runs once, automatically, on a fresh `postgres` volume. Creates the 12 business-schema roles + `keycloak`, each owning exactly one schema. |
| `vault/vault.hcl` | Vault server config (raft storage, no auto-unseal). **Read this file's header before doing anything else with Vault.** |
| `keycloak/realm-gadonghr.json` | Task 15b: the `gadonghr` realm import — clients `web` (public PWA) and `seeder` (confidential service account). Imported automatically by the `keycloak` service's `--import-realm` flag. See `keycloak/README.md`. |
| `keycloak/README.md` | Why redirect URIs are literal (not parameterised), how the `seeder` client's secret is provisioned without ever being committed, and how the seeder's identity reaches svc-authz as a grant. |
| `scripts/auto-deploy-gadonghr.sh` | Cron-driven pull-and-deploy. |
| `scripts/prune-gadonghr-images.sh` | Cron-driven image cleanup (keep 4 newest SHA tags per repo). |
| `scripts/seed.sh` | Statutory rule packs + role catalog + (Task 15b) pins the `seeder` client secret and grants it its svc-authz permissions. Run once after first `up -d`. |
| `scripts/bootstrap-admin.sh` | Task 15b: creates the first HR/System Admin (forced password change + OTP enrolment) and grants them `hr-system-admin` in svc-authz. Idempotent — run once, after `seed.sh`. |
| `scripts/backup.sh` | Nightly Postgres (+ row-count manifest) + Vault + MinIO backup, encrypted, 30 daily / 12 monthly. |
| `scripts/restore-verify.sh` | ops-hardening: the quarterly restore drill — restores a real backup archive into a throwaway, isolated environment and proves it. See "Backups, alerting, and log rotation (ops-hardening)" below. |
| `scripts/gadonghr-monitor.sh` | ops-hardening: periodic check (container health, Vault seal, disk, backup age) — the alerting this stack didn't have. |
| `scripts/gadonghr-alert.sh` | ops-hardening: the one shared notification path every alert goes through (local log always; one webhook env var, optional). |
| `scripts/install-ops-hardening.sh` | ops-hardening: idempotent one-shot installer — `age`, the systemd units below, log/state directories. Run once per host. |
| `systemd/gadonghr-{monitor,backup,backup-alert}.{service,timer}` | ops-hardening: the timers `install-ops-hardening.sh` installs. Template `__GADONG_DEPLOY_DIR__` is rendered to this checkout's real path at install time. |
| `.env.example` | Copy to `.env`, fill every `CHANGE_ME`. Never commit `.env`. |
| `compose-validation.test.ts` | The test suite for the two compose files AND the ops-hardening scripts/systemd units (`pnpm test` runs it — see below). |

## Install order (first deploy)

```bash
git clone https://github.com/Mavrone81/GaDongHR && cd GaDongHR/deploy
cp .env.example .env                 # fill every CHANGE_ME (openssl rand -base64 32)
docker compose -f docker-compose.yml -f docker-compose.prod.yml pull
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d postgres vault
# --- Vault key ceremony here (vault-init.sh, NOT part of this task — see "Out of scope" below) ---
# vault-init.sh writes the AppRole secret half to ./secrets/vault_approle_secret.
# Task 16b: Compose's file-sourced `secrets:` preserves the HOST file's own
# ownership inside the container verbatim (this engine does not honour the
# compose-spec's per-service secret `uid`/`gid`/`mode` outside Swarm — see
# docker-compose.yml's svc-crypto comment) — svc-crypto's container runs as
# `node` (uid 1000), so the file must be readable by uid 1000 and by NO ONE
# else (never `chmod 644`):
chown 1000:1000 ./secrets/vault_approle_secret && chmod 600 ./secrets/vault_approle_secret
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

`redis` is provisioned because the brief requires it as standing infra,
**not because any of the seven services currently use it** — sized small
and idle-ready for when a consumer lands, not tuned for load it doesn't
yet carry.

`rabbitmq` **is now live** (event-bus task, `.superpowers/sdd/02-modules/event-bus.md`):
`svc-config`, `svc-audit`, `svc-notify` and `svc-docs` all connect via
`RABBITMQ_URL` (`packages/kernel/src/bus/` — `AmqpPublisher` drains each
service's outbox, `ConsumerLoop` dispatches inbound events). Its 160 MB
sizing was already right for this — one durable topic exchange, one
dead-letter exchange, and a handful of small durable queues, not a
high-throughput broker. `svc-onboarding`, `svc-payroll`, `svc-timesheet`,
`svc-leave`, `svc-claims`, `svc-scheduler` and `svc-attendance` are wired
onto the bus the same way in code but are not yet in this compose file at
all — this file's own header already documents that as deliberate
("Module services M1-M7 must still NOT appear",
`deploy/compose-validation.test.ts`'s exact fifteen-service list). Their
memory lands with their own deployment phase, not this one.

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

## Traefik routing (Task 16f: file provider, not the Docker socket)

**Traefik's Docker provider can never work on this host.** Traefik's
bundled Docker client pins API version 1.24; the host daemon (Docker 29.6+)
requires >=1.40. Every attempt to reconcile that (`DOCKER_API_VERSION=1.44`
on the container, upgrading the image to v3.5.6, both together) hit the
same `client version 1.24 is too old` error — verified live, not assumed.
With the provider permanently failing, Traefik discovered zero containers
and had zero routers: every request 404'd, including the ACME challenge,
because there was no domain for any router to request a certificate for.

**The fix:** routing moved from `traefik.*` Docker labels to Traefik's
**file provider** — `traefik/traefik.yml` (static config: entrypoints,
HTTP→HTTPS redirect, the `le` ACME resolver, and the file provider itself)
plus `traefik/dynamic/routes.yml` (dynamic config: every router, backend,
and middleware, watched for changes with no restart needed). This is a
fixed set of 15 services on one host we already control — dynamic label
discovery bought nothing a static table doesn't already give, and it cost
`/var/run/docker.sock` on the `traefik` service: read access to the whole
Docker API (every other container's config, every mounted secret path) on
an edge-facing proxy, a real attack surface. That mount is gone; no
compose service carries a `traefik.*` label anymore (both are asserted by
`compose-validation.test.ts`'s `Traefik file-provider dynamic routing`
suite — no docker socket, no dead labels, no router that doesn't resolve
to a real compose service).

**`PUBLIC_HOST` stays environment-driven, but not the way `${PUBLIC_HOST}`
works elsewhere in this file.** Traefik's file provider does not perform
`docker compose`-style `${VAR}` substitution on the files it reads — that
is checked against the file-provider docs, not assumed. What it does
support is Go templating of dynamic-configuration files, including a
builtin `env` function, so `routes.yml`'s `Host()` rules read `{{ env
"PUBLIC_HOST" }}` — the committed file never contains the literal domain,
only the template. The actual value is supplied by
`docker-compose.yml`'s `traefik` service: `environment: PUBLIC_HOST:
${PUBLIC_HOST}` passes it into the container's own environment (from
`.env`, same as every other `PUBLIC_HOST` use in this file), and Traefik's
`env` function reads it there at dynamic-config load time. Change the
domain by editing `.env` — never `routes.yml`.

Traefik's **static** configuration does not work this way — Go templating
is dynamic-config only, and Traefik treats static config as single-source
(verified empirically: adding CLI flags or `TRAEFIK_*` env vars alongside
`--configFile` had zero effect on the resolved config, even for flags as
unrelated as `--api.insecure`). So the ACME resolver's contact email lives
as a plain committed value in `traefik.yml` itself, not `${ACME_EMAIL}` —
it is not secret (already a literal default in `.env.example`) and changes
rarely; changing it means editing that file.

Every one of the six externally-callable platform services carries a
router alongside `keycloak` (`kc`) and `web`; `svc-crypto` still does not
(it has no route any browser is meant to call directly — Vault HTTP client
only, called server-side by other services over the internal network).
Routers set an explicit `priority` in `routes.yml`, not left to Traefik's
default rule-length heuristic, because `compose-validation.test.ts` parses
that file directly (`docker compose config` never invokes Traefik's
routing engine, so there is no other way to assert the ordering that
keeps `/api/*` from being swallowed by the PWA).

| Router | Rule | Priority | Forwards to |
|---|---|---:|---|
| `web` | `Host(\`{{ env "PUBLIC_HOST" }}\`)` | 1 | `web:8080` (catch-all — must lose every match it shares with a router below) |
| `kc` | `Host(\`{{ env "PUBLIC_HOST" }}\`) && PathPrefix(\`/auth\`)` | *(default)* | `keycloak:8080` |
| `svc-config` | `Host(\`{{ env "PUBLIC_HOST" }}\`) && PathPrefix(\`/api/config\`)` | 100 | `svc-config:3000` (prefix stripped) |
| `svc-authz` | `Host(\`{{ env "PUBLIC_HOST" }}\`) && PathPrefix(\`/api/authz\`)` | 100 | `svc-authz:3000` (prefix stripped) |
| `svc-audit` | `Host(\`{{ env "PUBLIC_HOST" }}\`) && PathPrefix(\`/api/audit\`)` | 100 | `svc-audit:3000` (prefix stripped) |
| `svc-i18n` | `Host(\`{{ env "PUBLIC_HOST" }}\`) && PathPrefix(\`/api/i18n\`)` | 100 | `svc-i18n:3000` (prefix stripped) |
| `svc-notify` | `Host(\`{{ env "PUBLIC_HOST" }}\`) && PathPrefix(\`/api/notify\`)` | 100 | `svc-notify:3000` (prefix stripped) |
| `svc-docs` | `Host(\`{{ env "PUBLIC_HOST" }}\`) && PathPrefix(\`/api/docs\`)` | 100 | `svc-docs:3000` (prefix stripped) |

Every `/api/*` router carries a `stripPrefix` middleware (e.g.
`svc-config-strip` → `prefixes: ["/api/config"]`) because each service's
own NestJS routes are unprefixed — `rules.controller.ts` exposes `GET
/rules`, not `GET /api/config/rules` — so the browser's same-origin call
to `/api/config/rules` needs the `/api/config` segment removed before
Traefik forwards it. `kc` needs no such middleware: Keycloak's own
`--http-relative-path=/auth` already expects requests to arrive with
`/auth` still attached.

**ACME challenge: TLS-ALPN-01**, not HTTP-01 (`traefik.yml`'s own comment
has the full rationale). Summary: it is answered entirely at the TLS
handshake on the same `:443` entrypoint Traefik already owns, so it never
depends on any HTTP router — including `web`'s catch-all — getting out of
the way of `/.well-known/acme-challenge/*` first. It was also this
deployment's resolver mode before the Docker-provider regression, so
keeping it is the smallest change that fixes the actual defect. Trade-off:
it requires the ACME CA to reach `:443` directly with no TLS-terminating
proxy/CDN in front of Traefik — already true of this host's architecture.

`https://<PUBLIC_HOST>/` now reaches `web`'s `index.html` (previously
Traefik's own 404 — there was no `web` router at all before Task 15c).
`web/nginx.conf`'s `try_files $uri $uri/ /index.html` is what makes a
direct load or hard refresh of a client-routed deep link (e.g.
`/admin/statutory-rules`) return the SPA shell instead of a 404 — the
Traefik router above only has to get out of the way of that path (by
sitting at the lowest priority), not implement the fallback itself.

**Closed by Task 15d: the published `gadonghr-web:main` image now bakes in
its runtime configuration at build time.** `web`'s `VITE_OIDC_ISSUER`,
`VITE_OIDC_CLIENT_ID`, `VITE_OIDC_REDIRECT_URI`, `VITE_OIDC_AUDIENCE`,
`VITE_SVC_CONFIG_URL`, and `VITE_SVC_I18N_URL` are read via
`import.meta.env` and baked in at `vite build` time (`web/src/env.ts`), not
at container start. Before this task, CI's `build-images` matrix
(`.github/workflows/ci.yml`) passed only `GADONG_BUILD_SHA` as a build-arg
to `web/Dockerfile`, none of the six `VITE_*` vars. Pulling and inspecting
the actual published image confirmed this empirically: its bundled JS
contained no `localhost` string at all (so it did not merely point at the
wrong host, as `web/.env.local.example`'s dev defaults might suggest) —
every `VITE_*` var was genuinely undefined in the built bundle, so
`env.ts`'s `required()` threw `missing required env var VITE_OIDC_ISSUER`
(the first one read, from `svcI18n.ts`'s top-level `loadConfig()` call)
during module evaluation, before React ever mounted. The image loaded a
blank page and threw immediately — not a misconfigured backend call, a hard
crash before any UI renders.

**The fix:** `.github/workflows/ci.yml`'s `build-images` matrix now carries
an optional `buildArgs` key on the `web` entry only (every `services/*` leg
is unaffected), and `web/Dockerfile`'s build stage now declares a matching
`ARG` for each of the six — an `ARG` with no matching `--build-arg` is
silently empty, and a `--build-arg` with no matching `ARG` is silently
discarded by Docker; both directions were checked, not assumed. The six
values, using same-origin relative paths for the two service URLs so the
browser always talks to Traefik on whatever host it loaded from, never a
hardcoded dev host:

```
VITE_OIDC_ISSUER=https://hr.bevorasg.com/auth/realms/gadonghr
VITE_OIDC_CLIENT_ID=web
VITE_OIDC_REDIRECT_URI=https://hr.bevorasg.com/auth/callback
VITE_OIDC_AUDIENCE=gadonghr-services
VITE_SVC_CONFIG_URL=/api/config
VITE_SVC_I18N_URL=/api/i18n
```

Cross-checked against `deploy/keycloak/realm-gadonghr.json`: realm
`"gadonghr"` matches the issuer path, the public client's `"clientId":
"web"` matches `VITE_OIDC_CLIENT_ID`, the `gadonghr-services-audience`
protocol mapper's `"included.custom.audience": "gadonghr-services"` matches
`VITE_OIDC_AUDIENCE`, and the client's `"redirectUris":
["https://hr.bevorasg.com/*"]` matches `VITE_OIDC_REDIRECT_URI`. All match
— no mismatch found. `hr.bevorasg.com` itself matches `PUBLIC_HOST` in
`.env.example`, not an independently-chosen value.

**Real limitation, not an oversight: the hostname above is hardcoded into
the built JS bundle.** A Vite SPA has no server process to read config from
at request time — `import.meta.env.VITE_*` is a compile-time constant
inlined by Rollup, not a runtime lookup — so changing the deployment domain
(a new `PUBLIC_HOST`) requires rebuilding and republishing the `web` image,
not just editing `.env` and restarting containers the way every other
service on this host works. The alternative — a small runtime-config JSON
(e.g. `/config.json`) fetched by `index.html` before the app boots, so the
same built image works behind any hostname — is a deliberate future option
for whenever that flexibility is actually needed, not something this task
skipped by mistake.

## Backups, alerting, and log rotation (ops-hardening)

A readiness audit found four operational gaps: Vault's healthcheck lied
about seal status, there was no alerting on anything, container logs were
unbounded, and backups were unscheduled with a restore path that had never
been exercised. Closed as follows — none of this needed a product-code
change, all of it is `deploy/` + the server.

### Vault healthcheck: sealed is now visible, crashed is now caught

The old healthcheck was `vault status ... || true` — ALWAYS exit 0, so a
SEALED vault (every S2/S3 op 503ing, expected after every reboot) and a
genuinely CRASHED vault reported the exact same Docker health status.
Fixed in `docker-compose.yml`: exit 2 (sealed) still counts as
Docker-healthy (so `depends_on: condition: service_healthy` never blocks
forever waiting for a sealed-after-reboot vault — that would have been a
regression), but any OTHER exit code now fails the healthcheck for real.
Sealed is made VISIBLE via the healthcheck's own stdout (`docker
inspect --format '{{json .State.Health}}'` shows it in `Log[].Output`
even while the container stays "healthy"), and `gadonghr-monitor.sh`
(below) actively execs `vault status` itself every run and pages on
`sealed=true` independent of Docker's health status — the mechanism that
actually notifies a human, since Docker's own health state alone doesn't.

### Alerting: `gadonghr-monitor.sh` + `gadonghr-alert.sh`

`gadonghr-monitor.sh` runs on a 5-minute systemd timer and checks exactly
the four things the audit named: container health (unhealthy/crash-
looping), Vault seal status, disk usage, and the age of the newest local
backup archive. Every failure is dispatched through `gadonghr-alert.sh`,
which:
- **Always** appends a timestamped line to a local log
  (`GADONG_ALERT_LOG`, default `/var/log/gadonghr-alerts.log`) — the
  alert history exists even with no channel configured.
- Optionally POSTs the same message to **one env var**,
  `GADONG_ALERT_WEBHOOK_URL` — works as-is with an ntfy.sh topic URL, or
  any webhook that accepts a POST body (set `GADONG_ALERT_WEBHOOK_JSON=true`
  for a Slack-style `{"text": ...}` body). Unset is not an error.

Repeat alerts for an ongoing failure are debounced (state under
`GADONG_MONITOR_STATE_DIR`, default `/var/lib/gadonghr-monitor`) — a
transition to failing always alerts immediately; a persistent failure
re-alerts every `GADONG_MONITOR_REALERT_MINUTES` (default 60), not every
5-minute run. Recovery always logs locally and clears the state.

### Log rotation: one anchor, not sixteen copy-pastes

No service had a `logging:` block — docker's json-file driver is
unbounded, and the disk is a fixed 80 GB. Fixed with a `logging:` entry
added to the single `x-node-defaults` anchor every service already merges
via `<<: *node-defaults` (`docker-compose.yml`) — `max-size: 10m`,
`max-file: 3` per container, applied everywhere in one place.
**Changing a container's logging config requires recreating it** — on the
server, every container except `vault` was recreated (`docker compose up
-d --force-recreate <service>`, one at a time); `vault` was deliberately
left running its old container rather than force-recreated, because that
would reseal it and require a live 3-of-5 key-officer unseal ceremony —
out of scope for an unattended hardening pass. `vault` picks up the new
logging config the next time it restarts for any other reason (reboot,
image update); until then it still uses docker's unbounded default. Track
this — it isn't automatically resolved by anything in this repo.

### Backups: scheduled, and restore is now actually exercised

`scripts/backup.sh` (Postgres `pg_dump -Fc` + a new row-count
`manifest.json` + Vault raft snapshot + MinIO mirror, `age`-encrypted,
30 daily / 12 monthly) is now on a systemd timer
(`systemd/gadonghr-backup.timer`, nightly 02:30 UTC ±5min jitter,
`Persistent=true` so a missed run during downtime still catches up).
`systemd/gadonghr-backup.service` sets `OnFailure=gadonghr-backup-alert.service`,
which calls `gadonghr-alert.sh` — a failed backup pages through the same
path as everything else, not a log file nobody reads.

`scripts/restore-verify.sh` is the quarterly restore drill Runbook §3
required and this repo never had:

```bash
scripts/restore-verify.sh /opt/gadonghr/backups/daily/gadonghr-backup-<stamp>.tar.age \
  --age-key-file /path/to/offline-backup-key.txt \
  [--vault-unseal-key <share>]...   # only if the archive has a real vault.snap
```

It decrypts the archive, then, entirely in **throwaway, uniquely-prefixed
docker resources it creates and tears down itself** (never the `gadonghr`
compose project, never the real volume names):
- Restores `postgres.dump` into a throwaway Postgres container and diffs
  every table's row count against `manifest.json`.
- Runs a self-contained synthetic Vault stage → snapshot → restore →
  unseal drill (its own freshly-generated "staging key") to prove the
  restore+unseal MECHANISM end to end — and, if the archive's own real
  `vault.snap` is present and `--vault-unseal-key` share(s) were supplied,
  also attempts a real restore of that.
- Lists the archive's mirrored MinIO objects.

Every docker resource name it creates is asserted (`assert_isolated_name`)
to carry that run's unique prefix before any docker command touches it —
this is a structural guard, not just care: a name that isn't this run's
own is refused outright, and the script never invokes `docker compose -p
gadonghr` at all.

**Install once per host** (idempotent, safe to re-run after `git pull`):

```bash
./scripts/install-ops-hardening.sh   # as root: installs `age`, renders + enables both systemd timers
```

**Known, real gap surfaced by this work, not yet closed**: on
gadonghr-prod, `VAULT_TOKEN` was never provisioned (that's part of the
`vault-init.sh` ceremony, out of scope here — same boundary
`backup.sh`'s own header already documented). Every backup taken so far
has therefore SKIPPED the Vault snapshot and `backup.sh` correctly exits
non-zero over it — which is exactly the kind of failure the new alerting
now surfaces instead of hiding. Provisioning that token is follow-up work
for whoever owns the next Vault ceremony.

## Validation

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml config   # must parse cleanly
pnpm test -- deploy                                                       # compose-validation.test.ts + scripts-validation.test.ts
for f in scripts/*.sh; do bash -n "$f"; done
```
