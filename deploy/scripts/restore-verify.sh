#!/usr/bin/env bash
#
# restore-verify.sh — ops-hardening gap #4b: "An untested backup is not a
# backup" (backup.sh's own header, verbatim) — until this script existed
# and had been run at least once, every archive backup.sh ever produced
# was UNVERIFIED. This is the quarterly-restore-drill tool
# deploy/README.md's "Out of scope" section and backup.sh's header both
# pointed at and said did not exist yet.
#
# Usage:
#   restore-verify.sh <archive.tar.age> --age-key-file <path-to-age-identity> \
#       [--vault-unseal-key <key>]... [--keep-on-failure]
#
#   <archive.tar.age>       A real encrypted archive produced by backup.sh
#                            (e.g. /opt/gadonghr/backups/daily/gadonghr-backup-*.tar.age).
#   --age-key-file <path>   File containing the `age` PRIVATE key (identity)
#                            that decrypts the archive — NEVER passed as a
#                            bare CLI argument (would land in the process
#                            list / shell history, same discipline as
#                            vault-ceremony.sh's unseal-key handling).
#   --vault-unseal-key      Optional, repeatable. Only relevant if the
#                            given archive actually contains a real
#                            `vault.snap` (it will not, today, on
#                            gadonghr-prod — VAULT_TOKEN is not yet
#                            provisioned there, a pre-existing gap
#                            backup.sh's own header already documents as
#                            out of scope of this task). Supplying real
#                            key-officer shares here is how a REAL
#                            quarterly drill (Runbook Sec.3: "unseal with
#                            3 key officers") would exercise that archive's
#                            actual snapshot.
#   --keep-on-failure        Do not tear down the throwaway containers/
#                            volumes/network if a check fails, so a human
#                            can `docker exec` in and look around.
#
# What this proves, structurally isolated from production the whole time:
#   1. Postgres: the archive's `postgres.dump` restores cleanly into a
#      THROWAWAY Postgres container, and every table's row count matches
#      `manifest.json` (backup.sh, ops-hardening) — a byte-count-matches
#      check would not catch "the dump restored but is missing rows";
#      this does.
#   2. Vault: proves the raft-snapshot-restore-then-unseal MECHANISM
#      itself, end to end, using a throwaway, freshly-initialised staging
#      Vault whose own newly-generated unseal key is used to write a
#      canary secret, snapshot it, and then unseal a SECOND throwaway
#      Vault that the snapshot was restored into — proving restore
#      genuinely reproduces state that unseals and reads back correctly.
#      Also attempts a REAL restore of the archive's own `vault.snap`
#      if one is present AND `--vault-unseal-key` was supplied.
#   3. MinIO: the archive's mirrored bucket directory is enumerated and
#      its contents listed/counted — no live MinIO server needed for
#      this, `mc mirror` already left it as plain files on disk.
#
# STRUCTURAL isolation from production (not just care — every name below
# is asserted to carry this run's unique, non-"gadonghr" prefix before
# any docker command touches it; see assert_isolated_name()):
#   - This script NEVER calls `docker compose -p gadonghr` or anything
#     naming the production project. It uses plain `docker run`/`docker
#     volume create`/`docker network create` with explicit, randomised,
#     prefixed names for every resource it touches.
#   - Every volume/container/network name is prefixed
#     `gadonghr-restore-verify-<run-id>-...`, where <run-id> includes the
#     process PID and a timestamp — it can never collide with production's
#     actual resource names (`gadonghr_pg_data`, `gadonghr-vault-1`, etc.,
#     which Compose derives from the fixed project name `gadonghr` this
#     script never uses).
#   - Everything created here is torn down in a trap on EXIT (success,
#     failure, or Ctrl-C) unless --keep-on-failure was passed and the run
#     actually failed.

set -uo pipefail  # not -e: this script must run every check and report all failures, not stop at the first

# ---------- Arg parsing ----------
ARCHIVE=""
AGE_KEY_FILE=""
VAULT_UNSEAL_KEYS=()
KEEP_ON_FAILURE=false

