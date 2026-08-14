#!/usr/bin/env bash
#
# install-ops-hardening.sh — one idempotent install step so a rebuilt
# droplet gets the ops-hardening gear from `git clone`, not from a human
# remembering what was done by hand last time (ops-hardening brief:
# "Anything you install on the server must also exist in the repo").
#
# Run once (safe to re-run) as root on gadonghr-prod, from anywhere:
#   /path/to/GaDongHR/deploy/scripts/install-ops-hardening.sh
#
# What it does:
#   1. Installs `age` via apt if missing — deploy/scripts/backup.sh has
#      hard-required it since Task 13, but nothing ever installed it on
#      this host, so it could not have produced a single working archive
#      until this ran (see the ops-hardening report for how this was
#      found).
#   2. Renders the four systemd unit templates in deploy/systemd/
#      (`__GADONG_DEPLOY_DIR__` -> this checkout's real, absolute
#      deploy/ path — self-detected the same way every other script in
#      this directory detects it, so this works whether the repo lives
#      at /opt/gadonghr, /root/GaDongHR, or anywhere else) into
#      /etc/systemd/system/, then `daemon-reload` and
#      `enable --now` both timers.
#   3. Creates the local alert log and monitor state directory with sane
#      ownership before the first timer run needs them.
#
# Idempotent: re-running after a `git pull` re-renders the unit files
# (picking up any changes committed to deploy/systemd/) and re-enables
# the timers — safe to put in a post-deploy step later if desired, not
# wired into auto-deploy-gadonghr.sh here (out of scope — another change
# owns that script).

set -euo pipefail

DEPLOY_DIR="${GADONG_DEPLOY_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
SYSTEMD_SRC_DIR="$DEPLOY_DIR/systemd"
SYSTEMD_DST_DIR="${GADONG_SYSTEMD_DST_DIR:-/etc/systemd/system}"
ALERT_LOG="${GADONG_ALERT_LOG:-/var/log/gadonghr-alerts.log}"
MONITOR_STATE_DIR="${GADONG_MONITOR_STATE_DIR:-/var/lib/gadonghr-monitor}"

log() { printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }

if [ "$(id -u)" != 0 ]; then
  echo "install-ops-hardening.sh must run as root (installs packages, writes /etc/systemd/system)." >&2
  exit 1
fi

# ---------- 1. `jq` + `curl` (gadonghr-monitor.sh / gadonghr-alert.sh hard-require them) ----------
# Both happened to already be present on gadonghr-prod, but nothing in
# this repo installed them — a rebuilt droplet needs this step too.
for pkg in jq curl; do
  if ! command -v "$pkg" >/dev/null 2>&1; then
    log "Installing '$pkg' (apt)..."
    if command -v apt-get >/dev/null 2>&1; then
      apt-get update -qq && apt-get install -y -qq "$pkg"
    else
      echo "ERROR: apt-get not found and '$pkg' is not installed — install it manually." >&2
      exit 1
    fi
  fi
done

# ---------- 1b. `age` (backup.sh hard-requires it, nothing installed it before) ----------
if ! command -v age >/dev/null 2>&1; then
  log "Installing 'age' (apt) — deploy/scripts/backup.sh cannot encrypt any archive without it..."
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq && apt-get install -y -qq age
  else
    echo "ERROR: apt-get not found and 'age' is not installed — install it manually (https://github.com/FiloSottile/age) before backups can run." >&2
    exit 1
  fi
  command -v age >/dev/null 2>&1 || { echo "ERROR: 'age' install appeared to succeed but the binary still isn't on PATH." >&2; exit 1; }
  log "age installed: $(age --version 2>&1 | head -n1)"
else
  log "age already installed: $(command -v age)"
fi

# ---------- 2. Render + install systemd units ----------
mkdir -p "$SYSTEMD_DST_DIR"
for unit in "$SYSTEMD_SRC_DIR"/gadonghr-*.service "$SYSTEMD_SRC_DIR"/gadonghr-*.timer; do
  [ -f "$unit" ] || continue
  name="$(basename "$unit")"
  dest="$SYSTEMD_DST_DIR/$name"
  sed "s#__GADONG_DEPLOY_DIR__#${DEPLOY_DIR}#g" "$unit" >"$dest"
  chmod 644 "$dest"
  log "Installed $dest"
done

systemctl daemon-reload

# ---------- 3. State locations, correct perms before the first run ----------
mkdir -p "$(dirname "$ALERT_LOG")" "$MONITOR_STATE_DIR"
touch "$ALERT_LOG"
chmod 640 "$ALERT_LOG"

# ---------- 4. Enable + start both timers ----------
systemctl enable --now gadonghr-monitor.timer
systemctl enable --now gadonghr-backup.timer

log "gadonghr-monitor.timer and gadonghr-backup.timer enabled."
log "Next runs:"
systemctl list-timers gadonghr-monitor.timer gadonghr-backup.timer --no-pager || true

cat <<EOF

Install complete. To wire alerts to a real channel (ntfy.sh, Slack
webhook, etc.), set GADONG_ALERT_WEBHOOK_URL (and, for a JSON-body
webhook like Slack, GADONG_ALERT_WEBHOOK_JSON=true) in
${DEPLOY_DIR}/.env, then re-run this script (or just wait for the next
scheduled run — no restart of anything else needed, gadonghr-alert.sh
reads it fresh every invocation). Until then, every alert still lands in
${ALERT_LOG} (local-log-only), per that script's own header.

Verify by hand any time:
  ${DEPLOY_DIR}/scripts/gadonghr-monitor.sh
  systemctl status gadonghr-monitor.timer gadonghr-backup.timer
  tail -n 20 ${ALERT_LOG}
EOF
