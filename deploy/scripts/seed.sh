#!/usr/bin/env bash
#
# seed.sh — svc-config's statutory rule packs + svc-authz's role/permission
# catalog + (Task 15b) the Keycloak `seeder` service account's own
# authorisation. Run once after the FIRST `docker compose ... up -d`
# (Runbook §1 install order), and safe to re-run any time: every half is
# idempotent.
#
# ---------------------------------------------------------------------------
# svc-authz needs NOTHING from this script.
#
# Read directly from `services/svc-authz/src/main.ts`: `bootstrap()` calls
# `runSeed()` — which runs `seedRoleTemplates` inside a transaction — on
# EVERY container boot, before it starts listening. `seed/roles.test.ts`
# proves it is idempotent by content hash. By the time `docker compose ps`
# shows svc-authz healthy, its permission catalog and all ten role
# templates are already seeded. This script only waits for and confirms
# that, it does not trigger it a second time.
# ---------------------------------------------------------------------------
# Task 15b — the identity/authorisation split, and how the seeder's token
# gets past `PermissionGuard` at all:
#
# Keycloak (deploy/keycloak/realm-gadonghr.json) authenticates the
# `seeder` client and issues it tokens; it does NOT know anything about
# GaDongHR's permission catalog — `svc-authz` owns that, entirely
# separately (this task's brief: "Keycloak owns identities; svc-authz
# owns grants. Do not duplicate the permission model into Keycloak
# roles."). A valid `seeder` token alone is therefore not enough — the
# TOKEN'S `sub` also needs a row in `authz.user_role`, or `/decide`
# denies it exactly like anyone else with no grant.
#
# The bridge between the two: `deploy/keycloak/realm-gadonghr.json` PINS
# the seeder service-account user's Keycloak id (Keycloak stamps a user's
# own internal id verbatim into every token it issues for that user as the
# `sub` claim) to the constant below, and this script grants THAT EXACT id
# a minimal, purpose-built role — `seeder-bootstrap`, holding exactly the
# two permissions this task's brief names (`config.pack.import`, used
# below; `authz.role.grant`, used by `bootstrap-admin.sh` to grant the
# first HR/System Admin their real role) — NOT the much broader
# `hr-system-admin` template, which the seeder has no business holding.
# `SEEDER_SERVICE_ACCOUNT_ID` here MUST stay byte-identical to
# `users[0].id` in `deploy/keycloak/realm-gadonghr.json`; a mismatch means
# the seeder authenticates fine and is denied every grant-guarded route
# forever, with no error anywhere pointing at why.
#
# The client SECRET Keycloak needs to issue that token in the first place
# is a second problem realm-import JSON cannot solve on its own: baking a
# real secret into `realm-gadonghr.json` would put a live credential in
# git, and Keycloak's own `${env.VAR}`-style substitution inside imported
# realm JSON is known unreliable/regressed across the 22-26.x line (see
# `deploy/keycloak/README.md`). So `realm-gadonghr.json` deliberately
# leaves the `seeder` client's `secret` field absent — Keycloak
# auto-generates a throwaway one at import time that nothing ever reads —
# and THIS script pins it, on every run, to `KEYCLOAK_SEEDER_CLIENT_SECRET`
# (read from the environment, never embedded in this file) via an
# idempotent Admin REST `PUT`, authenticating as the realm bootstrap admin
# (`KC_ADMIN_USER`/`KC_ADMIN_PASSWORD`, already provisioned by
# `docker-compose.yml`'s `KC_BOOTSTRAP_ADMIN_USERNAME`/`_PASSWORD`).
# ---------------------------------------------------------------------------
# svc-config's statutory packs are NOT auto-seeded — `PacksService.
# importPack` is reachable only via `POST /packs/import`
# (rules.controller.ts), which this script calls, now with a real bearer
# token, for every `services/svc-config/seed/*.json` file shipped inside
# the svc-config image (`Dockerfile` COPYs `seed/` next to `dist/`).
# `PackImportResult` is `{status: 'imported' | 'duplicate', ...}` —
# re-POSTing an already-imported pack is a documented no-op, which is what
# makes this half idempotent too.
#
# SIGNING: `services/svc-config/seed/*.json` files carry NO `signature`
# field — they are `{pack_id, version, records[]}` only. A signature baked
# in at authoring time can only ever verify under the one
# `CONFIG_PACK_SIGNING_KEY` that produced it, and every deployment
# generates its own independently (`deploy/.env`'s
# `CONFIG_PACK_SIGNING_KEY=CHANGE_ME`), so a committed signature would be
# valid nowhere but its author's machine — this was a real production bug
# (`CFG-401 config.error.pack_signature_invalid` on every real import;
# `config.statutory_rule` stuck at 0 rows). The block below signs each
# pack for THIS environment's own key — already present in svc-config's
# container environment (`docker-compose.yml`'s `CONFIG_PACK_SIGNING_KEY:
# ${CONFIG_PACK_SIGNING_KEY}`, the same value the running service verifies
# against) — immediately before POSTing it, via
# `services/svc-config/src/scripts/sign-pack.ts` (compiled to
# `dist/scripts/sign-pack.js` in the image). It imports
# `computePackSignature` from `packs.service.ts` rather than
# reimplementing the HMAC/canonicalisation, so signing and verifying can
# never drift apart. Re-signing is cheap and deterministic and does not
# affect idempotency — the pack content (and therefore the
# `(pack_id, version)` idempotency key) is unchanged run to run; only the
# signature value is (re)computed.

