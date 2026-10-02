#!/usr/bin/env bash
#
# verify-object-store-mirror.sh — prove a mirrored image is the SAME IMAGE as a
# local reference, by comparing the whole OCI image config, not a field list.
#
# Usage:
#   verify-object-store-mirror.sh <registry-base> <repo> <digest-or-tag> <local-image>
# e.g.
#   verify-object-store-mirror.sh https://ghcr.io mavrone81/gadonghr-minio sha256:… 14cea493d9a3
# Env: VERIFY_OS (linux), VERIFY_ARCH (amd64)
#
# ======================= WHAT IS COMPARED, AND WHY ==========================
# PRIMARY: the OCI image CONFIG BLOB DIGEST on both sides — like with like.
# A faithful re-push of a loaded image keeps the config blob byte-identical, so
# this holds exactly; ANY metadata change breaks it. Measured here, both ways:
#   local alpine config digest        33bee74c…
#   faithful re-push                  33bee74c…  -> PASSES
#   metadata-only derivative          9cd8bf22…  -> FAILS
#
# 🔴 Why NOT `diff_ids` alone, which an earlier version of this check used:
# `diff_ids` are the uncompressed ROOTFS digests. A derivative that adds NO
# FILES — only instructions like ENTRYPOINT — produces empty layers that
# contribute no diff_id. Measured on the same rig: the attack image's diff_ids
# were BYTE-IDENTICAL to the faithful mirror's (1b349a33…) while its entrypoint
# was ["/bin/attacker-entrypoint"]. **diff_ids alone PASSES that attack.** The
# threat model is a mirror produced by whoever holds push access, so that is
# precisely the gap.
#
# 🔴 Why NOT a FIELD LIST (Entrypoint/Env/User/WorkingDir): that is another
# enumeration and misses the next field — Cmd, Healthcheck, Volumes,
# ExposedPorts, Labels, Shell, StopSignal, OnBuild. Same defect one level up:
# enumerate-the-population instead of compare-the-whole-thing. The config
# digest covers every field by construction, including ones added by a future
# OCI version.
#
# 🔴 Why NOT `docker inspect .Id`: under the containerd image store that is the
# INDEX digest, not the config digest — measured, they differ for the same
# image. Comparing it to a registry config digest compares two different kinds
# of value and false-fails. The fix for a mis-typed comparison is to fix its
# type, not to delete it.
#
# 🔴 Why NOT `docker inspect .Config` for the fallback: that is docker's view,
# not the OCI image config. It carries `Image`, `Hostname`, `Domainname` and
# others that are not part of image identity and can legitimately differ — a
# naive full-`.Config` diff FALSE-FAILS on a faithful mirror. The fallback
# below diffs the OCI config BLOB (the JSON the config digest addresses).
#
# ⚠ PLATFORM SELECTION IS REQUIRED ON BOTH SIDES. A registry index carries
# several manifests including `unknown/unknown` attestation entries, so "the
# config" is undefined until a platform is chosen. The LOCAL side has the same
# problem: `docker save` of alpine here produced TWO image-config blobs, one
# `arch=arm64 os=linux` and one `arch=unknown os=unknown`. Picking "the config
# blob" without selecting would be a coin flip. Both sides select explicitly
# and refuse to guess.
#
# Every captured value is asserted NON-EMPTY before any comparison: without
# that, a bad repo name plus a failed fetch leaves both sides empty and `=`
# reports agreement — a check that passes while never having read the mirror.

set -euo pipefail

REG="${1:?registry base, e.g. https://ghcr.io}"
REPO="${2:?repo, e.g. mavrone81/gadonghr-minio}"
REF="${3:?digest or tag}"
LOCAL="${4:?local reference image}"
OS="${VERIFY_OS:-linux}"
ARCH="${VERIFY_ARCH:-amd64}"

ACCEPT='Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json'
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

die() { printf 'VERIFY FAILED: %s\n' "$*" >&2; exit 1; }
nonempty() {
  [ -n "${2:-}" ] || die "$1 came back EMPTY — refusing to compare nothing with nothing; an empty-vs-empty match is not a match."
  case "$2" in null|'[]'|'{}'|'""') die "$1 is '$2' (no value) — refusing to treat an absent value as agreement." ;; esac
}

