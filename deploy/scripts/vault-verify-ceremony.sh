#!/usr/bin/env bash
#
# vault-verify-ceremony.sh — a separate, READ-ONLY check the officers run
# AFTER the ceremony (vault-ceremony.sh) and after every officer has
# confirmed they can decrypt their own share. This script proves the
# ceremony actually happened and actually holds, rather than the team
# just believing it did. It never rekeys, never unseals, never writes to
# Vault, and never modifies deploy/.env — it only reads and reports.
#
# Checks, matching Runbook §2's "what to verify" exactly:
#   1. `vault status` reports Total Shares 5 / Threshold 3.
#   2. deploy/.env no longer contains VAULT_UNSEAL_KEY or VAULT_ROOT_TOKEN.
#   3. The ceremony's -backup copy has been deleted (best-effort — see
#      below; this one cannot always be proven without an admin token,
#      and says so rather than pretending certainty).
#
# Usage: ./vault-verify-ceremony.sh
# Exit 0 only if every check that CAN be verified passes.

set -euo pipefail

PROJECT="gadonghr"
DEPLOY_DIR="${GADONG_DEPLOY_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
COMPOSE_FILES=(-f "$DEPLOY_DIR/docker-compose.yml")
[ -f "$DEPLOY_DIR/docker-compose.prod.yml" ] && COMPOSE_FILES+=(-f "$DEPLOY_DIR/docker-compose.prod.yml")
ENV_FILE="$DEPLOY_DIR/.env"

EXPECT_SHARES=5
EXPECT_THRESHOLD=3

log() { printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }

compose() {
  docker compose -p "$PROJECT" "${COMPOSE_FILES[@]}" "$@"
}

for bin in docker jq; do
  command -v "$bin" >/dev/null 2>&1 || { log "ERROR: required tool '$bin' not found on PATH."; exit 1; }
done

FAIL=false

# ---------- 1. Total Shares / Threshold ----------
set +e
STATUS_JSON="$(compose exec -T vault vault status -format=json 2>&1)"
STATUS_RC=$?
set -e
if [ "$STATUS_RC" != 0 ] && [ "$STATUS_RC" != 2 ]; then
  log "ERROR: could not reach Vault ('docker compose exec vault vault status' exit ${STATUS_RC}). Output: ${STATUS_JSON}"
  exit 1
fi

TOTAL_SHARES="$(jq -r '.n // "unknown"' <<<"$STATUS_JSON" 2>/dev/null || echo unknown)"
THRESHOLD="$(jq -r '.t // "unknown"' <<<"$STATUS_JSON" 2>/dev/null || echo unknown)"
SEALED="$(jq -r '.sealed // "unknown"' <<<"$STATUS_JSON" 2>/dev/null || echo unknown)"

log "Vault status: Sealed=${SEALED}  Total Shares=${TOTAL_SHARES}  Threshold=${THRESHOLD}"

if [ "$TOTAL_SHARES" = "$EXPECT_SHARES" ] && [ "$THRESHOLD" = "$EXPECT_THRESHOLD" ]; then
  log "PASS: Total Shares=${EXPECT_SHARES}, Threshold=${EXPECT_THRESHOLD} — matches Runbook §2."
else
  log "FAIL: expected Total Shares=${EXPECT_SHARES} / Threshold=${EXPECT_THRESHOLD}, got Total Shares=${TOTAL_SHARES} / Threshold=${THRESHOLD}. Run vault-ceremony.sh (see Runbook §2) before treating this Vault as production-ready."
  FAIL=true
fi

# ---------- 2. .env no longer holds either staging key ----------
if [ -f "$ENV_FILE" ]; then
  if grep -qE '^VAULT_UNSEAL_KEY=' "$ENV_FILE" || grep -qE '^VAULT_ROOT_TOKEN=' "$ENV_FILE"; then
    log "FAIL: deploy/.env still contains VAULT_UNSEAL_KEY and/or VAULT_ROOT_TOKEN — the ceremony's .env cleanup did not complete, or someone re-added a staging key. Real employee data must not go live while this is true."
    FAIL=true
  else
    log "PASS: deploy/.env contains neither VAULT_UNSEAL_KEY nor VAULT_ROOT_TOKEN."
  fi
else
  log "WARNING: ${ENV_FILE} not found — cannot check it. If this host's .env lives elsewhere, check it by hand."
fi

# ---------- 3. -backup copy deleted ----------
# Best-effort only. `vault operator rekey -backup-retrieve` needs a token
# with sudo capability on sys/rekey/backup — by design, this Vault has NO
# standing root token by the time this script is meant to be run (Runbook
# §2 step 6: it was revoked once every officer confirmed). So a
# permission-denied response here is the EXPECTED, healthy outcome, not
# distinguishable from "already deleted" without minting a one-off token
# via `vault operator generate-root` (itself a 3-of-5 quorum action) —
# this script does not do that on your behalf. It reports what it can see
# and says plainly what it cannot.
set +e
BACKUP_JSON="$(compose exec -T vault vault operator rekey -backup-retrieve -format=json 2>&1)"
BACKUP_RC=$?
set -e
if [ "$BACKUP_RC" -eq 0 ] && jq -e '.keys // .nonce' >/dev/null 2>&1 <<<"$BACKUP_JSON"; then
  log "FAIL: the rekey -backup copy is still retrievable — it responded WITHOUT needing a token, or you have one exported. Delete it now that all 5 officers have confirmed: docker compose exec -e VAULT_TOKEN=<token> vault vault operator rekey -backup-delete"
  FAIL=true
else
  log "INFO: could not retrieve a -backup copy (exit ${BACKUP_RC}) — this is the expected result once the backup has been deleted AND/OR once the root token has been revoked, and this script cannot tell those two apart without a valid admin token. If you still hold a fresh 'vault operator generate-root' token, re-run '-backup-retrieve' with it explicitly to confirm deletion for certain. NOT scored as pass/fail."
fi

echo
if [ "$FAIL" = true ]; then
  log "vault-verify-ceremony.sh: ONE OR MORE CHECKS FAILED — see above. Do not treat the ceremony as complete."
  exit 1
fi
log "vault-verify-ceremony.sh: all verifiable checks passed."