while [ "$#" -gt 0 ]; do
  case "$1" in
    --age-key-file)
      AGE_KEY_FILE="${2:?--age-key-file needs a path}"
      shift 2
      ;;
    --vault-unseal-key)
      VAULT_UNSEAL_KEYS+=("${2:?--vault-unseal-key needs a value}")
      shift 2
      ;;
    --keep-on-failure)
      KEEP_ON_FAILURE=true
      shift
      ;;
    -*)
      echo "Unrecognised argument: $1" >&2
      exit 2
      ;;
    *)
      if [ -z "$ARCHIVE" ]; then
        ARCHIVE="$1"
      else
        echo "Unexpected extra positional argument: $1" >&2
        exit 2
      fi
      shift
      ;;
  esac
done

if [ -z "$ARCHIVE" ] || [ -z "$AGE_KEY_FILE" ]; then
  cat >&2 <<USAGE
Usage: $0 <archive.tar.age> --age-key-file <path> [--vault-unseal-key <key>]... [--keep-on-failure]
USAGE
  exit 2
fi
[ -f "$ARCHIVE" ] || { echo "ERROR: archive not found: $ARCHIVE" >&2; exit 1; }
[ -f "$AGE_KEY_FILE" ] || { echo "ERROR: age key file not found: $AGE_KEY_FILE" >&2; exit 1; }

for bin in docker age tar; do
  command -v "$bin" >/dev/null 2>&1 || { echo "ERROR: '$bin' is required and not on PATH." >&2; exit 1; }
done

log() { printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }
pass() { log "PASS: $*"; }
fail() { log "FAIL: $*"; OVERALL_OK=false; }

OVERALL_OK=true
RUN_ID="restore-verify-$(date -u '+%Y%m%dT%H%M%SZ')-$$"
PREFIX="gadonghr-${RUN_ID}"
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/${PREFIX}.XXXXXX")"

# Every docker resource name this script will ever create is routed
# through this assertion first — refuses to run against anything that
# isn't unambiguously this run's own, uniquely-prefixed, throwaway name.
# This is the structural (not "be careful") guarantee that this script
# can never address a production resource: `gadonghr_pg_data` (the real
# volume) does not start with this prefix, and neither does any name a
# typo could plausibly produce, because the prefix embeds this process's
# PID and a timestamp no human or accident types by hand.
assert_isolated_name() {
  local name="$1"
  case "$name" in
    "${PREFIX}"*) : ;;
    *)
      echo "REFUSING to operate on '$name' — does not carry this run's isolation prefix ('${PREFIX}'). This is the structural guard against ever touching a production resource; aborting." >&2
      exit 1
      ;;
  esac
}

NETWORK="${PREFIX}-net"
CREATED_CONTAINERS=()
CREATED_VOLUMES=()
CREATED_NETWORK=false

dcreate_network() {
  assert_isolated_name "$NETWORK"
  docker network create "$NETWORK" >/dev/null
  CREATED_NETWORK=true
}

dcreate_volume() {
  local vol="$1"
  assert_isolated_name "$vol"
  docker volume create "$vol" >/dev/null
  CREATED_VOLUMES+=("$vol")
}

drun() {
  local name="$1"
  shift
  assert_isolated_name "$name"
  docker run -d --name "$name" --network "$NETWORK" "$@" >/dev/null
  CREATED_CONTAINERS+=("$name")
}

