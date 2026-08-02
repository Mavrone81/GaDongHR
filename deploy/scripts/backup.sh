#!/usr/bin/env bash
#
# backup.sh — nightly backup for gadonghr-prod (Runbook §3: RPO <= 24h,
# RTO <= 4h). Run from cron, e.g.:
#   30 2 * * * /opt/gadonghr/deploy/scripts/backup.sh >>/var/log/gadonghr-backup.log 2>&1
#
# Steps, matching Runbook §3 exactly:
#   1. `pg_dump -Fc` the whole database (every schema in one dump — `-Fc`
#      with no `--schema` filter, so all twelve business schemas plus
#      `audit`/`keycloak`, dumped in Postgres's custom format for
#      `pg_restore`).
#   2. `vault operator raft snapshot save` — the ONLY way to recover
#      Vault's Raft state (and therefore every KEK, and therefore every
#      encrypted field in the system — see deploy/vault/vault.hcl's
#      header) short of the unseal shares themselves.
#   3. Mirror the MinIO document bucket.
#   4. tar everything together and encrypt it with `age` to a recipient
#      whose PRIVATE key is the offline backup key (Runbook §3: never on
#      this host).
#   5. Rotate: keep 30 daily archives, and additionally keep 12 monthly
#      archives (the first successful run of each calendar month is
#      copied into the monthly retention set).
#
# ⚠️  AN UNTESTED BACKUP IS NOT A BACKUP (Runbook §3, verbatim). This
# script proves the five steps above completed without error — it does
# NOT prove the result is restorable. Runbook §3 requires a quarterly
# restore drill (fresh host, restore this archive, unseal with 3 key
# officers, `pg_restore`, MinIO restore, `scripts/verify-restore.sh`) —
# that script is a separate deliverable, not part of Task 13, and until
# it exists and has been run at least once against a real archive this
# script produced, treat every archive here as UNVERIFIED.
#
# Known prerequisite gaps, surfaced loudly rather than silently skipped:
#   - Vault snapshotting needs an authenticated `VAULT_TOKEN` with
#     permission to read `sys/storage/raft/snapshot`. Provisioning that
#     token is part of the `vault-init.sh` ceremony (Runbook §2), which is
#     out of scope for Task 13 (brief's file list does not include it).
#     If `VAULT_TOKEN` is unset, this script SKIPS the Vault snapshot and
#     exits non-zero at the end rather than reporting success — a backup
#     missing the Vault snapshot cannot restore any encrypted field.
#   - Off-host shipping (Runbook §3 step 5, "ship off-host") is gated on
#     `BACKUP_REMOTE` (an rsync target, e.g. `user@host:/path`). If unset,
#     archives stay local-only, which does NOT satisfy the RPO/RTO
#     promise on its own (loss of this host loses every local archive
#     too) — this script warns, it does not fail the run over it, because
#     a local-only backup is still strictly better than no backup while
#     off-host shipping is being set up.

set -euo pipefail

PROJECT="gadonghr"
DEPLOY_DIR="${GADONG_DEPLOY_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
COMPOSE_FILES=(-f "$DEPLOY_DIR/docker-compose.yml")
[ -f "$DEPLOY_DIR/docker-compose.prod.yml" ] && COMPOSE_FILES+=(-f "$DEPLOY_DIR/docker-compose.prod.yml")

BACKUP_ROOT="${GADONG_BACKUP_ROOT:-/opt/gadonghr/backups}"
DAILY_DIR="$BACKUP_ROOT/daily"
MONTHLY_DIR="$BACKUP_ROOT/monthly"
KEEP_DAILY="${GADONG_BACKUP_KEEP_DAILY:-30}"
KEEP_MONTHLY="${GADONG_BACKUP_KEEP_MONTHLY:-12}"
STAMP="$(date -u '+%Y%m%dT%H%M%SZ')"
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/gadonghr-backup.XXXXXX")"

log() { printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }
cleanup() { rm -rf "$WORKDIR"; }
trap cleanup EXIT

compose() {
  docker compose -p "$PROJECT" "${COMPOSE_FILES[@]}" "$@"
}

: "${POSTGRES_SUPERUSER:?POSTGRES_SUPERUSER must be set (source .env first)}"
: "${POSTGRES_DB:?POSTGRES_DB must be set (source .env first)}"

mkdir -p "$DAILY_DIR" "$MONTHLY_DIR"
ok=true

# ---------- 1. Postgres ----------
log "Dumping Postgres (${POSTGRES_DB}, all schemas, custom format)..."
if compose exec -T postgres pg_dump -Fc -U "$POSTGRES_SUPERUSER" -d "$POSTGRES_DB" >"$WORKDIR/postgres.dump"; then
  log "Postgres dump OK ($(du -h "$WORKDIR/postgres.dump" | cut -f1))"
