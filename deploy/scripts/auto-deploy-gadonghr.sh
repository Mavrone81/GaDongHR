#!/usr/bin/env bash
#
# auto-deploy-gadonghr.sh — pull-based continuous deploy for gadonghr-prod.
#
# Runs from cron every minute, under `flock`, e.g.:
#   * * * * * /usr/bin/flock -n /var/lock/gadonghr-deploy.lock \
#       /opt/gadonghr/deploy/scripts/auto-deploy-gadonghr.sh >>/var/log/gadonghr-deploy.log 2>&1
#
# What it does, in order:
#   1. Refuse if the disk is nearly full (df / >= 90%) — a deploy that
#      starts and fails partway through a full disk is worse than no
#      deploy.
#   2. Fetch and see whether HEAD is CI-green: only a commit with a
#      matching `refs/ci-pass/<sha>` ref is ever deployed (never an
#      unverified commit — roadmap "Standing constraints", brief §4).
#   3. Ask TWO independent questions and deploy if EITHER is yes:
#        (a) is there new verified code since the last deploy?
#        (b) is the stack actually running right now?
#      Only gating on (a) is the standing bug this script exists to avoid:
#      if a previous run's `up -d` failed halfway (a pulled image 404s, a
#      container OOMs and can't come back), the git checkout has ALREADY
#      fast-forwarded — so on the next run "is there new code?" is false
#      forever, and the stack silently stays down until a human notices.
#   4. Pull every image from GHCR. NEVER `docker compose build` here
#      (roadmap "Standing constraints": build only happens in CI).
#   5. `up -d` with both compose files.
#   6. Verify: poll a health endpoint until it responds AND reports the
#      sha just deployed. Containers reaching "running" is not proof the
#      new code is live — a stale image still "runs".
#   7. On success, the ONLY success signal this script ever prints is the
#      literal line `=== Deploy OK: <sha> ===` — monitoring greps for
#      exactly that string, so nothing else may print that shape.
#
# Every docker/compose invocation below is scoped to the `gadonghr`
# project (`-p gadonghr`, matching `name: gadonghr` in the compose files)
# so this script can never touch an unrelated project's containers on the
# same host. It never runs `docker compose down -v` (would destroy
# `vault_data` — permanent loss of every encrypted field, roadmap) and
# never `docker system prune --volumes` (see `prune-gadonghr-images.sh`
# for why plain `system prune` cannot even see the SHA-tagged images this
# stack uses, quite apart from the volumes danger).

set -euo pipefail

# ---------- Configuration ----------
DEPLOY_DIR="${GADONG_DEPLOY_DIR:-/opt/gadonghr/deploy}"
REPO_DIR="${GADONG_REPO_DIR:-/opt/gadonghr}"
PROJECT="gadonghr"
COMPOSE_FILES=(-f "$DEPLOY_DIR/docker-compose.yml" -f "$DEPLOY_DIR/docker-compose.prod.yml")
STATE_FILE="${GADONG_DEPLOY_STATE:-/opt/gadonghr/.last-deployed-sha}"
# Every platform service (brief §1) that must confirm it is running the
# sha just deployed. Only these seven are checked — the infra containers
# (postgres/vault/keycloak/...) carry no GADONG_BUILD_SHA of their own to
# verify. There is no single host-reachable health URL: only Traefik
# publishes ports (docker-compose.yml), so verification runs INSIDE the
# compose network via `docker compose exec`, one service at a time.
VERIFY_SERVICES=(svc-crypto svc-config svc-authz svc-audit svc-i18n svc-notify svc-docs)
MAX_DISK_PCT="${GADONG_MAX_DISK_PCT:-90}"
HEALTH_RETRIES="${GADONG_HEALTH_RETRIES:-30}"
HEALTH_RETRY_INTERVAL_S="${GADONG_HEALTH_RETRY_INTERVAL_S:-2}"

log() { printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }
die() {
  log "Deploy FAILED: $*"
  exit 1
}

compose() {
  docker compose -p "$PROJECT" "${COMPOSE_FILES[@]}" "$@"
}

# ---------- 1. Refuse on a nearly-full disk ----------
disk_pct=$(df -P / | awk 'NR==2 { gsub("%","",$5); print $5 }')
if [ "$disk_pct" -ge "$MAX_DISK_PCT" ]; then
  die "df / is at ${disk_pct}% (>= ${MAX_DISK_PCT}%) — refusing to deploy. Free space first."
fi

# ---------- 2. Fetch, then require CI-green ----------
cd "$REPO_DIR"
git fetch --quiet origin

remote_sha=$(git rev-parse origin/main)
if ! git ls-remote --exit-code origin "refs/ci-pass/${remote_sha}" >/dev/null 2>&1; then
  log "origin/main (${remote_sha}) has no refs/ci-pass/${remote_sha} yet — not CI-verified, nothing to do."
  exit 0
