#!/bin/sh
# smoke.sh — run the COMMITTED spike/quickjs/qemu/ci-sparc-smoke.sh in the local
# loop, so docker-loop exercises the EXACT recipe CI ships (no fork). Stages the
# cross-fused builder + the minimal provider where the recipe expects them
# (.matrix/qemu-smoke/{clode-builder,provider-min}), boots the pristine image.
# Prereqs in $OUT_DIR: clode-sparc (cross-fused builder) + claude-min (from
# scripts/make-min-provider.cjs).
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
IMG_DIR="${CLODE_SPARC_IMG_DIR:-$HOME/clode-ci-images/sparc}"
OUT_DIR="${CLODE_SPARC_OUT:-$HOME/clode-ci-images/sparc/out}"

exec docker run --rm \
  --tmpfs /work:rw,size=13g \
  -v "$IMG_DIR:/img:ro" \
  -v "$HERE/..:/repo:ro" \
  -v "$OUT_DIR:/out:ro" \
  clode-sparc-ci \
  sh -eu -c '
    mkdir -p /work/workdir /work/workspace/.matrix/qemu-smoke /work/tmp
    export TMPDIR=/work/tmp
    echo "[smoke] decompressing pristine image -> tmpfs..."
    zstd -d -q /img/wd0-pristine-10.1.img.zst -o /work/workdir/wd0.img
    cp /out/clode-sparc /work/workspace/.matrix/qemu-smoke/clode-builder
    cp /out/claude-min  /work/workspace/.matrix/qemu-smoke/provider-min
    cp /repo/ci-sparc-smoke.sh /work/workspace/ci-sparc-smoke.sh
    /opt/venv/bin/python3 /repo/ci-sparc-driver.py \
      --workdir /work/workdir --workspace /work/workspace \
      --recipe ci-sparc-smoke.sh \
      --memory 512M --machine SS-20 \
      --overall-timeout 5400 --setup-timeout 600 --recipe-timeout 3600 &
    dpid=$!
    for i in $(seq 1 30); do [ -f /work/workdir/ci-sparc-console.log ] && break; sleep 1; done
    tail -n +1 -f /work/workdir/ci-sparc-console.log & tpid=$!
    wait $dpid; rc=$?; sleep 1; kill $tpid 2>/dev/null || true
    echo "[smoke] driver exit=$rc"; exit $rc
  '