set -euo pipefail

PROJECT="gadonghr"
DEPLOY_DIR="${GADONG_DEPLOY_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
COMPOSE_FILES=(-f "$DEPLOY_DIR/docker-compose.yml")
[ -f "$DEPLOY_DIR/docker-compose.prod.yml" ] && COMPOSE_FILES+=(-f "$DEPLOY_DIR/docker-compose.prod.yml")

# The Keycloak `sub` of the seeder service account — MUST match
# `users[0].id` in `deploy/keycloak/realm-gadonghr.json` exactly. See this
# file's header for why.
SEEDER_SERVICE_ACCOUNT_ID="00000000-0000-4000-8000-00005eed0001"

# S2S auth task: the four machine principals' service-account ids, MUST
# match `users[].id` in `deploy/keycloak/realm-gadonghr.json` exactly, same
# reasoning as SEEDER_SERVICE_ACCOUNT_ID above. Forward-provisioned like
# `DB_PASSWORD_ONBOARDING`/etc. in `deploy/.env.example` — svc-onboarding,
# svc-payroll, svc-timesheet and svc-scheduler are not in
# `docker-compose.yml`'s seven-platform-service set yet, but their realm
# clients and svc-authz grants are seeded now so a later phase that adds
# them needs no new bootstrap step, only a compose service block.
SVC_ONBOARDING_SERVICE_ACCOUNT_ID="00000000-0000-4000-8000-00005ecc0001"
SVC_PAYROLL_SERVICE_ACCOUNT_ID="00000000-0000-4000-8000-00005ecc0002"
SVC_TIMESHEET_SERVICE_ACCOUNT_ID="00000000-0000-4000-8000-00005ecc0003"
SVC_SCHEDULER_SERVICE_ACCOUNT_ID="00000000-0000-4000-8000-00005ecc0004"

# crypto-auth task: four more machine principals' service-account ids, same
# matching rule as the four above. svc-docs is already in
# `docker-compose.yml`'s live service set; svc-attendance/svc-claims/
# svc-leave are forward-provisioned the same way the S2S auth task's four
# were before their compose service blocks existed.
SVC_ATTENDANCE_SERVICE_ACCOUNT_ID="00000000-0000-4000-8000-00005ecc0005"
SVC_CLAIMS_SERVICE_ACCOUNT_ID="00000000-0000-4000-8000-00005ecc0006"
SVC_LEAVE_SERVICE_ACCOUNT_ID="00000000-0000-4000-8000-00005ecc0007"
SVC_DOCS_SERVICE_ACCOUNT_ID="00000000-0000-4000-8000-00005ecc0008"

log() { printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }

compose() {
  docker compose -p "$PROJECT" "${COMPOSE_FILES[@]}" "$@"
}

require_healthy() {
  local svc="$1"
  local status
  status=$(compose ps --format '{{.Health}}' "$svc" 2>/dev/null || true)
  if [ "$status" != "healthy" ]; then
    log "ERROR: ${svc} is not healthy (status: ${status:-not running}). Run \`docker compose up -d\` first."
    exit 1
  fi
}

# Read from the environment only — never hard-coded, never printed.
: "${KC_ADMIN_USER:?KC_ADMIN_USER must be set (source .env first) — the realm bootstrap admin, used only to pin the seeder client secret}"
: "${KC_ADMIN_PASSWORD:?KC_ADMIN_PASSWORD must be set (source .env first)}"
: "${KEYCLOAK_SEEDER_CLIENT_SECRET:?KEYCLOAK_SEEDER_CLIENT_SECRET must be set (source .env first) — the seeder client confidential secret}"
# S2S auth task — the four machine principals' own confidential secrets,
# pinned the same way KEYCLOAK_SEEDER_CLIENT_SECRET is (see this file's
# header: realm-import JSON cannot safely carry a real secret).
: "${KEYCLOAK_SVC_ONBOARDING_CLIENT_SECRET:?KEYCLOAK_SVC_ONBOARDING_CLIENT_SECRET must be set (source .env first)}"
: "${KEYCLOAK_SVC_PAYROLL_CLIENT_SECRET:?KEYCLOAK_SVC_PAYROLL_CLIENT_SECRET must be set (source .env first)}"
: "${KEYCLOAK_SVC_TIMESHEET_CLIENT_SECRET:?KEYCLOAK_SVC_TIMESHEET_CLIENT_SECRET must be set (source .env first)}"
: "${KEYCLOAK_SVC_SCHEDULER_CLIENT_SECRET:?KEYCLOAK_SVC_SCHEDULER_CLIENT_SECRET must be set (source .env first)}"
# crypto-auth task — the four svc-crypto-calling machine principals' own
# confidential secrets, pinned the same way.
: "${KEYCLOAK_SVC_ATTENDANCE_CLIENT_SECRET:?KEYCLOAK_SVC_ATTENDANCE_CLIENT_SECRET must be set (source .env first)}"
: "${KEYCLOAK_SVC_CLAIMS_CLIENT_SECRET:?KEYCLOAK_SVC_CLAIMS_CLIENT_SECRET must be set (source .env first)}"
: "${KEYCLOAK_SVC_LEAVE_CLIENT_SECRET:?KEYCLOAK_SVC_LEAVE_CLIENT_SECRET must be set (source .env first)}"
: "${KEYCLOAK_SVC_DOCS_CLIENT_SECRET:?KEYCLOAK_SVC_DOCS_CLIENT_SECRET must be set (source .env first)}"
: "${KEYCLOAK_SVC_NOTIFY_CLIENT_SECRET:?KEYCLOAK_SVC_NOTIFY_CLIENT_SECRET must be set (source .env first)}"
: "${POSTGRES_SUPERUSER:?POSTGRES_SUPERUSER must be set (source .env first)}"
: "${POSTGRES_DB:?POSTGRES_DB must be set (source .env first)}"

log "Checking svc-authz (role/permission catalog seeds itself on every boot — nothing to trigger here)..."
require_healthy svc-authz
log "svc-authz is healthy — its role templates and permission catalog are already seeded (main.ts runs this on every boot)."

