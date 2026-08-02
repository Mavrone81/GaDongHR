#!/usr/bin/env bash
#
# seed.sh — svc-config's statutory rule packs + svc-authz's role/permission
# catalog. Run once after the FIRST `docker compose ... up -d` (Runbook §1
# install order), and safe to re-run any time: both halves are idempotent.
#
# ---------------------------------------------------------------------------
# svc-authz needs NOTHING from this script.
#
# Read directly from `services/svc-authz/src/main.ts`: `bootstrap()` calls
# `runSeed()` — which runs `seedRoleTemplates` inside a transaction — on
# EVERY container boot, before it starts listening. `seed/roles.test.ts`
# proves it is idempotent by content hash (matching this task's brief:
# "running twice must produce identical state"). By the time `docker
# compose ps` shows svc-authz healthy, its permission catalog and all ten
# role templates are already seeded. This script only waits for and
# confirms that, it does not trigger it a second time.
# ---------------------------------------------------------------------------
# svc-config's statutory packs are NOT auto-seeded — `packSevice.
# importPack` is reachable only via `POST /packs/import`
# (rules.controller.ts), which this script calls for every
# `services/svc-config/seed/*.json` file shipped inside the svc-config
# image (`Dockerfile` COPYs `seed/` next to `dist/`). `PackImportResult`
# is `{status: 'imported' | 'duplicate', ...}` — re-POSTing an
# already-imported pack is a documented no-op, which is what makes this
# half idempotent too.
#
# ⚠️  KNOWN GAP, not a bug in this script: `POST /packs/import` is guarded
# by `@RequirePermission('config.pack.import')`
# (`packages/kernel/src/authz/guard.ts`'s `PermissionGuard`), which denies
# any request where `request.userId` is unset — and, verified by reading
# every service's source (not assumed), NO service in this repository yet
# has middleware that populates `request.userId` from a Keycloak-issued
# bearer token or any other credential. That piece (Phase 1.5's web-shell
# auth wiring, per docs/superpowers/plans/00-PROGRAM-ROADMAP.md) does not
# exist yet. Concretely: this call will fail with `AUZ-403
# authz.error.denied` until that middleware ships — for EVERY caller, not
# just this script; there is currently no way for anything to
# authenticate to a guarded route. This script still calls the real
# endpoint (the architecturally correct thing to do, and it starts
# working with zero changes the day that middleware lands) rather than
# writing directly to Postgres and re-implementing PacksService's
# signature verification in bash. See deploy/README.md.

set -euo pipefail

PROJECT="gadonghr"
DEPLOY_DIR="${GADONG_DEPLOY_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
COMPOSE_FILES=(-f "$DEPLOY_DIR/docker-compose.yml")
[ -f "$DEPLOY_DIR/docker-compose.prod.yml" ] && COMPOSE_FILES+=(-f "$DEPLOY_DIR/docker-compose.prod.yml")

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

log "Checking svc-authz (role/permission catalog seeds itself on every boot — nothing to trigger here)..."
require_healthy svc-authz
log "svc-authz is healthy — its role templates and permission catalog are already seeded (main.ts runs this on every boot)."

log "Importing svc-config's statutory rule packs..."
require_healthy svc-config

# The Node script below runs INSIDE the svc-config container (`docker
# compose exec`), not on the host: svc-config publishes no host port
# (only Traefik does, per docker-compose.yml), and Node 22's built-in
# `fetch` is already there, avoiding any dependency on `curl` (not
# installed in the node:22-alpine runtime image) or wrestling BusyBox
# `wget`'s limited POST support into shape for a JSON body from a shell
# variable. `-T` disables pseudo-TTY allocation, required for this
# non-interactive/cron context.
if ! compose exec -T svc-config node - <<'JS'
const { readdirSync, readFileSync } = require('node:fs')
const { join } = require('node:path')

async function main() {
  const seedDir = join(__dirname, 'seed')
  const files = readdirSync(seedDir).filter((f) => f.endsWith('.json')).sort()
  if (files.length === 0) {
    console.log('No seed pack files found in', seedDir)
    return
  }
  let failed = false
  for (const file of files) {
    const pack = JSON.parse(readFileSync(join(seedDir, file), 'utf8'))
    const res = await fetch('http://127.0.0.1:3000/packs/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(pack),
    })
    const body = await res.text()
    if (res.ok) {
      console.log(`OK   ${file}: ${body}`)
    } else {
      failed = true
      console.error(`FAIL ${file}: HTTP ${res.status} ${body}`)
      if (res.status === 403) {
        console.error(
          '     -> AUZ-403 is the documented, expected result until a JWT/OIDC ' +
            'verification middleware exists in svc-config (see this script\'s header comment).',
        )
      }
    }
  }
  if (failed) process.exit(1)
}

main().catch((err) => {
  console.error('seed.sh pack import crashed:', err)
  process.exit(1)
})
JS
then
  log "ERROR: pack import failed — see output above. This is expected (AUZ-403) until the auth middleware described in this script's header lands; it is NOT something a re-run of this script can fix on its own."
  exit 1
fi

log "seed.sh complete."
