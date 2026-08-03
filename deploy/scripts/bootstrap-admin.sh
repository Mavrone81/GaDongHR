#!/usr/bin/env bash
#
# bootstrap-admin.sh — creates the FIRST HR/System Admin user in the
# `gadonghr` Keycloak realm, forces a password change and OTP enrolment on
# first login, and grants that user the `hr-system-admin` role in
# svc-authz (Keycloak owns identity; svc-authz owns grants — a Keycloak
# login with no svc-authz grant can authenticate and still be denied by
# every guarded route, exactly like `seed.sh`'s seeder service account
# before its own bootstrap grant). Run once, after `seed.sh` (Runbook §1
# install order: `seed.sh` first — it is what pins the `seeder` client's
# secret and grants it `authz.role.grant`, which THIS script depends on to
# make its own grant call below).
#
# Idempotent: the entire script (Keycloak user creation, the forced
# password/OTP required actions, AND the svc-authz role grant) is gated on
# a single check — "does a Keycloak user with this email already exist in
# the gadonghr realm?" If yes, this script does nothing at all: it never
# creates a second admin, and it never touches the existing admin's
# credentials (no password reset, no required-action change) on a second
# run. `authz.user_role` has no unique constraint that would make a raw
# re-grant safe on its own (see seed.sh's own comment on the same table),
# so gating on Keycloak's user existence — checked first — is what keeps
# the svc-authz grant from being able to run twice, not a second guard on
# the svc-authz side.

set -euo pipefail

PROJECT="gadonghr"
DEPLOY_DIR="${GADONG_DEPLOY_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
COMPOSE_FILES=(-f "$DEPLOY_DIR/docker-compose.yml")
[ -f "$DEPLOY_DIR/docker-compose.prod.yml" ] && COMPOSE_FILES+=(-f "$DEPLOY_DIR/docker-compose.prod.yml")

# MUST match `users[0].id` in `deploy/keycloak/realm-gadonghr.json` and the
# same constant in `seed.sh` — see both files' headers. Used here only as
# the `grantedBy` actor on the role grant this script makes (the seeder is
# the one making the API call, on the new admin's behalf).
SEEDER_SERVICE_ACCOUNT_ID="00000000-0000-4000-8000-00005eed0001"

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
: "${KC_ADMIN_USER:?KC_ADMIN_USER must be set (source .env first) — the realm bootstrap admin}"
: "${KC_ADMIN_PASSWORD:?KC_ADMIN_PASSWORD must be set (source .env first)}"
: "${KEYCLOAK_SEEDER_CLIENT_SECRET:?KEYCLOAK_SEEDER_CLIENT_SECRET must be set (source .env first) — seed.sh must have run first}"
: "${BOOTSTRAP_ADMIN_EMAIL:?BOOTSTRAP_ADMIN_EMAIL must be set (source .env first) — login email for the first HR/System Admin}"
: "${BOOTSTRAP_ADMIN_TEMP_PASSWORD:?BOOTSTRAP_ADMIN_TEMP_PASSWORD must be set (source .env first) — one-time password, forced to change on first login}"
: "${POSTGRES_SUPERUSER:?POSTGRES_SUPERUSER must be set (source .env first)}"
: "${POSTGRES_DB:?POSTGRES_DB must be set (source .env first)}"

require_healthy keycloak
require_healthy svc-authz

log "Looking up the hr-system-admin role id in svc-authz..."
ROLE_ID=$(compose exec -T postgres psql -tAc "SELECT id FROM authz.role WHERE code = 'hr-system-admin'" -U "$POSTGRES_SUPERUSER" -d "$POSTGRES_DB" | tr -d '[:space:]')
if [ -z "$ROLE_ID" ]; then
  log "ERROR: no 'hr-system-admin' role found in authz.role — has svc-authz seeded its role templates yet (it does this on every boot)?"
  exit 1
fi
log "hr-system-admin role id: ${ROLE_ID}"

