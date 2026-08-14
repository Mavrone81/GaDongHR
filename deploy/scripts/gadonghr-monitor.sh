#!/usr/bin/env bash
#
# gadonghr-monitor.sh — ops-hardening: "nothing pages or notifies on
# container unhealthy/crash-looping, Vault sealed, disk filling, or
# backup failed." This is the periodic check that closes that gap.
#
# Run on a timer (systemd: deploy/systemd/gadonghr-monitor.timer, or
# cron — see deploy/README.md), e.g. every 5 minutes:
#   */5 * * * * /opt/gadonghr/deploy/scripts/gadonghr-monitor.sh >>/var/log/gadonghr-monitor.log 2>&1
#
# Four checks, matching the audit exactly:
#   1. Every container in the `gadonghr` compose project is "running" and,
#      where it declares a healthcheck, "healthy" — catches
#      unhealthy/crash-looping/exited containers.
#   2. Vault's seal status, checked directly (not inferred from Docker's
#      health status — docker-compose.yml's healthcheck deliberately
#      keeps a SEALED vault Docker-"healthy", see that file's comment).
#      A sealed vault is degraded (every S2/S3 op 503s) even though
#      nothing crash-loops, so this is the one place that actually pages
#      on it.
#   3. Disk usage on the filesystem the docker/backup data lives on.
#   4. Age of the newest local backup archive — catches both "backup.sh
#      hasn't run" and "backup.sh has been failing silently" (a failed
#      run still exits before writing a fresh archive in most failure
#      modes here, so a stale newest-archive timestamp is a good proxy;
#      backup.sh's own non-zero exit is ALSO wired directly into this
#      same alert path via systemd's OnFailure=, see
#      deploy/systemd/gadonghr-backup.service).
#
# Alert delivery and local logging both go through gadonghr-alert.sh —
# see that script's header for the channel contract (one env var).
#
# Debounce: without it, a persistent failure would re-alert every single
# run (every 5 min by default) — noisy enough that a human tunes it out,
# which defeats the point. State is one file per check under
# $GADONG_MONITOR_STATE_DIR; a check only fires a fresh alert when it
# TRANSITIONS from OK to FAIL, or when it has been failing for longer
# than $GADONG_MONITOR_REALERT_MINUTES (default 60) since the last alert
# — so a real, ongoing outage still gets periodic reminders, not silence.
# Recovery (FAIL -> OK) always logs locally, whether or not the prior
# failure had crossed the alert threshold, and always clears the state.

set -uo pipefail  # not -e: one check failing must not skip the others

PROJECT="gadonghr"
DEPLOY_DIR="${GADONG_DEPLOY_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ALERT_SCRIPT="${GADONG_ALERT_SCRIPT:-$(dirname "${BASH_SOURCE[0]}")/gadonghr-alert.sh}"
COMPOSE_FILES=(-f "$DEPLOY_DIR/docker-compose.yml")
[ -f "$DEPLOY_DIR/docker-compose.prod.yml" ] && COMPOSE_FILES+=(-f "$DEPLOY_DIR/docker-compose.prod.yml")

BACKUP_ROOT="${GADONG_BACKUP_ROOT:-/opt/gadonghr/backups}"
DISK_PATH="${GADONG_MONITOR_DISK_PATH:-/}"
MAX_DISK_PCT="${GADONG_MONITOR_MAX_DISK_PCT:-85}"
MAX_BACKUP_AGE_HOURS="${GADONG_MONITOR_MAX_BACKUP_AGE_HOURS:-30}"
STATE_DIR="${GADONG_MONITOR_STATE_DIR:-/var/lib/gadonghr-monitor}"
REALERT_MINUTES="${GADONG_MONITOR_REALERT_MINUTES:-60}"

log() { printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }

compose() {
  docker compose -p "$PROJECT" "${COMPOSE_FILES[@]}" "$@"
}

mkdir -p "$STATE_DIR" 2>/dev/null || true

# report <check-name> <ok|fail> <message>
# Owns the whole debounce + alert-dispatch decision for one check.
report() {
  local check="$1" status="$2" message="$3"
  local state_file="$STATE_DIR/$check"

  if [ "$status" = ok ]; then
    log "OK   ${check}: ${message}"
    if [ -f "$state_file" ]; then
      log "${check} recovered — clearing state and sending a recovery notice."
      "$ALERT_SCRIPT" OK "$check" "RECOVERED: $message" || true
      rm -f "$state_file"
    fi
    return 0
  fi

  log "FAIL ${check}: ${message}"
  local now last_alert_epoch=0
  now=$(date -u +%s)
  if [ -f "$state_file" ]; then
    last_alert_epoch=$(cat "$state_file" 2>/dev/null || echo 0)
  fi
  local elapsed_min=$(( (now - last_alert_epoch) / 60 ))
  if [ ! -f "$state_file" ] || [ "$elapsed_min" -ge "$REALERT_MINUTES" ]; then
    "$ALERT_SCRIPT" CRIT "$check" "$message" || true
    echo "$now" >"$state_file"
  else
    log "  (suppressing repeat alert for ${check} — last sent ${elapsed_min}m ago, re-alert threshold ${REALERT_MINUTES}m)"
  fi
  return 1
}

