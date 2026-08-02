#!/usr/bin/env bash
#
# prune-gadonghr-images.sh — keep the 4 newest SHA-tagged images per
# ghcr.io/mavrone81/gadonghr-* repository, delete the rest.
#
# Run from cron daily/weekly, e.g.:
#   17 3 * * * /opt/gadonghr/deploy/scripts/prune-gadonghr-images.sh >>/var/log/gadonghr-prune.log 2>&1
#
# Why this exists as its own script rather than `docker system prune`:
# every image auto-deploy-gadonghr.sh pulls is tagged with a real commit
# sha (`ghcr.io/mavrone81/gadonghr-<service>:<sha>`), never `latest` in
# production. A tagged image is never "dangling" — `docker system prune`
# (and even `docker image prune -a` without care) only ever removes
# untagged/unreferenced images, so on this stack it would find nothing to
# reclaim while old SHA tags quietly fill the 80 GB disk (roadmap
# "Standing constraints": "SHA-tagged images need the scoped keep-4 prune
# cron — plain `docker system prune` cannot see tagged images."). This
# script is that scoped cron.
#
# Deliberately `docker rmi` WITHOUT `-f`: if an old tag is still in use by
# a running or stopped-but-present container (e.g. mid-rollback, or a
# human `docker compose up` still referencing it), a plain `rmi` refuses
# and this script logs that failure and moves on to the next tag rather
# than forcing removal out from under something that needs it.
#
# Scoped strictly by repository name PREFIX
# (`ghcr.io/mavrone81/gadonghr-`) — this script never touches an image
# whose repository does not start with that prefix, so it cannot reach
# into an unrelated project's images on a shared host.

set -euo pipefail

KEEP="${GADONG_PRUNE_KEEP:-4}"
REPO_PREFIX="${GADONG_IMAGE_PREFIX:-ghcr.io/mavrone81/gadonghr-}"

log() { printf '%s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"; }

if ! [[ "$KEEP" =~ ^[0-9]+$ ]] || [ "$KEEP" -lt 1 ]; then
  log "GADONG_PRUNE_KEEP must be a positive integer, got: ${KEEP}"
  exit 1
fi

# `docker images --format` gives us "repository:tag<TAB>created_at" per
# line for every locally present image; filtered to our prefix and to
# tags that look like a git sha (7-40 lowercase hex, matching both a
# short and a full sha) so `latest`, `dev`, or any other floating tag on
# the same repository is never counted as a rotation candidate and never
# deleted by this script.
mapfile -t images < <(
  docker images --no-trunc --format '{{.Repository}}:{{.Tag}}	{{.CreatedAt}}' \
    | awk -F'\t' -v prefix="$REPO_PREFIX" 'index($1, prefix) == 1 { print }' \
    | grep -E '^[^:]+:[0-9a-f]{7,40}\s'
)

if [ "${#images[@]}" -eq 0 ]; then
  log "No SHA-tagged ${REPO_PREFIX}* images found locally — nothing to prune."
  exit 0
fi

# Group by repository (everything before the LAST ':'), newest-first
# within each group — `docker images`'s own default ordering is already
# newest-created-first, so simply walking the list in the order Docker
# gave it, and only starting to remove once a repository's count exceeds
# KEEP, keeps the newest N per repository without a separate sort step.
declare -A seen_count
removed=0
kept=0
failed=0

while IFS=$'\t' read -r ref _created; do
  repo="${ref%:*}"
  count="${seen_count[$repo]:-0}"
  seen_count[$repo]=$((count + 1))

  if [ "$count" -lt "$KEEP" ]; then
    kept=$((kept + 1))
    continue
  fi

  log "Removing ${ref} (older than the newest ${KEEP} for ${repo})"
  if docker rmi "$ref"; then
    removed=$((removed + 1))
  else
    log "Could not remove ${ref} (likely still in use) — leaving it, will retry next run."
    failed=$((failed + 1))
  fi
done < <(printf '%s\n' "${images[@]}")

log "Prune complete: kept=${kept} removed=${removed} failed_to_remove=${failed} (keep=${KEEP} per repo)"