# Runs inside svc-config's container — same rationale as seed.sh (Node's
# built-in fetch, internal-network route to both keycloak and svc-authz,
# no curl in the runtime image). `-e` passes secrets in for this one exec
# only.
if ! compose exec -T \
  -e KC_ADMIN_USER="$KC_ADMIN_USER" \
  -e KC_ADMIN_PASSWORD="$KC_ADMIN_PASSWORD" \
  -e KEYCLOAK_SEEDER_CLIENT_SECRET="$KEYCLOAK_SEEDER_CLIENT_SECRET" \
  -e BOOTSTRAP_ADMIN_EMAIL="$BOOTSTRAP_ADMIN_EMAIL" \
  -e BOOTSTRAP_ADMIN_TEMP_PASSWORD="$BOOTSTRAP_ADMIN_TEMP_PASSWORD" \
  -e ROLE_ID="$ROLE_ID" \
  -e SEEDER_SERVICE_ACCOUNT_ID="$SEEDER_SERVICE_ACCOUNT_ID" \
  svc-config node - <<'JS'
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
    throw new Error(`Keycloak is unreachable at ${KC_BASE} (${err.message}).`)
  }
  if (!res.ok) {
    throw new Error(`Keycloak rejected the realm bootstrap admin credentials (HTTP ${res.status}).`)
  }
  return (await res.json()).access_token
}

async function findExistingAdmin(adminToken, email) {
  const res = await fetch(
    `${KC_BASE}/admin/realms/${REALM}/users?email=${encodeURIComponent(email)}&exact=true`,
    { headers: { authorization: `Bearer ${adminToken}` } },
  )
  if (!res.ok) throw new Error(`Could not look up existing users (HTTP ${res.status}).`)
  const users = await res.json()
  return users[0] ?? null
}

async function createAdmin(adminToken, email, tempPassword) {
  const createRes = await fetch(`${KC_BASE}/admin/realms/${REALM}/users`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      username: email,
      email,
      enabled: true,
      emailVerified: true,
      firstName: 'HR',
      lastName: 'Admin',
      requiredActions: ['UPDATE_PASSWORD', 'CONFIGURE_TOTP'],
    }),
  })
  if (!createRes.ok) {
    throw new Error(`Could not create the HR/System Admin user (HTTP ${createRes.status}).`)
  }
  const created = await findExistingAdmin(adminToken, email)
  if (!created) throw new Error('Admin user was created but could not be looked back up.')

  const pwRes = await fetch(`${KC_BASE}/admin/realms/${REALM}/users/${created.id}/reset-password`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'password', temporary: true, value: tempPassword }),
  })
  if (!pwRes.ok) {
    throw new Error(`User was created but setting the temporary password failed (HTTP ${pwRes.status}).`)
  }
  return created
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
      `Keycloak rejected the seeder client-credentials request (HTTP ${res.status}) — did seed.sh run first?`,
    )
  }
  return (await res.json()).access_token
}

async function grantHrSystemAdmin(seederToken, newUserId) {
  const res = await fetch(`http://svc-authz:3000/users/${newUserId}/roles`, {
    method: 'POST',
    headers: { authorization: `Bearer ${seederToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ roleId: process.env.ROLE_ID, grantedBy: process.env.SEEDER_SERVICE_ACCOUNT_ID }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`svc-authz rejected the hr-system-admin grant (HTTP ${res.status}): ${body}`)
  }
}

async function main() {
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL
  const adminToken = await getMasterAdminToken()

  const existing = await findExistingAdmin(adminToken, email)
  if (existing) {
    console.log(`HR/System Admin '${email}' already exists (id ${existing.id}) — nothing to do (idempotent no-op).`)
    return
  }

  const created = await createAdmin(adminToken, email, process.env.BOOTSTRAP_ADMIN_TEMP_PASSWORD)
  console.log(`Created HR/System Admin '${email}' (id ${created.id}); password change + OTP enrolment required at first login.`)

  const seederToken = await getSeederToken()
  await grantHrSystemAdmin(seederToken, created.id)
  console.log(`Granted hr-system-admin (role id ${process.env.ROLE_ID}) to ${created.id} in svc-authz.`)
}

main().catch((err) => {
  console.error('bootstrap-admin.sh failed:', err.message)
  process.exit(1)
})
JS
then
  log "ERROR: bootstrap-admin failed — see output above."
  exit 1
fi

log "bootstrap-admin.sh complete."
