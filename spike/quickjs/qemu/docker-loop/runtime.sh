#!/bin/sh
# runtime.sh — wall #5/#6 runner: boot the PRISTINE sparc image and run a recipe
# that exercises the cross-fused clode-sparc in-guest. Stages the artifacts in
# $OUT_DIR (clode-sparc, and later an upstream provider) into the served :8180
# workspace so the guest can fetch them. No toolchain needed (pristine image).
# Usage: runtime.sh <recipe.sh> [extra-file-in-OUT ...]
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
IMG_DIR="${CLODE_SPARC_IMG_DIR:-$HOME/clode-ci-images/sparc}"
OUT_DIR="${CLODE_SPARC_OUT:-$HOME/clode-ci-images/sparc/out}"
RECIPE="${1:?usage: runtime.sh <recipe.sh> [extra-file ...]}"; shift
RECIPE_BASE=$(basename "$RECIPE")
STAGE="clode-sparc ${*:-}"

exec docker run --rm \
  --tmpfs /work:rw,size=13g \
  -v "$IMG_DIR:/img:ro" \
  -v "$HERE/..:/repo:ro" \
  -v "$OUT_DIR:/out:ro" \
  clode-sparc-ci \
  sh -eu -c '
    mkdir -p /work/workdir /work/workspace /work/tmp
    # qemu snapshot overlay (guest disk writes incl. guest swap) -> tmpfs, NOT
    # the tiny container/VM disk.
    export TMPDIR=/work/tmp
    echo "[runtime] decompressing pristine image -> tmpfs..."
    zstd -d -q /img/wd0-pristine-10.1.img.zst -o /work/workdir/wd0.img
    echo "[runtime] staging artifacts into :8180 workspace: '"$STAGE"'"
    for f in '"$STAGE"'; do cp "/out/$f" "/work/workspace/$f"; done
    cp "/repo/docker-loop/'"$RECIPE_BASE"'" "/work/workspace/'"$RECIPE_BASE"'"
    /opt/venv/bin/python3 /repo/ci-sparc-driver.py \
      --workdir /work/workdir --workspace /work/workspace \
      --recipe "'"$RECIPE_BASE"'" \
      --memory 512M --machine SS-20 \
      --overall-timeout 5400 --setup-timeout 600 --recipe-timeout 3600 &
    dpid=$!
    for i in $(seq 1 30); do [ -f /work/workdir/ci-sparc-console.log ] && break; sleep 1; done
    tail -n +1 -f /work/workdir/ci-sparc-console.log &
    tpid=$!
    wait $dpid; rc=$?
    sleep 1; kill $tpid 2>/dev/null || true
    echo "[runtime] driver exit=$rc"
    exit $rc
  '
