#!/usr/bin/env bash
#
# vault-ceremony.sh — the production Vault key ceremony: rekeys Vault from
# whatever it is initialised with today (on gadonghr-prod today: ONE
# Shamir share, threshold ONE — a staging convenience, not a production
# configuration, see `deploy/.env`'s "STAGING ONLY" block) to **5 Shamir
# unseal shares, threshold 3**, held by 5 named key officers, per Runbook
# §2 and `deploy/signoff/key-register.md`.
#
# ============================================================================
# THE MECHANISM THAT MAKES THIS SAFE: -pgp-keys
#
# `vault operator rekey` normally PRINTS every new share to stdout — the
# operator running the command (human or script) sees all five, which
# defeats the entire point of splitting them. This script never does
# that. It always calls `vault operator rekey` with `-pgp-keys=<5 officer
# public keys>`, which tells Vault itself to encrypt each of the 5 new
# shares to a different officer's PGP public key BEFORE returning them.
# What this script (and whoever runs it) ever sees or writes to disk is
# already ciphertext — decryptable only by the one officer holding the
# matching private key. This script never handles, prints, or logs a
# plaintext share, and it verifies that fact about Vault's own response
# before writing anything (see "Safety scan" below) rather than assuming
# it.
# ============================================================================
#
# THE CONSEQUENCE, STATED PLAINLY (say this in the ceremony room):
#
#   Losing 3 of the 5 shares is PERMANENT, IRREVERSIBLE loss of every
#   encrypted field in this system — national IDs, bank accounts,
#   salaries, health attachments, face-template references, all of it,
#   forever. There is no vendor backdoor. That is the design, not an
#   oversight: Shamir secret sharing with threshold 3 means no 2 people,
#   and nothing HashiCorp or GaDongHR could ever run, can reconstruct the
#   master key alone. Five named officers, three of whom must physically
#   act together, is the whole point.
#
# WHAT THIS SCRIPT DOES NOT DO:
#   - It does not run `vault operator init` — Vault on gadonghr-prod is
#     already initialised (1 share / threshold 1, staging). This is a
#     REKEY, not an init.
#   - It does not delete the `-backup` copy Vault stores server-side, and
#     it does not revoke the root token. Both are printed as manual
#     next-step commands, not run here, because both are correctly gated
#     on every one of the 5 officers first confirming they can decrypt
#     their own share — an event that cannot happen inside one
#     non-interactive script run. See the "REMAINING MANUAL STEPS" output
#     at the end of a successful run, and Runbook §2.
#
# USAGE (requires 5 human officers physically/remotely present and ready —
# do not run this alone or "to see what it does"):
#   ./vault-ceremony.sh --confirm-five-officers-present
#   ./vault-ceremony.sh --confirm-five-officers-present --force   # re-rekey an already-5-share Vault
#
# Officer public keys go in deploy/signoff/pgp-keys/<officer-slug>.asc —
# exactly 5 files, one per officer, gitignored (never committed — see
# deploy/.gitignore). Encrypted shares are written to
# deploy/signoff/shares/<officer-slug>.share.b64, mode 400, also
# gitignored.

set -euo pipefail

# ---------- Configuration ----------
PROJECT="gadonghr"
DEPLOY_DIR="${GADONG_DEPLOY_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
COMPOSE_FILES=(-f "$DEPLOY_DIR/docker-compose.yml")
[ -f "$DEPLOY_DIR/docker-compose.prod.yml" ] && COMPOSE_FILES+=(-f "$DEPLOY_DIR/docker-compose.prod.yml")
ENV_FILE="$DEPLOY_DIR/.env"
SIGNOFF_DIR="$DEPLOY_DIR/signoff"
PGP_KEYS_DIR="$SIGNOFF_DIR/pgp-keys"
SHARES_DIR="$SIGNOFF_DIR/shares"

NEW_SHARES=5
NEW_THRESHOLD=3

log() { printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }
die() { log "ERROR: $*"; exit 1; }

compose() {
  docker compose -p "$PROJECT" "${COMPOSE_FILES[@]}" "$@"
}

# ---------- Arg parsing (confirmation gate — checked FIRST, no network
# calls before this, so a bare/wrong invocation fails instantly and
# safely, including in a CI/test environment with no Vault reachable) ----------
CONFIRMED=false
FORCE=false
for arg in "$@"; do
  case "$arg" in
    --confirm-five-officers-present) CONFIRMED=true ;;
    --force) FORCE=true ;;
    -h|--help)
      cat <<'USAGE'