else
  log "ERROR: pg_dump failed."
  ok=false
fi

# ---------- 2. Vault ----------
if [ -z "${VAULT_TOKEN:-}" ]; then
  log "WARNING: VAULT_TOKEN is not set — SKIPPING the Vault raft snapshot. This backup is INCOMPLETE: it cannot restore any encrypted field without a Vault snapshot from the same window."
  ok=false
else
  log "Saving Vault raft snapshot..."
  if compose exec -T -e VAULT_TOKEN="$VAULT_TOKEN" vault \
    vault operator raft snapshot save - >"$WORKDIR/vault.snap"; then
    log "Vault snapshot OK ($(du -h "$WORKDIR/vault.snap" | cut -f1))"
  else
    log "ERROR: vault operator raft snapshot save failed."
    ok=false
  fi
fi

# ---------- 3. MinIO ----------
log "Mirroring MinIO bucket (${DOCS_BUCKET:-gadonghr-docs})..."
if compose exec -T minio sh -c "
    mc alias set backupsrc http://127.0.0.1:9000 \"\$MINIO_ROOT_USER\" \"\$MINIO_ROOT_PASSWORD\" >/dev/null &&
    rm -rf /tmp/gadonghr-mirror &&
    mc mirror --quiet backupsrc/${DOCS_BUCKET:-gadonghr-docs} /tmp/gadonghr-mirror
  "; then
  if compose cp "minio:/tmp/gadonghr-mirror" "$WORKDIR/minio"; then
    log "MinIO mirror OK"
  else
    log "ERROR: could not copy MinIO mirror out of the container."
    ok=false
  fi
else
  log "ERROR: mc mirror failed (bucket may not exist yet on a fresh install — not fatal on day one, but check)."
fi

# ---------- 4. Encrypt ----------
ARCHIVE_NAME="gadonghr-backup-${STAMP}.tar"
tar -C "$WORKDIR" -cf "$WORKDIR/$ARCHIVE_NAME" .

if [ -z "${BACKUP_AGE_RECIPIENT:-}" ]; then
  log "ERROR: BACKUP_AGE_RECIPIENT is not set — refusing to write an UNENCRYPTED backup archive containing S3-class data (national IDs, bank accounts, salaries)."
  exit 1
fi
if ! command -v age >/dev/null 2>&1; then
  log "ERROR: 'age' is not installed on this host — cannot encrypt the archive. Install it (e.g. 'apt install age') before this script can produce a usable backup."
  exit 1
fi

ENCRYPTED_PATH="$DAILY_DIR/${ARCHIVE_NAME}.age"
age -r "$BACKUP_AGE_RECIPIENT" -o "$ENCRYPTED_PATH" "$WORKDIR/$ARCHIVE_NAME"
log "Encrypted archive written: $ENCRYPTED_PATH"

# First successful archive of the calendar month also goes to monthly/.
MONTH_TAG="$(date -u '+%Y%m')"
if ! ls "$MONTHLY_DIR"/gadonghr-backup-"${MONTH_TAG}"*.tar.age >/dev/null 2>&1; then
  cp "$ENCRYPTED_PATH" "$MONTHLY_DIR/"
  log "Also kept as this month's monthly archive."
fi

# ---------- 5. Retention ----------
prune_dir() {
  local dir="$1" keep="$2"
  # shellcheck disable=SC2012
  ls -1t "$dir"/gadonghr-backup-*.tar.age 2>/dev/null | tail -n "+$((keep + 1))" | while IFS= read -r stale; do
    log "Pruning old archive: $stale"
    rm -f -- "$stale"
  done
}
prune_dir "$DAILY_DIR" "$KEEP_DAILY"
prune_dir "$MONTHLY_DIR" "$KEEP_MONTHLY"

# ---------- Off-host shipping (optional but required for a real RPO/RTO) ----------
if [ -n "${BACKUP_REMOTE:-}" ]; then
  log "Shipping off-host to ${BACKUP_REMOTE}..."
  if ! rsync -az "$ENCRYPTED_PATH" "$BACKUP_REMOTE/"; then
    log "ERROR: off-host rsync failed — archive exists locally only."
    ok=false
  fi
else
  log "WARNING: BACKUP_REMOTE is not set — archive is LOCAL-ONLY. Losing this host loses this backup too; set BACKUP_REMOTE before this satisfies Runbook §3's RPO/RTO."
fi

log "Reminder: an untested backup is not a backup — Runbook §3 requires a quarterly restore drill."

if [ "$ok" != true ]; then
  log "backup.sh finished with errors (see above) — DO NOT treat this run as a complete backup."
  exit 1
fi
log "backup.sh complete: $ENCRYPTED_PATH"