log "Granting the seeder service account its svc-authz permissions (idempotent)..."
# postgres is guaranteed healthy already — svc-authz's own `depends_on:
# postgres: {condition: service_healthy}` (docker-compose.yml) means the
# require_healthy check above already proved it.
if ! compose exec -T postgres psql -v ON_ERROR_STOP=1 -U "$POSTGRES_SUPERUSER" -d "$POSTGRES_DB" <<SQL
-- A minimal, purpose-built role — not hr-system-admin — holding exactly
-- the two permissions the seeder needs (Task 15b brief, verbatim).
INSERT INTO authz.role (code, name_i18n, is_system)
VALUES (
  'seeder-bootstrap',
  '{"en":"Seeder Bootstrap Service Account","th":"บัญชีบริการเริ่มต้นระบบ"}'::jsonb,
  true
)
ON CONFLICT (code) DO NOTHING;

-- authz.role_permission's PK IS (role_id, permission_code), so this
-- ON CONFLICT target is real, not a guess.
INSERT INTO authz.role_permission (role_id, permission_code)
SELECT r.id, p.code
FROM authz.role r
CROSS JOIN (VALUES ('config.pack.import'), ('authz.role.grant')) AS p(code)
WHERE r.code = 'seeder-bootstrap'
ON CONFLICT (role_id, permission_code) DO NOTHING;