overall_ok=true

# ---------- 1. Container health ----------
# `docker compose ps` reports one line per container with a `Status`
# field like "Up 2 hours (healthy)", "Up 3 minutes (unhealthy)",
# "Restarting (1) 5 seconds ago", or "Exited (137) 2 minutes ago" — any
# container not "Up ... (healthy)" or plain "Up ..." (no healthcheck) is
# a problem. `--format json` gives a stable machine-readable shape
# instead of scraping the human table.
bad_containers=""
if container_lines=$(compose ps --all --format json 2>/dev/null); then
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    name=$(printf '%s' "$line" | jq -r '.Name // .Names // "unknown"' 2>/dev/null)
    state=$(printf '%s' "$line" | jq -r '.State // "unknown"' 2>/dev/null)
    health=$(printf '%s' "$line" | jq -r '.Health // ""' 2>/dev/null)
    if [ "$state" != "running" ] || [ "$health" = "unhealthy" ]; then
      bad_containers="${bad_containers}${name}(state=${state},health=${health:-none}) "
    fi
  done <<<"$container_lines"
else
  bad_containers="COULD_NOT_QUERY_DOCKER_COMPOSE_PS"
fi

if [ -n "$bad_containers" ]; then
  report containers fail "unhealthy/not-running containers: $bad_containers" || overall_ok=false
else
  report containers ok "all containers in project '$PROJECT' are running/healthy"
fi

# ---------- 2. Vault seal status ----------
# Checked directly via `vault status`, independent of Docker's own health
# status (which deliberately reports a sealed vault as Docker-healthy —
# see docker-compose.yml). Exit 2 = sealed, exit 0 = unsealed, anything
# else = vault genuinely unreachable/broken (also caught by check #1
# above via its container health, but called out by name here too).
if vault_out=$(compose exec -T vault vault status -address=http://127.0.0.1:8200 -format=json 2>&1); then
  sealed=$(printf '%s' "$vault_out" | jq -r '.sealed' 2>/dev/null || echo "unknown")
  if [ "$sealed" = "true" ]; then
    report vault-sealed fail "Vault is SEALED — every S2/S3 crypto operation is returning 503. Needs a human unseal ceremony (3 key officers), not a restart. See docs/07-operations/OPERATIONS-RUNBOOK.md." || overall_ok=false
  elif [ "$sealed" = "false" ]; then
    report vault-sealed ok "Vault is unsealed"
  else
    report vault-sealed fail "could not parse 'sealed' field from vault status output: $vault_out" || overall_ok=false
  fi
else
  code=$?
  if [ "$code" = 2 ]; then
    report vault-sealed fail "Vault is SEALED (status exit 2) — every S2/S3 crypto operation is returning 503. Needs a human unseal ceremony (3 key officers), not a restart." || overall_ok=false
  else
    report vault-sealed fail "vault status failed (exit $code): $vault_out" || overall_ok=false
  fi
fi

# ---------- 3. Disk usage ----------
disk_pct=$(df -P "$DISK_PATH" 2>/dev/null | awk 'NR==2 { gsub("%","",$5); print $5 }')
if [ -z "$disk_pct" ]; then
  report disk fail "could not read disk usage for $DISK_PATH" || overall_ok=false
elif [ "$disk_pct" -ge "$MAX_DISK_PCT" ]; then
  report disk fail "disk usage on $DISK_PATH is ${disk_pct}% (>= ${MAX_DISK_PCT}% threshold)" || overall_ok=false
else
  report disk ok "disk usage on $DISK_PATH is ${disk_pct}% (< ${MAX_DISK_PCT}% threshold)"
fi

# ---------- 4. Last backup age ----------
newest_backup=""
if [ -d "$BACKUP_ROOT/daily" ]; then
  newest_backup=$(ls -1t "$BACKUP_ROOT/daily"/gadonghr-backup-*.tar.age 2>/dev/null | head -n1 || true)
fi
if [ -z "$newest_backup" ]; then
  report backup-age fail "no backup archive found under $BACKUP_ROOT/daily — has backup.sh ever run successfully?" || overall_ok=false
else
  now=$(date -u +%s)
  mtime=$(stat -c %Y "$newest_backup" 2>/dev/null || stat -f %m "$newest_backup" 2>/dev/null)
  age_hours=$(( (now - mtime) / 3600 ))
  if [ "$age_hours" -ge "$MAX_BACKUP_AGE_HOURS" ]; then
    report backup-age fail "newest backup ($newest_backup) is ${age_hours}h old (>= ${MAX_BACKUP_AGE_HOURS}h threshold) — RPO at risk" || overall_ok=false
  else
    report backup-age ok "newest backup ($newest_backup) is ${age_hours}h old (< ${MAX_BACKUP_AGE_HOURS}h threshold)"
  fi
fi

log "gadonghr-monitor run complete."
if [ "$overall_ok" = true ]; then
  exit 0
fi
exit 1
