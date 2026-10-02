#!/usr/bin/env bash
#
# set-object-store-digest.sh — substitute the object-store mirror digest into
# every compose file that references it, and verify the mirror is the same
# image content as a local reference before accepting it.
#
# Usage:
#   set-object-store-digest.sh sha256:<64-hex>              [--verify-against <local-image>]
#
# WHY THIS SCRIPT EXISTS RATHER THAN A SHARED VARIABLE
# ----------------------------------------------------
# The two compose files live in separate projects with separate environment
# scopes: `deploy/` is invoked from `deploy/` with its own `.env`, while
# `test/e2e/docker-compose.yml` is invoked with `working-directory: test/e2e`
# (see the CI workflow) and has exactly one `${}` substitution of its own. A
# single `${VAR}` therefore cannot reach both files without adding a second
# env mechanism to the e2e project. So the single substitution point is this
# ONE COMMAND, not one line — and it ends by proving no placeholder is left.
#
# WHICH DIGEST TO PASS
# --------------------
# The mirror's OWN manifest digest, taken from the push output or from the
# registry:
#   curl -sI -H 'Accept: application/vnd.oci.image.manifest.v1+json' \
#     https://ghcr.io/v2/mavrone81/gadonghr-minio/manifests/<tag> \
#     | grep -i docker-content-digest
# 🔴 NOT from `docker inspect --format '{{.RepoDigests}}'`. Measured on a local
# registry: after pushing a mirrored image, RepoDigests still reported the
# UPSTREAM digest while the registry held a different one — pinning from it
# would reference an image that is not in our registry at all.
#
# WHAT --verify-against CHECKS, AND WHY IT IS diff_ids
# ---------------------------------------------------
# Content identity, not packaging. Measured on `alpine:latest` mirrored into a
# local registry:
#   manifest digest      upstream sha256:294b683c… -> mirrored sha256:260479a1…  CHANGED
#   `docker inspect .Id` reports the index/manifest digest, NOT the config digest
#   config digest        (from the registry manifest) differs from that .Id
#   rootfs diff_ids      IDENTICAL on both sides
# A re-push legitimately recompresses layers and rewrites the manifest, so
# asserting manifest-digest equality ACCUSES A CORRECT MIRROR; and comparing
# `.Id` against a registry config digest compares two different things and
# produces a confident false mismatch. `diff_ids` are the uncompressed layer
# digests — what is actually in the image — and were the only value that
# agreed across both instruments.
# Extent: measured on `alpine:latest` with the docker/containerd image store
# available here. It is a property of the tooling, not of that image, so it is
# expected to transfer — but it has been verified on one image, not on MinIO.

set -uo pipefail

DIGEST="${1:-}"
VERIFY_AGAINST=""
[ "${2:-}" = "--verify-against" ] && VERIFY_AGAINST="${3:-}"

PLACEHOLDER='sha256:UNRESOLVED-PENDING-MIRROR-PUBLISH'
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FILES=("$REPO_ROOT/deploy/docker-compose.yml" "$REPO_ROOT/test/e2e/docker-compose.yml")

die() { printf 'FAILED: %s\n' "$*" >&2; exit 1; }

case "$DIGEST" in
  sha256:*) : ;;
  *) die "pass the mirror's manifest digest as sha256:<64-hex>. Got: '${DIGEST:-<empty>}'" ;;
esac
hex="${DIGEST#sha256:}"
[ "${#hex}" -eq 64 ] || die "digest must be 64 hex characters after 'sha256:', got ${#hex}"
printf '%s' "$hex" | grep -qE '^[0-9a-f]{64}$' || die "digest must be lowercase hex"

# ---------- optional content-identity check, before touching any file ----------
if [ -n "$VERIFY_AGAINST" ]; then
  command -v docker >/dev/null 2>&1 || die "--verify-against needs docker"
  local_ids="$(docker image inspect "$VERIFY_AGAINST" --format '{{range .RootFS.Layers}}{{.}} {{end}}' 2>/dev/null)" \
    || die "cannot inspect local image '$VERIFY_AGAINST'"
  [ -n "$local_ids" ] || die "local image '$VERIFY_AGAINST' reported no rootfs layers — refusing to compare against nothing"
  acc='Accept: application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json'
  cfg="$(curl -sf -H "$acc" "https://ghcr.io/v2/mavrone81/gadonghr-minio/manifests/${DIGEST}" \
         | python3 -c 'import sys,json;print(json.load(sys.stdin)["config"]["digest"])' 2>/dev/null)" \
    || die "could not read the mirror manifest for ${DIGEST} from the registry"
  mirror_ids="$(curl -sf "https://ghcr.io/v2/mavrone81/gadonghr-minio/blobs/${cfg}" \
         | python3 -c 'import sys,json;print(" ".join(json.load(sys.stdin)["rootfs"]["diff_ids"]))' 2>/dev/null)" \
    || die "could not read the mirror config blob ${cfg}"
  printf 'local  diff_ids: %s\n' "$(echo "$local_ids")"
  printf 'mirror diff_ids: %s\n' "$(echo "$mirror_ids")"
  [ -n "$mirror_ids" ] || die "mirror reported no diff_ids — refusing to accept an empty comparison as a match"
  [ "$(echo "$local_ids")" = "$(echo "$mirror_ids")" ] \
    || die "CONTENT MISMATCH — the mirror is not the same image content as '$VERIFY_AGAINST'. Do not reference it."
  echo "content identity: OK (diff_ids match)"
fi

# ---------- substitute ----------
changed=0
for f in "${FILES[@]}"; do
  [ -f "$f" ] || die "missing compose file: $f"
  n="$(grep -c "$PLACEHOLDER" "$f" || true)"
  if [ "$n" -gt 0 ]; then
    python3 - "$f" "$PLACEHOLDER" "$DIGEST" <<'PY'
import sys
p,old,new=sys.argv[1],sys.argv[2],sys.argv[3]
s=open(p).read(); open(p,'w').write(s.replace(old,new))
PY
    printf 'substituted %s occurrence(s) in %s\n' "$n" "${f#"$REPO_ROOT"/}"
    changed=$((changed+n))
  else
    printf 'no placeholder in %s (already substituted?)\n' "${f#"$REPO_ROOT"/}"
  fi
done

# ---------- a run that changed nothing is not a success ----------
[ "$changed" -gt 0 ] || die "0 placeholders substituted. Nothing was changed, so this is not a pass — check whether the digest was already set, or the placeholder token drifted."

remaining="$(grep -rl "$PLACEHOLDER" "$REPO_ROOT" --include='*.yml' 2>/dev/null | grep -c . || true)"
[ "$remaining" -eq 0 ] || { grep -rn "$PLACEHOLDER" "$REPO_ROOT" --include='*.yml' >&2; die "$remaining file(s) still carry the placeholder"; }

printf 'DIGEST SET: %s substituted into %s file(s); 0 placeholders remain\n' "$DIGEST" "${#FILES[@]}"