Usage: vault-ceremony.sh --confirm-five-officers-present [--force]

Rekeys Vault to 5 Shamir unseal shares, threshold 3, PGP-encrypted to 5
named officers. Requires all 5 officers present with their PGP public
keys already dropped in deploy/signoff/pgp-keys/. Do NOT run this alone.
USAGE
      exit 0
      ;;
    *) die "Unrecognised argument: '$arg' (see --help)" ;;
  esac
done

if [ "$CONFIRMED" != true ]; then
  die "refusing to run without --confirm-five-officers-present. This is not a formality: it exists so this script cannot rekey Vault by accident (e.g. a copy-pasted command, a CI job, a curious operator). All 5 key officers must be present, each holding their own PGP keypair, before you pass this flag. See --help."
fi

# ---------- Dependency checks ----------
for bin in docker jq base64 awk; do
  command -v "$bin" >/dev/null 2>&1 || die "required tool '$bin' not found on PATH — install it before running this ceremony."
done

# ---------- Precondition: exactly 5 PGP public key files present ----------
mapfile -t KEY_FILES < <(find "$PGP_KEYS_DIR" -maxdepth 1 -type f 2>/dev/null | sort)
if [ "${#KEY_FILES[@]}" -ne 5 ]; then
  die "expected exactly 5 PGP public key files in $PGP_KEYS_DIR, found ${#KEY_FILES[@]}. Each of the 5 key officers must export their PGP public key ('gpg --armor --export <email>') and drop it there as <officer-slug>.asc before this ceremony can run. Never a private key, never here."
fi

OFFICERS=()
for f in "${KEY_FILES[@]}"; do
  base="$(basename "$f")"
  officer="${base%.*}"
  [ -n "$officer" ] || die "could not derive an officer name from filename '$base' in $PGP_KEYS_DIR."
  [ -s "$f" ] || die "PGP key file '$f' is empty."

  # Loud safety net: catch the single most likely ceremony mistake — an
  # officer (or the operator) accidentally supplying a PRIVATE key
  # instead of a public one. A private key here would mean Vault
  # encrypts a share to a key whose secret half is now sitting on THIS
  # host, in this directory — exactly the "share on the host" failure
  # mode the standing rules (key-register.md) exist to prevent.
  if grep -qi "PRIVATE KEY" "$f"; then
    die "PGP key file '$f' looks like a PRIVATE key (contains 'PRIVATE KEY'). This ceremony only ever takes PUBLIC keys. Aborting before touching Vault — nothing was sent, nothing was written."
  fi
  # Loose shape check: armored ASCII header, or the low first bytes of a
  # binary OpenPGP public-key packet. Not a full OpenPGP parse (no
  # dependency on gpg being installed) — just enough to catch "someone
  # dropped the wrong kind of file in this directory" before Vault does.
  if ! grep -q "BEGIN PGP PUBLIC KEY BLOCK" "$f" && ! head -c1 "$f" | od -An -tu1 | grep -qE '^\s*(153|152|9[0-9])$'; then
    die "PGP key file '$f' does not look like an ASCII-armored or binary OpenPGP PUBLIC key. Re-export with 'gpg --armor --export <officer-email>' and try again."
  fi
  OFFICERS+=("$officer")
done
log "5 officer PGP public keys found: ${OFFICERS[*]}"

# ---------- Precondition: unseal key + root token available (sourced .env) ----------
: "${VAULT_UNSEAL_KEY:?VAULT_UNSEAL_KEY must be set (source deploy/.env first) — the CURRENT Vault unseal share, needed to authorise the rekey. This script reads it from the environment only; it is never a literal in this file.}"
: "${VAULT_ROOT_TOKEN:?VAULT_ROOT_TOKEN must be set (source deploy/.env first) — not used to run the rekey itself (Shamir unseal keys authorise rekey, not tokens), but needed AFTER every officer confirms decryption to delete the -backup copy and revoke this token. See the printed steps at the end of this run.}"
log "IMPORTANT: VAULT_ROOT_TOKEN is about to be removed from deploy/.env and this is the last time this script will point at it. If you have not already saved a copy somewhere secure (password manager, not chat/email), do that NOW in a separate terminal — you will need it again, later, after all 5 officers confirm they can decrypt their share, to delete the rekey backup and revoke this token. This script does not print the value."

