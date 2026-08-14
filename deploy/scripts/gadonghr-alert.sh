#!/usr/bin/env bash
#
# gadonghr-alert.sh — single, shared notification path for gadonghr-prod
# (ops-hardening: "nothing pages or notifies on anything today").
#
# Usage:
#   gadonghr-alert.sh <severity> <check-name> <message...>
#
# e.g.
#   gadonghr-alert.sh CRIT vault-sealed "vault has been sealed for 2h10m"
#   gadonghr-alert.sh OK    vault-sealed "vault is unsealed again"
#
# Design, deliberately the lowest-cost honest thing (brief: "No new paid
# services, no heavyweight monitoring stack"):
#   1. ALWAYS append a timestamped line to a local log
#      ($GADONG_ALERT_LOG, default /var/log/gadonghr-alerts.log) — so the
#      alert history exists even before anyone has configured a channel,
#      and survives independently of whether the channel delivery below
#      succeeds.
#   2. The notification CHANNEL is exactly one env var,
#      $GADONG_ALERT_WEBHOOK_URL — a plain HTTP endpoint this script POSTs
#      the message to. Works as-is with an ntfy.sh topic URL
#      (https://ntfy.sh/<topic>, or a self-hosted ntfy — POSTing the raw
#      message body is ntfy's own publish contract) and with any other
#      webhook that accepts a POST body (Slack incoming webhook needs a
#      `{"text": "..."}` JSON body instead of raw text — set
#      $GADONG_ALERT_WEBHOOK_JSON=true to switch the POST body shape
#      without needing a second variable for the channel itself). If
#      unset, this script logs locally only and says so — it never
#      fails the caller just because no channel is configured yet (an
#      unconfigured channel is an onboarding step, not an outage).
#   3. No secrets are read or embedded here — the webhook URL itself is
#      the credential (ntfy topics / most webhook URLs are
#      possession-based), and it lives in .env / the environment, never
#      in this file or the repo.

set -euo pipefail

ALERT_LOG="${GADONG_ALERT_LOG:-/var/log/gadonghr-alerts.log}"

if [ "$#" -lt 3 ]; then
  echo "Usage: $0 <severity: OK|WARN|CRIT> <check-name> <message...>" >&2
  exit 2
fi

SEVERITY="$1"
CHECK="$2"
shift 2
MESSAGE="$*"
HOST="$(hostname -f 2>/dev/null || hostname)"
STAMP="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
LINE="${STAMP} [${SEVERITY}] ${CHECK}: ${MESSAGE} (host=${HOST})"

# ---------- 1. Always log locally first (this must never be skipped) ----------
mkdir -p "$(dirname "$ALERT_LOG")" 2>/dev/null || true
if ! printf '%s\n' "$LINE" >>"$ALERT_LOG" 2>/dev/null; then
  # Local log write failed (permissions, disk full, ...) — still try to
  # get the message out over the channel below, and say so on stderr so
  # a human running this by hand notices immediately.
  echo "WARNING: could not write to $ALERT_LOG — $LINE" >&2
fi

# ---------- 2. Best-effort delivery over the one configured channel ----------
if [ -z "${GADONG_ALERT_WEBHOOK_URL:-}" ]; then
  printf '%s\n' "${STAMP} [INFO] gadonghr-alert: no GADONG_ALERT_WEBHOOK_URL configured — alert above is local-log-only." >>"$ALERT_LOG" 2>/dev/null || true
  exit 0
fi

if ! command -v curl >/dev/null 2>&1; then
  printf '%s\n' "${STAMP} [WARN] gadonghr-alert: curl not installed — cannot deliver to GADONG_ALERT_WEBHOOK_URL, alert above is local-log-only." >>"$ALERT_LOG" 2>/dev/null || true
  exit 0
fi

TITLE="gadonghr-prod ${SEVERITY} ${CHECK}"
delivered=false
if [ "${GADONG_ALERT_WEBHOOK_JSON:-false}" = "true" ]; then
  # Escape only backslash and double-quote — sufficient for the plain,
  # single-line messages this script produces; not a general JSON encoder.
  json_message=$(printf '%s' "$LINE" | sed 's/\\/\\\\/g; s/"/\\"/g')
  if curl -fsS -m 10 -X POST -H 'Content-Type: application/json' \
    -d "{\"text\":\"${json_message}\"}" \
    "$GADONG_ALERT_WEBHOOK_URL" >/dev/null 2>&1; then
    delivered=true
  fi
else
  # ntfy.sh-compatible: raw POST body is the message, a Title header
  # gives it a subject line. Any webhook that accepts a bare text POST
  # body works the same way.
  if curl -fsS -m 10 -X POST -H "Title: ${TITLE}" \
    --data-binary "$LINE" \
    "$GADONG_ALERT_WEBHOOK_URL" >/dev/null 2>&1; then
    delivered=true
  fi
fi

if [ "$delivered" != true ]; then
  printf '%s\n' "${STAMP} [WARN] gadonghr-alert: delivery to GADONG_ALERT_WEBHOOK_URL failed — alert above is local-log-only for this run." >>"$ALERT_LOG" 2>/dev/null || true
fi

exit 0