-- authz.user_role has NO unique constraint on (user_id, role_id) — only
-- its auto-generated \`id\` is a key — so re-running this INSERT unguarded
-- would grant a second identical row every re-run. The NOT EXISTS guard
-- is what makes this idempotent. granted_by is self (the seeder grants
-- itself its own bootstrap role): at first boot there is no other
-- authenticated actor yet to have granted it, the same bootstrapping
-- problem every first-admin account has.
INSERT INTO authz.user_role (user_id, role_id, granted_by)
SELECT '${SEEDER_SERVICE_ACCOUNT_ID}'::uuid, r.id, '${SEEDER_SERVICE_ACCOUNT_ID}'::uuid
FROM authz.role r
WHERE r.code = 'seeder-bootstrap'
  AND NOT EXISTS (
    SELECT 1 FROM authz.user_role ur
    WHERE ur.user_id = '${SEEDER_SERVICE_ACCOUNT_ID}'::uuid
      AND ur.role_id = r.id
  );

-- S2S auth task (+ crypto-auth task additions below): one small,
-- purpose-built role per service, holding EXACTLY the permissions that
-- service's own outbound HTTP calls need (least privilege, not a shared
-- "services" super-role — a compromised svc-scheduler must not inherit
-- svc-payroll's timesheet.totals.read, and a service that only ever
-- encrypts must never hold crypto.decrypt). Grants (call sites, see each
-- service's own app.module.ts/config-client.ts/ports.ts):
--   svc-onboarding: config.rule.read (svc-config rules), document.generate
--                   (svc-docs contract render), crypto.encrypt +
--                   crypto.decrypt + crypto.bidx (svc-crypto — the only
--                   caller that both writes AND reads identity fields and
--                   computes blind indexes for national_id/email lookups)
--   svc-payroll:    config.rule.read, timesheet.totals.read (svc-timesheet
--                   locked totals — granted to NO human role template,
--                   see seed/roles.ts's PAYROLL_TIMESHEET_TOTALS_READ),
--                   document.generate (svc-docs payslip render),
--                   crypto.encrypt + crypto.decrypt (svc-crypto — every
--                   pay-profile/payslip/ytd field, never crypto.bidx: it
--                   never blind-indexes anything)
--   svc-timesheet:  config.rule.read (its own OT-threshold config read)
--   svc-scheduler:  config.rule.read (guardrail/holiday/OT ceilings)
--   svc-attendance: crypto.encrypt + crypto.decrypt (svc-crypto —
--                   DeviceService writes AND reads the device-secret
--                   field, never crypto.bidx)
--   svc-claims:     crypto.encrypt ONLY (svc-crypto — ClaimsService only
--                   ever WRITES a receipt file_ref, never reads one back)
--   svc-leave:      crypto.encrypt ONLY (svc-crypto — RequestsService only
--                   ever WRITES a medical-certificate pointer)
--   svc-docs:       crypto.encrypt + crypto.decrypt (svc-crypto — writes
--                   file_ref on generate, decrypts it back to serve a
--                   previously rendered document, never crypto.bidx)
INSERT INTO authz.role (code, name_i18n, is_system)
VALUES
  ('svc-onboarding-machine', '{"en":"svc-onboarding machine identity","th":"ตัวตนเครื่อง svc-onboarding"}'::jsonb, true),
  ('svc-payroll-machine', '{"en":"svc-payroll machine identity","th":"ตัวตนเครื่อง svc-payroll"}'::jsonb, true),
  ('svc-timesheet-machine', '{"en":"svc-timesheet machine identity","th":"ตัวตนเครื่อง svc-timesheet"}'::jsonb, true),
  ('svc-scheduler-machine', '{"en":"svc-scheduler machine identity","th":"ตัวตนเครื่อง svc-scheduler"}'::jsonb, true),
  ('svc-attendance-machine', '{"en":"svc-attendance machine identity","th":"ตัวตนเครื่อง svc-attendance"}'::jsonb, true),
  ('svc-claims-machine', '{"en":"svc-claims machine identity","th":"ตัวตนเครื่อง svc-claims"}'::jsonb, true),
  ('svc-leave-machine', '{"en":"svc-leave machine identity","th":"ตัวตนเครื่อง svc-leave"}'::jsonb, true),
  ('svc-docs-machine', '{"en":"svc-docs machine identity","th":"ตัวตนเครื่อง svc-docs"}'::jsonb, true)
ON CONFLICT (code) DO NOTHING;

INSERT INTO authz.role_permission (role_id, permission_code)
SELECT r.id, p.code
FROM authz.role r
JOIN (
  VALUES
    ('svc-onboarding-machine', 'config.rule.read'),
    ('svc-onboarding-machine', 'document.generate'),
    ('svc-onboarding-machine', 'crypto.encrypt'),
    ('svc-onboarding-machine', 'crypto.decrypt'),
    ('svc-onboarding-machine', 'crypto.bidx'),
    ('svc-payroll-machine', 'config.rule.read'),
    ('svc-payroll-machine', 'timesheet.totals.read'),
    ('svc-payroll-machine', 'document.generate'),
    ('svc-payroll-machine', 'crypto.encrypt'),
    ('svc-payroll-machine', 'crypto.decrypt'),
    ('svc-timesheet-machine', 'config.rule.read'),
    ('svc-scheduler-machine', 'config.rule.read'),
    ('svc-attendance-machine', 'crypto.encrypt'),
    ('svc-attendance-machine', 'crypto.decrypt'),
    ('svc-claims-machine', 'crypto.encrypt'),
    ('svc-leave-machine', 'crypto.encrypt'),
    ('svc-docs-machine', 'crypto.encrypt'),
    ('svc-docs-machine', 'crypto.decrypt')
) AS p(role_code, code) ON p.role_code = r.code
ON CONFLICT (role_id, permission_code) DO NOTHING;

INSERT INTO authz.user_role (user_id, role_id, granted_by)
SELECT u.user_id::uuid, r.id, '${SEEDER_SERVICE_ACCOUNT_ID}'::uuid
FROM (
  VALUES
    ('${SVC_ONBOARDING_SERVICE_ACCOUNT_ID}', 'svc-onboarding-machine'),
    ('${SVC_PAYROLL_SERVICE_ACCOUNT_ID}', 'svc-payroll-machine'),
    ('${SVC_TIMESHEET_SERVICE_ACCOUNT_ID}', 'svc-timesheet-machine'),
    ('${SVC_SCHEDULER_SERVICE_ACCOUNT_ID}', 'svc-scheduler-machine'),
    ('${SVC_ATTENDANCE_SERVICE_ACCOUNT_ID}', 'svc-attendance-machine'),
    ('${SVC_CLAIMS_SERVICE_ACCOUNT_ID}', 'svc-claims-machine'),
    ('${SVC_LEAVE_SERVICE_ACCOUNT_ID}', 'svc-leave-machine'),
    ('${SVC_DOCS_SERVICE_ACCOUNT_ID}', 'svc-docs-machine')
) AS u(user_id, role_code)
JOIN authz.role r ON r.code = u.role_code
WHERE NOT EXISTS (
  SELECT 1 FROM authz.user_role ur
  WHERE ur.user_id = u.user_id::uuid AND ur.role_id = r.id
);
SQL
then
  log "ERROR: could not grant the seeder/machine principals their svc-authz permissions — is postgres reachable and is the 'authz' schema migrated?"
  exit 1
fi
log "Seeder service account holds config.pack.import + authz.role.grant in svc-authz."
log "S2S auth task: svc-onboarding/svc-payroll/svc-timesheet/svc-scheduler machine principals hold their least-privilege grants in svc-authz (forward-provisioned)."
log "crypto-auth task: svc-attendance/svc-claims/svc-leave/svc-docs machine principals hold their least-privilege crypto.* grants in svc-authz."

log "Importing svc-config's statutory rule packs..."
require_healthy svc-config
require_healthy keycloak

# Everything below runs INSIDE the svc-config container (`docker compose
# exec`), not on the host: svc-config publishes no host port (only Traefik
# does), and Node 22's built-in `fetch` is already there — avoiding any
# dependency on `curl` (not installed in the node:22-alpine runtime image)
# and reaching Keycloak over the INTERNAL network (`http://keycloak:8080`,
# same as `OIDC_JWKS_URI`), not through Traefik/TLS. `-T` disables
# pseudo-TTY allocation, required for this non-interactive/cron context.
# `-e` passes the three admin/secret values in for this one exec only —
# they are never written into docker-compose.yml's persistent environment
# for svc-config.
if ! compose exec -T \
  -e KC_ADMIN_USER="$KC_ADMIN_USER" \
  -e KC_ADMIN_PASSWORD="$KC_ADMIN_PASSWORD" \
  -e KEYCLOAK_SEEDER_CLIENT_SECRET="$KEYCLOAK_SEEDER_CLIENT_SECRET" \
  -e KEYCLOAK_SVC_ONBOARDING_CLIENT_SECRET="$KEYCLOAK_SVC_ONBOARDING_CLIENT_SECRET" \
  -e KEYCLOAK_SVC_PAYROLL_CLIENT_SECRET="$KEYCLOAK_SVC_PAYROLL_CLIENT_SECRET" \
  -e KEYCLOAK_SVC_TIMESHEET_CLIENT_SECRET="$KEYCLOAK_SVC_TIMESHEET_CLIENT_SECRET" \
  -e KEYCLOAK_SVC_SCHEDULER_CLIENT_SECRET="$KEYCLOAK_SVC_SCHEDULER_CLIENT_SECRET" \
  -e KEYCLOAK_SVC_ATTENDANCE_CLIENT_SECRET="$KEYCLOAK_SVC_ATTENDANCE_CLIENT_SECRET" \
  -e KEYCLOAK_SVC_CLAIMS_CLIENT_SECRET="$KEYCLOAK_SVC_CLAIMS_CLIENT_SECRET" \
  -e KEYCLOAK_SVC_LEAVE_CLIENT_SECRET="$KEYCLOAK_SVC_LEAVE_CLIENT_SECRET" \
  -e KEYCLOAK_SVC_DOCS_CLIENT_SECRET="$KEYCLOAK_SVC_DOCS_CLIENT_SECRET" \
  -e KEYCLOAK_SVC_NOTIFY_CLIENT_SECRET="$KEYCLOAK_SVC_NOTIFY_CLIENT_SECRET" \
  svc-config node - <<'JS'