# ---------- Precondition: Vault reachable and unsealed ----------
set +e
STATUS_JSON="$(compose exec -T vault vault status -format=json 2>&1)"
STATUS_RC=$?
set -e
case "$STATUS_RC" in
  0) : ;; # unsealed
  2) die "Vault is SEALED. Gather the officers holding the current threshold and unseal first (Runbook §2) before running this ceremony." ;;
  *) die "Vault is not reachable via 'docker compose exec vault vault status' (exit ${STATUS_RC}). Is the vault container up? Output was: ${STATUS_JSON}" ;;
esac

INITIALIZED="$(jq -r '.initialized // false' <<<"$STATUS_JSON")"
SEALED="$(jq -r '.sealed // true' <<<"$STATUS_JSON")"
CURRENT_N="$(jq -r '.n // 0' <<<"$STATUS_JSON")"
CURRENT_T="$(jq -r '.t // 0' <<<"$STATUS_JSON")"
[ "$INITIALIZED" = true ] || die "Vault reports initialized=false — this script rekeys an already-initialised Vault, it does not run 'vault operator init'."
[ "$SEALED" = false ] || die "Vault reports sealed=true after a 0 exit — unexpected, aborting rather than guessing."
log "Vault reachable, unsealed, initialized. Current: ${CURRENT_N} shares, threshold ${CURRENT_T}."

# ---------- Idempotency guard ----------
if [ "$CURRENT_N" -eq "$NEW_SHARES" ] && [ "$FORCE" != true ]; then
  die "Vault already has ${CURRENT_N} shares (threshold ${CURRENT_T}) — this looks like the ceremony already ran. Refusing to rekey an already-ceremonied Vault. If you genuinely mean to re-rekey (e.g. replacing an officer), get explicit agreement from all current officers first, then re-run with --force — this invalidates every existing share."
fi

# ---------- Cancel any stale, incomplete previous rekey attempt ----------
# Safe: cancelling a not-yet-complete rekey discards only the pending
# init state (new key-shares/threshold/pgp-keys parameters), never any
# existing unseal key or KEK. It does NOT touch encrypted data.
REKEY_STATUS_JSON="$(compose exec -T vault vault operator rekey -status -format=json 2>&1)" || true
if [ -n "$REKEY_STATUS_JSON" ] && [ "$(jq -r '.started // false' <<<"$REKEY_STATUS_JSON" 2>/dev/null || echo false)" = true ]; then
  log "Found an incomplete previous rekey attempt (nonce $(jq -r '.nonce // "unknown"' <<<"$REKEY_STATUS_JSON")) — cancelling it before starting a fresh one."
  compose exec -T vault vault operator rekey -cancel >/dev/null
fi

# ---------- Stage the 5 officer public keys inside the vault container ----------
# `vault operator rekey -pgp-keys` takes file PATHS, which must be
# visible to the `vault` binary — i.e. inside the container. We do NOT
# add a new bind mount for this (constraint: do not modify compose) —
# `docker compose cp` stages them at runtime instead, and they are
# removed again immediately after use. These are PUBLIC keys; there is
# no confidentiality requirement here, only tidiness.
CONTAINER_PATHS=()
for i in "${!KEY_FILES[@]}"; do
  cpath="/tmp/gadonghr-ceremony-pgp-${i}.asc"
  compose cp "${KEY_FILES[$i]}" "vault:${cpath}"
  CONTAINER_PATHS+=("$cpath")
done
cleanup_staged_keys() {
  compose exec -T vault rm -f /tmp/gadonghr-ceremony-pgp-*.asc >/dev/null 2>&1 || true
}
trap cleanup_staged_keys EXIT

PGP_KEYS_ARG="$(IFS=,; echo "${CONTAINER_PATHS[*]}")"

# ---------- Step 1: vault operator rekey -init ----------
log "Starting rekey: ${NEW_SHARES} shares, threshold ${NEW_THRESHOLD}, PGP-encrypted to ${#OFFICERS[@]} officers, -backup enabled (ceremony-window-only recovery)."
INIT_JSON="$(compose exec -T vault vault operator rekey \
  -init -format=json \
  -key-shares="$NEW_SHARES" \
  -key-threshold="$NEW_THRESHOLD" \
  -backup \
  -pgp-keys="$PGP_KEYS_ARG")"

cleanup_staged_keys
trap - EXIT