# ---------------- registry side: platform-selected config blob ----------------
man="$(curl -sfL -H "$ACCEPT" "$REG/v2/$REPO/manifests/$REF")" || die "cannot fetch manifest $REPO:$REF from $REG"
nonempty "mirror manifest body" "$man"
sel="$(printf '%s' "$man" | python3 -c '
import sys,json
m=json.load(sys.stdin); mt=m.get("mediaType","")
if "index" in mt or "manifest.list" in mt:
    c=[x for x in m.get("manifests",[]) if (x.get("platform") or {}).get("os")==sys.argv[1]
       and (x.get("platform") or {}).get("architecture")==sys.argv[2]]
    c=[x for x in c if (x.get("platform") or {}).get("architecture")!="unknown"]
    print("CHILD:"+c[0]["digest"] if len(c)==1 else "AMBIGUOUS:%d"%len(c))
else:
    print("CFG:"+((m.get("config") or {}).get("digest") or ""))' "$OS" "$ARCH")"
nonempty "mirror platform selection" "$sel"
case "$sel" in
  AMBIGUOUS:*) die "mirror index has ${sel#AMBIGUOUS:} manifests for $OS/$ARCH — refusing to guess which is the image" ;;
  CHILD:*) child="${sel#CHILD:}"; nonempty "mirror child manifest digest" "$child"
     cm="$(curl -sfL -H "$ACCEPT" "$REG/v2/$REPO/manifests/$child")" || die "cannot fetch child manifest $child"
     nonempty "mirror child manifest body" "$cm"
     MIR_CFG="$(printf '%s' "$cm" | python3 -c 'import sys,json;print(((json.load(sys.stdin).get("config")) or {}).get("digest") or "")')" ;;
  CFG:*) MIR_CFG="${sel#CFG:}" ;;
esac
nonempty "mirror config digest" "$MIR_CFG"
curl -sfL "$REG/v2/$REPO/blobs/$MIR_CFG" -o "$WORK/mir.json" || die "cannot fetch mirror config blob $MIR_CFG"
[ -s "$WORK/mir.json" ] || die "mirror config blob is empty"

# ---------------- local side: same selection, from docker save ----------------
docker image inspect "$LOCAL" >/dev/null 2>&1 || die "local image '$LOCAL' not found"
docker save "$LOCAL" -o "$WORK/local.tar" 2>/dev/null || die "docker save '$LOCAL' failed"
mkdir -p "$WORK/x" && tar -xf "$WORK/local.tar" -C "$WORK/x"
BOX_CFG="$(python3 - "$WORK/x" "$OS" "$ARCH" <<'PY'
import sys,json,glob,os
root,os_,arch=sys.argv[1],sys.argv[2],sys.argv[3]
hits=[]
for f in glob.glob(os.path.join(root,'blobs','sha256','*')):
    try: j=json.load(open(f))
    except Exception: continue
    if isinstance(j,dict) and 'rootfs' in j and 'config' in j:
        if j.get('os')==os_ and j.get('architecture')==arch:
            hits.append(os.path.basename(f))
print("sha256:"+hits[0] if len(hits)==1 else ("AMBIGUOUS:%d"%len(hits)))
PY
)"
nonempty "local config digest" "$BOX_CFG"
case "$BOX_CFG" in AMBIGUOUS:*) die "local image has ${BOX_CFG#AMBIGUOUS:} config blobs for $OS/$ARCH — refusing to guess (an attestation blob reports os/arch 'unknown')" ;; esac
cp "$WORK/x/blobs/sha256/${BOX_CFG#sha256:}" "$WORK/box.json"
[ -s "$WORK/box.json" ] || die "local config blob is empty"

# ---------------- PRIMARY: config digest, like with like ----------------
printf 'mirror config digest : %s\n' "$MIR_CFG"
printf 'local  config digest : %s\n' "$BOX_CFG"
if [ "$MIR_CFG" = "$BOX_CFG" ]; then
  printf 'MIRROR VERIFIED: config blob digests identical for %s/%s — same rootfs AND same metadata.\n' "$OS" "$ARCH"
  exit 0
fi

# ---------------- mismatch: show WHAT differs, from the OCI blobs ----------------
printf 'VERIFY FAILED: config digests differ — the mirror is NOT the same image. Differences:\n' >&2
python3 - "$WORK/box.json" "$WORK/mir.json" >&2 <<'PY'
import sys,json
a=json.load(open(sys.argv[1])); b=json.load(open(sys.argv[2]))
def flat(d,p=""):
    out={}
    if isinstance(d,dict):
        for k,v in d.items(): out.update(flat(v,f"{p}.{k}" if p else k))
    else: out[p]=d
    return out
fa,fb=flat(a),flat(b)
for k in sorted(set(fa)|set(fb)):
    if fa.get(k)!=fb.get(k):
        print(f"  {k}: local={fa.get(k)!r}  mirror={fb.get(k)!r}")
PY
exit 1