const { readdirSync } = require('node:fs')
const { join } = require('node:path')
// Compiled from services/svc-config/src/scripts/sign-pack.ts — imports
// `computePackSignature` from packs.service.ts itself (not a
// reimplementation), so what this script signs with is exactly what
// `PacksService.importPack` verifies with. See seed.sh's own header
// ("SIGNING:") for why re-signing here, not a baked-in `signature`, is
// the fix.
//
// `join(process.cwd(), ...)`, NOT `join(__dirname, ...)`: this script
// runs via `node -` (stdin), where `__dirname` is the bare string `'.'`,
// not an absolute path. `path.join('.', 'dist', ...)` normalises away
// the leading `./`, producing a plain 'dist/scripts/sign-pack.js' — and
// `require()` treats any specifier that does not start with `./`, `../`
// or `/` as a bare module name resolved via `node_modules`, not a
// relative file path, so that string 404s as "Cannot find module"
// instead of loading the file. `process.cwd()` is already absolute (this
// exec's WORKDIR is `/app/services/svc-config`, set by the Dockerfile),
// which sidesteps the ambiguity entirely.
const { signPackFile } = require(join(process.cwd(), 'dist', 'scripts', 'sign-pack.js'))

const KC_BASE = 'http://keycloak:8080/auth'
const REALM = 'gadonghr'