cleanup() {
  if [ "$KEEP_ON_FAILURE" = true ] && [ "$OVERALL_OK" = false ]; then
    log "--keep-on-failure set and at least one check failed — leaving containers/volumes/network in place for inspection:"
    printf '  container: %s\n' "${CREATED_CONTAINERS[@]:-}"
    printf '  volume:    %s\n' "${CREATED_VOLUMES[@]:-}"
    [ "$CREATED_NETWORK" = true ] && echo "  network:   $NETWORK"
    log "Clean up by hand with: docker rm -f ${CREATED_CONTAINERS[*]:-}; docker volume rm ${CREATED_VOLUMES[*]:-}; docker network rm $NETWORK"
  else
    for c in "${CREATED_CONTAINERS[@]:-}"; do
      [ -n "$c" ] && docker rm -f "$c" >/dev/null 2>&1 || true
    done
    for v in "${CREATED_VOLUMES[@]:-}"; do
      [ -n "$v" ] && docker volume rm "$v" >/dev/null 2>&1 || true
    done
    [ "$CREATED_NETWORK" = true ] && docker network rm "$NETWORK" >/dev/null 2>&1 || true
  fi
  # Decrypted plaintext (postgres.dump, vault.snap, minio/, the age
  # identity never lived here) never survives this script.
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

wait_for() {
  # wait_for <description> <max-seconds> <command...>
  local desc="$1" max="$2"
  shift 2
  local waited=0
  until "$@" >/dev/null 2>&1; do
    waited=$((waited + 2))
    if [ "$waited" -ge "$max" ]; then
      log "TIMEOUT waiting for: $desc"
      return 1
    fi
    sleep 2
  done
  return 0
}

log "=== restore-verify.sh run ${RUN_ID} ==="
log "Archive: $ARCHIVE"

# ---------- Decrypt + extract ----------
log "Decrypting archive with the supplied age identity..."
if ! age -d -i "$AGE_KEY_FILE" -o "$WORKDIR/archive.tar" "$ARCHIVE"; then
  fail "age decryption failed — wrong key file, or a corrupted archive."
  exit 1
fi
mkdir -p "$WORKDIR/extracted"
tar -C "$WORKDIR/extracted" -xf "$WORKDIR/archive.tar"
pass "archive decrypted and extracted"

# ============================================================
# 1. Postgres: restore + row-count-vs-manifest
# ============================================================
log "--- Postgres restore ---"
if [ ! -f "$WORKDIR/extracted/postgres.dump" ]; then
  fail "archive has no postgres.dump — nothing to restore."
elif [ ! -f "$WORKDIR/extracted/manifest.json" ]; then
  fail "archive has no manifest.json — cannot verify row counts (this archive predates the ops-hardening manifest step in backup.sh; re-run backup.sh to produce one)."
else
  dcreate_network
  PG_VOL="${PREFIX}-pgdata"
  PG_C="${PREFIX}-pg"
  dcreate_volume "$PG_VOL"
  drun "$PG_C" -v "${PG_VOL}:/var/lib/postgresql/data" \
    -e POSTGRES_USER=restoreverify -e POSTGRES_PASSWORD=restoreverify -e POSTGRES_DB=restoreverify \
    postgres:16

  if wait_for "postgres ready" 90 docker exec "$PG_C" pg_isready -U restoreverify -d restoreverify; then
    if docker exec -i "$PG_C" pg_restore --no-owner --no-acl -U restoreverify -d restoreverify \
      <"$WORKDIR/extracted/postgres.dump" 2>"$WORKDIR/pg_restore.err"; then
      pass "pg_restore completed"
    else
      # pg_restore exits non-zero on ANY warning (e.g. an owner role that
      # doesn't exist in this throwaway db, expected with --no-owner) as
      # well as on a real failure — so this is a soft signal, logged, not
      # an immediate fail; the row-count check below is the real proof.
      log "pg_restore reported warnings/errors (often expected with --no-owner against a throwaway db — see below), continuing to the row-count check:"
      sed 's/^/    /' "$WORKDIR/pg_restore.err" | head -n 20
    fi

    log "Comparing restored row counts against manifest.json..."
    mismatches=0
    checked=0
    while IFS= read -r row; do
      schema=$(printf '%s' "$row" | jq -r '.schema')
      table=$(printf '%s' "$row" | jq -r '.table')
      expected=$(printf '%s' "$row" | jq -r '.row_count')
      [ "$expected" = "-1" ] && continue # backup.sh couldn't count this table either — nothing to compare
      actual=$(docker exec "$PG_C" psql -U restoreverify -d restoreverify -Atc \
        "SELECT count(*) FROM \"${schema}\".\"${table}\"" 2>/dev/null || echo "ERROR")
      checked=$((checked + 1))
      if [ "$actual" = "$expected" ]; then
        log "  OK    ${schema}.${table}: ${actual} rows (manifest: ${expected})"
      else
        log "  MISMATCH ${schema}.${table}: restored=${actual} manifest=${expected}"
        mismatches=$((mismatches + 1))
      fi
    done < <(jq -c '.tables[]' "$WORKDIR/extracted/manifest.json" 2>/dev/null)

    if [ "$checked" -eq 0 ]; then
      fail "manifest.json contained no comparable tables — nothing was actually verified."
    elif [ "$mismatches" -eq 0 ]; then
      pass "Postgres restore verified: ${checked}/${checked} tables match the manifest's row counts"
    else
      fail "Postgres restore: ${mismatches}/${checked} tables do NOT match the manifest's row counts"
    fi
  else
    fail "throwaway Postgres never became ready — could not attempt restore."
  fi
fi

# ============================================================
# 2. MinIO: objects present in the archive's mirrored bucket
# ============================================================
log "--- MinIO mirror contents ---"
if [ -d "$WORKDIR/extracted/minio" ]; then
  count=$(find "$WORKDIR/extracted/minio" -type f | wc -l | tr -d ' ')
  size=$(du -sh "$WORKDIR/extracted/minio" 2>/dev/null | cut -f1)
  if [ "$count" -gt 0 ]; then
    pass "MinIO mirror present: ${count} object(s), ${size} total"
    find "$WORKDIR/extracted/minio" -type f | sed 's/^/    /' | head -n 20
  else
    log "MinIO mirror directory exists but is EMPTY — not necessarily a failure (backup.sh's own comment: 'not fatal on day one' if the bucket had nothing in it yet at backup time), but recorded, not silently passed."
  fi
else
  fail "archive has no minio/ directory at all — the mirror step did not run or did not copy out of the container when this backup was made."
fi

# ============================================================
# 3. Vault: prove the raft-snapshot restore+unseal mechanism
# ============================================================
log "--- Vault restore ---"

# A real (non-dev) raft-backed throwaway Vault, config rendered fresh per
# run into $WORKDIR — mirrors vault.hcl's own raft/listener/disable_mlock
# shape (deploy/vault/vault.hcl), scaled down to single-node with no
# audit device, because this is a disposable process that lives for one
# script run.
render_vault_config() {
  local node_id="$1" out="$2"
  cat >"$out" <<EOF
storage "raft" {
  path    = "/vault/data"
  node_id = "${node_id}"
}
listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = true
}
api_addr     = "http://127.0.0.1:8200"
cluster_addr = "http://127.0.0.1:8201"
disable_mlock = true
ui = false
EOF
}

