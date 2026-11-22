#!/bin/sh
# ci-guest-smoke.sh — the in-guest runtime smoke, run IN a qemu-system guest by
# ci-sparc-driver.py. Proven end-to-end in the docker-loop wall-walk (2026-07-14).
# The caller (CI build-leg, or docker-loop) stages two files under the served
# workspace at .matrix/qemu-smoke/, reachable at http://10.0.2.2:8180/.matrix/qemu-smoke/ :
#   clode-builder  — the sparc `clode` cross-fused on the x64 runner (--self)
#   provider-min   — a ~17.5MB SYNTHETIC provider (scripts/make-min-provider.cjs
#                    pre-carves the 240MB upstream binary; the full binary OOMs
#                    the 512MB guest + is TCG-glacial). clode EXTRACTS cli.cjs
#                    from it; it is never executed.
# clode-on-sparc then FUSES a quaude in-guest (compile+serialize cli.cjs under
# the embedded sparc template) and runs its OWN in-process PONG + attest smoke —
# so a single exit-0 == fused + PONG + attest.
# Markers (ci-sparc-driver verdict = GUEST-DONE present AND every *-exit == 0):
#   fetch-builder-exit, fetch-provider-exit, swap-add-exit, smoke-exit.
set -ux
S=http://10.0.2.2:8180/.matrix/qemu-smoke
W=/root/smoke
mkdir -p "$W"; cd "$W" || exit 1
date; uname -a; df -m / /tmp

f1() { n=0; while [ "$n" -lt 3 ]; do ftp -o "$1" "$2" && return 0; n=$((n+1)); sleep 10; done; echo "FETCH-FAILED $2"; return 1; }
f1 clode-builder "$S/clode-builder"; echo "fetch-builder-exit=$?"
f1 provider-min  "$S/provider-min";  echo "fetch-provider-exit=$?"
chmod +x clode-builder provider-min
ls -l clode-builder provider-min

# minimal profile: onboarding done + cwd pre-trusted; NO credentials (the build
# smoke talks only to clode's in-process mock).
printf '{"hasCompletedOnboarding":true,"theme":"dark","projects":{"%s":{"hasTrustDialogAccepted":true,"hasCompletedProjectOnboarding":true}}}\n' "$W" > /root/.claude.json

ulimit -d unlimited 2>/dev/null || ulimit -d "$(ulimit -H -d)" 2>/dev/null
ulimit -s 16384 2>/dev/null || ulimit -s "$(ulimit -H -s)" 2>/dev/null || true
ulimit -t 14400

# Safety-margin swap: with provider-min the extraction fits 512M and the compile
# peaks ~213M (2.2x headroom); the assemble briefly spikes ~10M into swap. NetBSD
# swaps to a regular file directly; with qemu snapshot=on the guest disk (incl.
# swap) is host-tmpfs-backed, so swap I/O is RAM-fast.
dd if=/dev/zero of=/var/tmp/swap bs=1048576 count=512 2>/dev/null
chmod 600 /var/tmp/swap
swapctl -a /var/tmp/swap; echo "swap-add-exit=$?"

# Progress + keepalive heartbeat: the fuse worker's compile/assemble is SILENT
# under TCG for minutes (its stdout is captured, not streamed). This proves
# liveness in the CI log AND resets the driver's silence timeout. It samples the
# whole fuse family RSS (parent clode-builder + the template-tjs worker + the
# quaude smoke/attest children).
#
# RSS IS ONLY WHAT IS RESIDENT. Run 45005386065 (2.1.330) died "template-tjs killed: out of
# swap" while fam_rss FELL and swap_used ROSE: the family was being paged OUT, and RSS could
# not say by whom. So each tick also prints, per process, VSZ (resident + swapped address
# space) — the column that names who holds the swap — and how full the build's scratch
# filesystem is (df of TMPDIR or /tmp, with its device: on this image /tmp is the root FFS
# on sd0a, NOT swap-backed tmpfs, which the same log's `df -m / /tmp` showed; a later image
# that mounts tmpfs there would show it here, in the line that dies).
START=$(date +%s)
TMPD=${TMPDIR:-/tmp}
( set +x   # don't xtrace the sampler's awk program every tick (CI log noise)
  while :; do
    el=$(( $(date +%s) - START ))
    sw=$(swapctl -lk 2>/dev/null | awk 'NR>1{u+=$3} END{print u+0}')
    tmp=$(df -k "$TMPD" 2>/dev/null | awk 'NR==2{printf "%s:%dkb/%dkb", $1, $3, $2}')
    ps -axo rss,vsz,comm 2>/dev/null | awk -v t="$el" -v sw="$sw" -v tmp="$tmp" '
      /clode-builder|template-tjs|quaude|tjs/ {
        s+=$1; v+=$2; if($1>mx){mx=$1; mc=$3}
        n=$3; sub(/.*\//, "", n); each=each sprintf(" %s:%d/%d", n, $1, $2) }
      END { printf "PROGRESS t=%ss fam_rss_kb=%d top=%s:%dkb swap_used_kb=%s fam_vsz_kb=%d tmp=%s procs(rss/vsz kb)=%s\n", t, s+0, mc, mx+0, sw, v+0, tmp, each }'
    sleep 20
  done ) &
SAMPLER=$!

echo "=== FUSE + PONG (clode-on-sparc builds a quaude, then smokes it) ==="
date
CLODE_TIMEOUT_SCALE=20 CLODE_CLAUDE_BIN="$W/provider-min" CLODE_VERBOSE=1 NODE_PATH= \
  ./clode-builder build --out "$W/quaude"
rc=$?
kill "$SAMPLER" 2>/dev/null || true
echo "smoke-exit=$rc"
date
ls -l "$W/quaude" 2>/dev/null; file "$W/quaude" 2>/dev/null || true
echo "=== GUEST-DONE ==="