[ "$(jq -r '.started // false' <<<"$INIT_JSON")" = true ] || die "rekey -init did not report started=true. Aborting — nothing was written."
[ "$(jq -r '.backup // false' <<<"$INIT_JSON")" = true ] || die "rekey -init did not confirm -backup was accepted. Aborting rather than proceeding without a recoverable backup for the ceremony window."
INIT_FP_COUNT="$(jq -r '.pgp_fingerprints | length' <<<"$INIT_JSON")"
[ "$INIT_FP_COUNT" -eq 5 ] || die "rekey -init reports ${INIT_FP_COUNT} PGP fingerprints, expected 5. Aborting — the -pgp-keys arguments were not accepted as expected."
NONCE="$(jq -r '.nonce' <<<"$INIT_JSON")"
REQUIRED="$(jq -r '.required' <<<"$INIT_JSON")"
[ -n "$NONCE" ] && [ "$NONCE" != null ] || die "rekey -init returned no nonce. Aborting."
log "Rekey initialised (nonce ${NONCE}). ${REQUIRED} of the CURRENT ${CURRENT_T} unseal key(s) required to authorise."

# ---------- Step 2: submit the current unseal key over stdin (never as a
# CLI argument, so it never appears in this container's process list) ----------
UPDATE_JSON="$(printf '%s\n' "$VAULT_UNSEAL_KEY" | compose exec -T vault vault operator rekey -nonce="$NONCE" -format=json)"

if [ "$(jq -r '.complete // false' <<<"$UPDATE_JSON")" != true ]; then
  PROGRESS="$(jq -r '.progress // "?"' <<<"$UPDATE_JSON")"
  die "rekey did not complete (progress ${PROGRESS}/${REQUIRED}). This should not happen when the current threshold is 1 and one key was submitted — check the key is correct. The pending operation is still open; run 'docker compose exec vault vault operator rekey -status' to inspect it, or '-cancel' to abandon it. Nothing was written by this script."
fi

# ---------- Safety scan: refuse to proceed if anything looks unencrypted ----------
# This is the check that makes good on "if Vault returns anything
# unencrypted, abort and say so" — it runs BEFORE any file is written.
FP_COUNT="$(jq -r '.pgp_fingerprints | length' <<<"$UPDATE_JSON")"
KEY_COUNT="$(jq -r '.keys_base64 | length' <<<"$UPDATE_JSON")"
if [ "$FP_COUNT" -ne 5 ] || [ "$KEY_COUNT" -ne 5 ]; then
  die "rekey completed but returned ${FP_COUNT} PGP fingerprints / ${KEY_COUNT} encrypted shares — expected 5 of each. ABORTING before writing any file. This Vault's key material is now in an unknown state — do not assume the old or new keys are valid; get help before touching it again."
fi
for i in $(seq 0 4); do
  b64_val="$(jq -r ".keys_base64[$i]" <<<"$UPDATE_JSON")"
  byte_len="$(printf '%s' "$b64_val" | base64 -d 2>/dev/null | wc -c | tr -d '[:space:]')"
  # A raw Shamir share (what -pgp-keys exists specifically to prevent
  # this script from ever seeing) is on the order of 32-64 bytes. A
  # PGP-encrypted envelope around one is far larger. This is a coarse,
  # deliberately conservative sanity check, not a substitute for the
  # -pgp-keys mechanism itself — if this ever trips, something upstream
  # of this script has already gone wrong.
  if [ -z "$byte_len" ] || [ "$byte_len" -lt 100 ]; then
    die "share at index $i decodes to only ${byte_len} bytes — too short to be a PGP-encrypted envelope, and this script refuses to assume it is safe. ABORTING before writing any file. Nothing was logged or printed beyond this length. Do not re-run blindly — investigate why Vault's response looked unencrypted before trying again."
  fi
done
log "Safety scan passed: all 5 returned shares are PGP-encrypted envelopes (fingerprints present, ciphertext-length shares)."

# ---------- Write each officer's encrypted share, mode 400 ----------
mkdir -p "$SHARES_DIR"
umask 0377
for i in "${!OFFICERS[@]}"; do
  officer="${OFFICERS[$i]}"
  fp="$(jq -r ".pgp_fingerprints[$i]" <<<"$UPDATE_JSON")"
  out="$SHARES_DIR/${officer}.share.b64"
  jq -r ".keys_base64[$i]" <<<"$UPDATE_JSON" >"$out"
  chmod 400 "$out"
  log "Wrote encrypted share for '${officer}' -> ${out} (PGP fingerprint ${fp}). Decrypt with: base64 -d ${officer}.share.b64 | gpg --decrypt"
done

# Best-effort scrub of ceremony JSON from this shell's memory. Bash
# cannot guarantee this actually clears the underlying memory pages —
# said plainly rather than implied as a real security boundary.
unset INIT_JSON UPDATE_JSON STATUS_JSON REKEY_STATUS_JSON b64_val