run_real_vault() {
  # run_real_vault <container-name> <volume-name> <node-id>
  local name="$1" vol="$2" node_id="$3"
  local cfg="$WORKDIR/${name}.hcl"
  render_vault_config "$node_id" "$cfg"
  dcreate_volume "$vol"
  assert_isolated_name "$name"
  docker run -d --name "$name" --network "$NETWORK" \
    -v "${vol}:/vault/data" \
    -v "${cfg}:/vault/config/vault.hcl:ro" \
    -e SKIP_SETCAP=true \
    --entrypoint /bin/sh \
    hashicorp/vault:1.17 \
    -ec 'chown -R vault:vault /vault/data; exec docker-entrypoint.sh vault server -config=/vault/config/vault.hcl' >/dev/null
  CREATED_CONTAINERS+=("$name")
}

vault_ok=false

# --- 2a. Synthetic staging drill: proves restore+unseal actually works,
#     end to end, independent of whether today's real prod archive has a
#     vault.snap yet (it does not — see this script's header).
STAGE_C="${PREFIX}-vault-stage"
TARGET_C="${PREFIX}-vault-target"
STAGE_VOL="${PREFIX}-vault-stage-data"
TARGET_VOL="${PREFIX}-vault-target-data"

log "Running a self-contained synthetic Vault stage->snapshot->restore->unseal drill (proves the mechanism; does not touch production Vault or its real keys)..."
run_real_vault "$STAGE_C" "$STAGE_VOL" "stage-node"

# `vault status` exits 0 (unsealed) or 2 (sealed/uninitialized) once the
# listener is actually up — `wait_for`'s plain "exit 0" success check
# doesn't fit that, so poll directly instead.
stage_responsive=false
for _ in $(seq 1 30); do
  docker exec "$STAGE_C" vault status -address=http://127.0.0.1:8200 >/dev/null 2>&1
  code=$?
  if [ "$code" = 0 ] || [ "$code" = 2 ]; then
    stage_responsive=true
    break
  fi
  sleep 2