async function getMasterAdminToken() {
  let res
  try {
    res = await fetch(`${KC_BASE}/realms/master/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'admin-cli',
        username: process.env.KC_ADMIN_USER,
        password: process.env.KC_ADMIN_PASSWORD,
      }),
    })
  } catch (err) {
    throw new Error(`Keycloak is unreachable at ${KC_BASE} (${err.message}) — is the keycloak container up and healthy?`)
  }
  if (!res.ok) {
    throw new Error(
      `Keycloak rejected the realm bootstrap admin credentials (HTTP ${res.status}) — check KC_ADMIN_USER/KC_ADMIN_PASSWORD.`,
    )
  }
  return (await res.json()).access_token
}

// S2S auth task: generalised from the original seeder-only version so the
// same idempotent Admin-REST-pin mechanism (see this file's header
// "SIGNING:"-adjacent block on why a committed secret is unsafe) also pins
// each of the four machine principals' confidential secrets — one call per
// client, same shape, different clientId/secret.
async function pinClientSecret(adminToken, clientId, secret) {
  const listRes = await fetch(`${KC_BASE}/admin/realms/${REALM}/clients?clientId=${encodeURIComponent(clientId)}`, {
    headers: { authorization: `Bearer ${adminToken}` },
  })
  if (!listRes.ok) {
    throw new Error(
      `Could not look up the '${clientId}' client in realm '${REALM}' (HTTP ${listRes.status}) — has deploy/keycloak/realm-gadonghr.json been imported (--import-realm)?`,
    )
  }
  const clients = await listRes.json()
  const client = clients[0]
  if (!client) {
    throw new Error(
      `No '${clientId}' client found in realm '${REALM}' — has deploy/keycloak/realm-gadonghr.json been imported (--import-realm)?`,
    )
  }
  const updated = { ...client, secret }
  const putRes = await fetch(`${KC_BASE}/admin/realms/${REALM}/clients/${client.id}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(updated),
  })
  if (!putRes.ok) {
    throw new Error(`Could not set the '${clientId}' client's secret (HTTP ${putRes.status}).`)
  }
}