# ---------- Remove the staging keys (and their warning block) from .env ----------
if [ -f "$ENV_FILE" ]; then
  TMP_ENV="$(mktemp "${TMPDIR:-/tmp}/gadonghr-env.XXXXXX")"
  # Deliberately NO .env.bak here: a backup copy would just relocate the
  # plaintext secrets we are removing, not eliminate them. Drops (a) any
  # comment block containing the literal "STAGING ONLY" marker, wherever
  # it appears, and (b) any VAULT_UNSEAL_KEY=/VAULT_ROOT_TOKEN= line,
  # wherever it appears — not just when physically adjacent.
  awk '
    /^#/ { buf = buf $0 "\n"; in_comment = 1; next }
    {
      if (in_comment) {
        if (buf !~ /STAGING ONLY/) printf "%s", buf
        buf = ""; in_comment = 0
      }
      if ($0 ~ /^VAULT_UNSEAL_KEY=/ || $0 ~ /^VAULT_ROOT_TOKEN=/) next
      print
    }
    END { if (in_comment && buf !~ /STAGING ONLY/) printf "%s", buf }
  ' "$ENV_FILE" >"$TMP_ENV"
  ORIG_MODE="$(stat -f '%Lp' "$ENV_FILE" 2>/dev/null || stat -c '%a' "$ENV_FILE" 2>/dev/null || echo 600)"
  mv "$TMP_ENV" "$ENV_FILE"
  chmod "$ORIG_MODE" "$ENV_FILE"
  log "Removed VAULT_UNSEAL_KEY, VAULT_ROOT_TOKEN, and the 'STAGING ONLY' warning block from ${ENV_FILE}."
else
  log "WARNING: ${ENV_FILE} not found — nothing to clean up there. If the staging keys live somewhere else, remove them by hand now."
fi

# ---------- Summary ----------
cat <<EOF

=== Vault ceremony complete: ${NEW_SHARES} shares, threshold ${NEW_THRESHOLD} ===

THE CONSEQUENCE, AGAIN, PLAINLY: losing 3 of these 5 shares is permanent,
irreversible loss of every encrypted field in GaDongHR. There is no
vendor backdoor. This is the design, not an oversight.

Encrypted shares written (mode 400), one per officer:
$(for o in "${OFFICERS[@]}"; do echo "  - ${SHARES_DIR}/${o}.share.b64"; done)

=== REMAINING MANUAL STEPS (this script does none of these for you) ===

1. Hand each officer THEIR OWN share file only, via an approved secure
   channel — in person, or an encrypted channel you already trust with
   this class of secret. NEVER chat, NEVER email, even though the file
   is ciphertext (see deploy/signoff/key-register.md's standing rules).
   No officer receives more than one share.

2. Each officer decrypts and verifies THEIR OWN share, in private, with
   their own PGP private key:
     base64 -d <officer>.share.b64 | gpg --decrypt
   and signs deploy/signoff/key-register.md confirming receipt and
   successful decryption, with the date.

3. Delete every file under ${SHARES_DIR} from THIS host once every
   officer has confirmed — they must not linger here (key-register.md
   rule: shares never on the host).

4. Run ./vault-verify-ceremony.sh to confirm Vault now reports 5 shares /
   threshold 3, and that deploy/.env no longer has either staging key.

5. ONLY once ALL 5 officers have confirmed step 2 — not before — destroy
   the -backup copy (it exists solely to recover a lost share during
   this ceremony window; leaving it after every officer has their own
   share defeats the purpose of the split):
     docker compose exec -e VAULT_TOKEN="\$VAULT_ROOT_TOKEN" vault vault operator rekey -backup-delete

6. Then revoke the initial root token — there is no further standing use
   for it. Any future admin operation that genuinely needs Vault-level
   access (policy changes, secrets-engine mounts) should go through
   'vault operator generate-root', which itself requires a fresh quorum
   of 3 of the 5 officers' shares — the same trust model as unsealing,
   deliberately, rather than a long-lived credential sitting in .env
   again:
     docker compose exec -e VAULT_TOKEN="\$VAULT_ROOT_TOKEN" vault vault token revoke -self

   \$VAULT_ROOT_TOKEN is no longer in deploy/.env (removed above). If you
   did not already save it before running this script, it still exists
   in this shell's exported environment for as long as this terminal
   session stays open — do not close it until steps 5-6 are done, or you
   will need help retrieving it.

EOF