done

if [ "$stage_responsive" != true ]; then
  fail "synthetic staging Vault never came up — cannot demonstrate the restore+unseal mechanism."
else
  init_json=$(docker exec "$STAGE_C" vault operator init -address=http://127.0.0.1:8200 -key-shares=1 -key-threshold=1 -format=json)
  stage_unseal_key=$(printf '%s' "$init_json" | jq -r '.unseal_keys_b64[0]')
  stage_root_token=$(printf '%s' "$init_json" | jq -r '.root_token')

  docker exec -e VAULT_TOKEN="$stage_root_token" "$STAGE_C" \
    vault operator unseal -address=http://127.0.0.1:8200 "$stage_unseal_key" >/dev/null

  docker exec -e VAULT_TOKEN="$stage_root_token" "$STAGE_C" \
    vault secrets enable -address=http://127.0.0.1:8200 -path=secret -version=1 kv >/dev/null 2>&1 || true
  canary_value="restore-verify-canary-${RUN_ID}"
  docker exec -e VAULT_TOKEN="$stage_root_token" "$STAGE_C" \
    vault kv put -address=http://127.0.0.1:8200 secret/drill-canary value="$canary_value" >/dev/null

  docker exec -e VAULT_TOKEN="$stage_root_token" "$STAGE_C" \
    vault operator raft snapshot save -address=http://127.0.0.1:8200 /tmp/stage.snap >/dev/null
  docker cp "${STAGE_C}:/tmp/stage.snap" "$WORKDIR/stage.snap" >/dev/null

  run_real_vault "$TARGET_C" "$TARGET_VOL" "target-node"
  target_responsive=false
  for _ in $(seq 1 30); do
    docker exec "$TARGET_C" vault status -address=http://127.0.0.1:8200 >/dev/null 2>&1
    code=$?
    if [ "$code" = 0 ] || [ "$code" = 2 ]; then target_responsive=true; break; fi
    sleep 2
  done

  if [ "$target_responsive" != true ]; then
    fail "synthetic target Vault never came up — cannot attempt the restore."
  else
    target_init_json=$(docker exec "$TARGET_C" vault operator init -address=http://127.0.0.1:8200 -key-shares=1 -key-threshold=1 -format=json)
    target_unseal_key=$(printf '%s' "$target_init_json" | jq -r '.unseal_keys_b64[0]')
    target_root_token=$(printf '%s' "$target_init_json" | jq -r '.root_token')
    docker exec -e VAULT_TOKEN="$target_root_token" "$TARGET_C" \
      vault operator unseal -address=http://127.0.0.1:8200 "$target_unseal_key" >/dev/null

    docker cp "$WORKDIR/stage.snap" "${TARGET_C}:/tmp/restore.snap" >/dev/null
    # `-force`: a plain (non-forced) restore verifies the snapshot's hash
    # against the TARGET's own current keyring — by design, that only
    # ever succeeds restoring a snapshot back onto the SAME cluster it
    # came from (a point-in-time revert). Restoring onto a genuinely
    # different, freshly-initialised cluster (exactly this drill's
    # situation, and exactly "a fresh host" in Runbook Sec.3's own restore
    # scenario) requires `-force` to bypass that same-cluster check —
    # verified empirically against a real Vault 1.17 here: the plain form
    # failed with "could not verify hash file, possibly the snapshot is
    # using a different set of unseal keys; use the snapshot-force API to
    # bypass this check" before `-force` was added.
    if docker exec -e VAULT_TOKEN="$target_root_token" "$TARGET_C" \
      vault operator raft snapshot restore -force -address=http://127.0.0.1:8200 /tmp/restore.snap >"$WORKDIR/restore.out" 2>&1; then
      pass "vault operator raft snapshot restore completed on the throwaway target"
    else
      fail "vault operator raft snapshot restore failed: $(cat "$WORKDIR/restore.out")"
    fi

    # A raft snapshot restore typically re-seals the node (the restored
    # storage's own seal config takes over) — unseal with the STAGE's
    # key (the "staging key"), not the target's own now-irrelevant one,
    # which is the entire point of this proof.
    sleep 3
    docker exec -e VAULT_TOKEN="$stage_root_token" "$TARGET_C" \
      vault operator unseal -address=http://127.0.0.1:8200 "$stage_unseal_key" >/dev/null 2>&1 || true

    read_back=$(docker exec -e VAULT_TOKEN="$stage_root_token" "$TARGET_C" \
      vault kv get -address=http://127.0.0.1:8200 -field=value secret/drill-canary 2>/dev/null || echo "READ_FAILED")

    if [ "$read_back" = "$canary_value" ]; then
      pass "Vault restore+unseal mechanism verified end to end: restored snapshot unsealed with the staging key and the canary secret written before the snapshot read back correctly"
      vault_ok=true
    else
      fail "Vault restore+unseal proof FAILED: expected canary '${canary_value}', got '${read_back}'"
    fi
  fi
fi

# --- 2b. If the archive itself carries a real vault.snap, attempt a real
#     restore of THAT, using operator-supplied unseal keys if given.
if [ -f "$WORKDIR/extracted/vault.snap" ]; then
  log "Archive also contains a real vault.snap."
  if [ "${#VAULT_UNSEAL_KEYS[@]}" -eq 0 ]; then
    log "  No --vault-unseal-key supplied — SKIPPING an actual restore of it (this is an input gap, not a script failure; a real quarterly drill run supplies the key officers' shares here)."
  else
    REAL_TARGET_C="${PREFIX}-vault-real-target"
    REAL_TARGET_VOL="${PREFIX}-vault-real-target-data"
    run_real_vault "$REAL_TARGET_C" "$REAL_TARGET_VOL" "real-target-node"
    ready=false
    for _ in $(seq 1 30); do
      docker exec "$REAL_TARGET_C" vault status -address=http://127.0.0.1:8200 >/dev/null 2>&1
      code=$?
      if [ "$code" = 0 ] || [ "$code" = 2 ]; then ready=true; break; fi
      sleep 2
    done
    if [ "$ready" != true ]; then
      fail "throwaway target for the archive's real vault.snap never came up."
    else
      real_init=$(docker exec "$REAL_TARGET_C" vault operator init -address=http://127.0.0.1:8200 -key-shares=1 -key-threshold=1 -format=json)
      real_root=$(printf '%s' "$real_init" | jq -r '.root_token')
      real_own_key=$(printf '%s' "$real_init" | jq -r '.unseal_keys_b64[0]')
      docker exec -e VAULT_TOKEN="$real_root" "$REAL_TARGET_C" vault operator unseal -address=http://127.0.0.1:8200 "$real_own_key" >/dev/null
      docker cp "$WORKDIR/extracted/vault.snap" "${REAL_TARGET_C}:/tmp/real.snap" >/dev/null
      if docker exec -e VAULT_TOKEN="$real_root" "$REAL_TARGET_C" vault operator raft snapshot restore -force -address=http://127.0.0.1:8200 /tmp/real.snap >"$WORKDIR/real-restore.out" 2>&1; then
        sleep 3
        unsealed=false
        for key in "${VAULT_UNSEAL_KEYS[@]}"; do
          docker exec -e VAULT_TOKEN="$real_root" "$REAL_TARGET_C" vault operator unseal -address=http://127.0.0.1:8200 "$key" >/dev/null 2>&1 || true
        done
        docker exec "$REAL_TARGET_C" vault status -address=http://127.0.0.1:8200 >/dev/null 2>&1
        [ "$?" = 0 ] && unsealed=true
        if [ "$unsealed" = true ]; then
          pass "the archive's real vault.snap restored AND unsealed with the supplied --vault-unseal-key value(s)"
        else
          fail "the archive's real vault.snap restored but did NOT unseal with the supplied key(s) — wrong keys, or below threshold."
        fi
      else
        fail "restoring the archive's real vault.snap failed: $(cat "$WORKDIR/real-restore.out")"
      fi
    fi
  fi
fi

log "=== restore-verify.sh run ${RUN_ID} complete ==="
if [ "$OVERALL_OK" = true ]; then
  log "OVERALL: PASS"
  exit 0
fi
log "OVERALL: FAIL — see above"
exit 1