async function getSeederToken() {
  let res
  try {
    res = await fetch(`${KC_BASE}/realms/${REALM}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: 'seeder',
        client_secret: process.env.KEYCLOAK_SEEDER_CLIENT_SECRET,
      }),
    })
  } catch (err) {
    throw new Error(`Keycloak is unreachable at ${KC_BASE} (${err.message}).`)
  }
  if (!res.ok) {
    throw new Error(
      `Keycloak rejected the seeder client-credentials request (HTTP ${res.status}) — KEYCLOAK_SEEDER_CLIENT_SECRET may be wrong, or the secret pin above did not take.`,
    )
  }
  return (await res.json()).access_token
}

async function main() {
  const adminToken = await getMasterAdminToken()
  await pinClientSecret(adminToken, 'seeder', process.env.KEYCLOAK_SEEDER_CLIENT_SECRET)
  // S2S auth task: pin the four machine principals' secrets too — every
  // run, idempotent, same as the seeder above. Harmless today (none of
  // these four services are in docker-compose.yml's seven-platform-service
  // set yet — forward-provisioned) and exactly what makes them live the
  // moment a later phase adds the compose service block, with no separate
  // bootstrap step.
  await pinClientSecret(adminToken, 'svc-onboarding', process.env.KEYCLOAK_SVC_ONBOARDING_CLIENT_SECRET)
  await pinClientSecret(adminToken, 'svc-payroll', process.env.KEYCLOAK_SVC_PAYROLL_CLIENT_SECRET)
  await pinClientSecret(adminToken, 'svc-timesheet', process.env.KEYCLOAK_SVC_TIMESHEET_CLIENT_SECRET)
  await pinClientSecret(adminToken, 'svc-scheduler', process.env.KEYCLOAK_SVC_SCHEDULER_CLIENT_SECRET)
  // crypto-auth task: pin the four svc-crypto-calling machine principals'
  // secrets too — svc-docs is already a live compose service; the other
  // three are forward-provisioned, same reasoning as the block above.
  await pinClientSecret(adminToken, 'svc-attendance', process.env.KEYCLOAK_SVC_ATTENDANCE_CLIENT_SECRET)
  await pinClientSecret(adminToken, 'svc-claims', process.env.KEYCLOAK_SVC_CLAIMS_CLIENT_SECRET)
  await pinClientSecret(adminToken, 'svc-leave', process.env.KEYCLOAK_SVC_LEAVE_CLIENT_SECRET)
  await pinClientSecret(adminToken, 'svc-docs', process.env.KEYCLOAK_SVC_DOCS_CLIENT_SECRET)
  // svc-notify reads a recipient's email from svc-onboarding's audited
  // /employees/:id/sensitive before every email send — a live compose
  // service, so this secret is load-bearing rather than
  // forward-provisioned.
  await pinClientSecret(adminToken, 'svc-notify', process.env.KEYCLOAK_SVC_NOTIFY_CLIENT_SECRET)
  const seederToken = await getSeederToken()
  console.log('Obtained a seeder client-credentials token from Keycloak.')

  const seedDir = join(__dirname, 'seed')
  const files = readdirSync(seedDir).filter((f) => f.endsWith('.json')).sort()
  if (files.length === 0) {
    console.log('No seed pack files found in', seedDir)
    return
  }
  const signingKey = process.env.CONFIG_PACK_SIGNING_KEY
  if (!signingKey) {
    throw new Error('CONFIG_PACK_SIGNING_KEY is not set in the svc-config container environment — cannot sign packs for import.')
  }
  let failed = false
  for (const file of files) {
    // Sign fresh, for THIS environment's key, every run — the seed file
    // on disk has no `signature` field (see seed.sh's "SIGNING:" header).
    const pack = signPackFile(join(seedDir, file), signingKey)
    const res = await fetch('http://127.0.0.1:3000/packs/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${seederToken}` },
      body: JSON.stringify(pack),
    })
    const body = await res.text()
    if (res.ok) {
      console.log(`OK   ${file}: ${body}`)
    } else {
      failed = true
      console.error(`FAIL ${file}: HTTP ${res.status} ${body}`)
    }
  }
  if (failed) process.exit(1)
}

main().catch((err) => {
  console.error('seed.sh pack import failed:', err.message)
  process.exit(1)
})
JS
then
  log "ERROR: pack import failed — see output above."
  exit 1
fi

log "seed.sh complete."
