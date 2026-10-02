#!/usr/bin/env bash
#
# assert-images-available.sh — POSITIVE assertion that every image the stack
# needs can actually be obtained, run BEFORE anything that depends on it.
#
# Why this exists, in one line: on 2026-10-02 a third-party image began
# answering 401 and the first thing anybody saw was a compose bring-up dying
# mid-way with "unauthorized". That is a late, unspecific failure. This fails
# early and names the image and the registry.
#
# 🔴 WHAT MAKES THIS A *POSITIVE* ASSERTION, which is the whole point:
#   * On success it prints `IMAGES OK: n/n obtainable` with a COUNT. An empty
#     or missing log line can therefore never be read as success — the absence
#     of a complaint is not evidence, and a run that checked ZERO images
#     reports `0/0` and FAILS rather than passing vacuously.
#   * On failure it prints one `IMAGE UNAVAILABLE:` line per image, naming the
#     image AND its registry host AND the reason, then a summary count, then
#     exits non-zero. Monitoring greps for `IMAGES OK:`; CI reads the exit.
#
# The image list is DERIVED from the compose files (`docker compose config
# --images`), never hardcoded — a hardcoded list silently stops covering an
# image somebody adds later. Refs may also be passed as arguments, which is
# how the self-test below drives it.
#
# Usage:
#   assert-images-available.sh                       # derive from compose
#   assert-images-available.sh IMAGE [IMAGE...]      # explicit refs
#
# Env:
#   COMPOSE_FILES_ARGS  compose -f args (default: the deploy pair)
#   ALLOW_CACHED        1 (default) = an image already present locally counts
#                       as obtainable. 0 = require a successful registry pull.
#   GADONG_PLATFORM     passed to `docker pull --platform`. Defaults to
#                       linux/amd64, the deploy target.
#
# ⚠ PLATFORM MATTERS, and omitting it false-fails. Our service images are
# published for linux/amd64 only. Run without an explicit platform on an
# arm64 host (an Apple Silicon dev machine) and every one of them reports
# "no matching manifest for linux/arm64/v8" — 15 spurious failures on a
# perfectly healthy registry. Found by running this script on arm64 rather
# than reasoning about it. The box and CI are both amd64, so the default is
# right for them; the flag exists so a local run is not misleading.

set -uo pipefail

DEPLOY_DIR="${GADONG_DEPLOY_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
ALLOW_CACHED="${ALLOW_CACHED:-1}"

registry_of() { # ghcr.io/x/y:tag -> ghcr.io ; postgres:16 -> docker.io (implicit)
  local ref="$1" first="${1%%/*}"
  case "$ref" in
    */*) case "$first" in *.*|*:*|localhost) printf '%s' "$first" ;; *) printf 'docker.io' ;; esac ;;
    *) printf 'docker.io' ;;
  esac
}

if [ "$#" -gt 0 ]; then
  IMAGES=("$@")
else
  # shellcheck disable=SC2206
  read -r -a CF <<<"${COMPOSE_FILES_ARGS:--f $DEPLOY_DIR/docker-compose.yml -f $DEPLOY_DIR/docker-compose.prod.yml}"
  mapfile -t IMAGES < <(docker compose "${CF[@]}" config --images 2>/dev/null | sort -u)
fi

total=0; ok=0; failed=0; fails=()
for ref in "${IMAGES[@]}"; do
  [ -n "$ref" ] || continue
  total=$((total+1))
  reg="$(registry_of "$ref")"
  # 🔴 Unresolved-digest guard. The mirror reference is committed with a
  # deliberately INVALID digest token until the mirror is published, so this
  # patch cannot pass its own check while the placeholder is present —
  # fail-closed by construction rather than syntactically complete and
  # silently wrong. `docker compose config` accepts the token (so unrelated
  # compose tests are unaffected) and only the fetch rejects it; this branch
  # exists so the message names the cause instead of "invalid reference
  # format".
  case "$ref" in
    *UNRESOLVED-PENDING-MIRROR-PUBLISH*)
      printf 'IMAGE UNAVAILABLE: %s  registry=%s  reason=digest placeholder not yet substituted — run scripts/set-object-store-digest.sh <digest>\n' "$ref" "$reg"
      fails+=("$ref (unresolved placeholder)"); failed=$((failed+1)); continue ;;
  esac
  if [ "$ALLOW_CACHED" = 1 ] && docker image inspect "$ref" >/dev/null 2>&1; then
    printf '  obtainable (local cache) : %s\n' "$ref"
    ok=$((ok+1)); continue
  fi
  err="$(docker pull -q --platform "${GADONG_PLATFORM:-linux/amd64}" "$ref" 2>&1 >/dev/null)"
  if [ -z "$err" ] && docker image inspect "$ref" >/dev/null 2>&1; then
    printf '  obtainable (pulled)      : %s\n' "$ref"
    ok=$((ok+1))
  else
    reason="$(printf '%s' "$err" | tr '\n' ' ' | sed 's/  */ /g' | cut -c1-160)"
    printf 'IMAGE UNAVAILABLE: %s  registry=%s  reason=%s\n' "$ref" "$reg" "${reason:-unknown}"
    fails+=("$ref ($reg)")
    failed=$((failed+1))
  fi
done

echo
# 🔴 A run that checked nothing FAILS. Otherwise an empty image list — a broken
# compose path, a typo in the -f args — would print "IMAGES OK: 0/0" and pass,
# which is the vacuous green this assertion exists to prevent.
if [ "$total" -eq 0 ]; then
  echo "IMAGE CHECK FAILED: 0 images were checked. Nothing was verified, so this is not a pass."
  echo "  (compose path wrong, or an empty --images result — fix the input, do not ignore this.)"
  exit 2
fi
if [ "$failed" -gt 0 ]; then
  echo "IMAGE CHECK FAILED: $failed of $total image(s) could not be obtained:"
  for f in "${fails[@]}"; do echo "    - $f"; done
  echo "  The stack cannot be brought up or deployed until each is reachable or mirrored."
  exit 1
fi
echo "IMAGES OK: $ok/$total obtainable"
exit 0