fi

previous_sha=""
[ -f "$STATE_FILE" ] && previous_sha=$(cat "$STATE_FILE")

# ---------- 3. Two independent questions ----------
new_code=false
[ "$remote_sha" != "$previous_sha" ] && new_code=true

stack_running=true
if ! compose ps --status running --format '{{.Name}}' 2>/dev/null | grep -q .; then
  stack_running=false
fi

if [ "$new_code" = false ] && [ "$stack_running" = true ]; then
  log "No new verified code (still ${remote_sha}) and the stack is already running — nothing to do."
  exit 0
fi
log "Deploying ${remote_sha} (new_code=${new_code}, stack_running=${stack_running}, previous=${previous_sha:-none})"

# Fast-forward the checkout only once we've decided to actually deploy —
# this is the ordering that makes step (3)'s "OR" condition matter: if
# `up -d` below fails, this checkout has already moved, so a bare
# "is there new code?" check next run would say no forever without it.
git checkout --quiet "$remote_sha"

# ---------- 3b. Ensure secret file ownership (Task 16b) ----------
# Compose's file-sourced `secrets:` (docker-compose.yml's `vault_approle_secret`)
# bind-mounts `./secrets/vault_approle_secret` into svc-crypto's container
# with the HOST file's own ownership preserved verbatim — this compose
# engine does not honour the compose-spec's per-service `uid`/`gid`/`mode`
# secret fields outside Swarm (verified empirically: `docker compose up`
# prints "secrets `uid`, `gid` and `mode` are not supported, they will be
# ignored" and mounts with the host owner unchanged regardless — see
# docker-compose.yml's svc-crypto comment). The correct host permission is
# `-rw------- root:root` (never world/group-readable — brief: do not fix
# this with `chmod 644`), but svc-crypto's container runs as `node` (uid
# 1000, `services/svc-crypto/Dockerfile`'s `USER node`), so without this
# step every fresh host/volume/backup-restore reproduces the exact EACCES
# crash-loop this task fixed, waiting on a human to remember a manual
# `chown`. Idempotent, cheap, and safe to run even before the file exists
# (e.g. before the Vault ceremony has produced it on a brand new host) —
# `[ -f ... ]` skips silently rather than failing the whole deploy.
if [ -f "$DEPLOY_DIR/secrets/vault_approle_secret" ]; then
  chown 1000:1000 "$DEPLOY_DIR/secrets/vault_approle_secret"
  chmod 600 "$DEPLOY_DIR/secrets/vault_approle_secret"
fi

# ---------- 4 & 5. Pull from GHCR only, then up -d ----------
# `GADONG_VERSION`, not `GADONG_BUILD_SHA`: docker-compose.prod.yml's
# `image:` tags all read `GADONG_VERSION` (the one deploy-time variable,
# shared by all eight services). `GADONG_BUILD_SHA` is a build-time-only
# `docker build --build-arg` (CI sets it; see ci.yml's `build-images`) and
# is never read by `compose pull` — exporting it here instead of
# `GADONG_VERSION` was Task 15's bug: every image tag fell through to its
# `:-main`/formerly `:-latest` default regardless of which sha was
# CI-verified above.
export GADONG_VERSION="$remote_sha"
compose pull
compose up -d --remove-orphans

# ---------- 6. Verify the NEW sha is actually live, per service ----------
# `/health`'s `version` field comes from GADONG_BUILD_SHA baked into the
# image at build time (packages/kernel/src/version.ts) — this is the
# proof the check is FOR: a container reaching "running" only proves the
# process started, not that it is running the sha we just told it to.
# `wget`, not `curl`: the node:22-alpine runtime images ship busybox
# wget, not curl (every Dockerfile's healthcheck already relies on this).
verify_service() {
  local svc="$1" attempt body
  for ((attempt = 1; attempt <= HEALTH_RETRIES; attempt++)); do
    if body=$(compose exec -T "$svc" wget -qO- http://127.0.0.1:3000/health 2>/dev/null) \
      && printf '%s' "$body" | grep -q "\"version\":\"${remote_sha}\""; then
      return 0
    fi
    sleep "$HEALTH_RETRY_INTERVAL_S"
  done
  return 1
}

for svc in "${VERIFY_SERVICES[@]}"; do
  if ! verify_service "$svc"; then
    die "${svc} never reported sha ${remote_sha} on /health after $((HEALTH_RETRIES * HEALTH_RETRY_INTERVAL_S))s — deploy NOT confirmed live."
  fi
done

echo "$remote_sha" >"$STATE_FILE"
log "=== Deploy OK: ${remote_sha} ==="
