#!/bin/sh
# run.sh — one boot-proof iteration in a fresh clode-sparc-ci container.
# Usage: run.sh [recipe.sh] [driver-args...]
#   recipe.sh   defaults to boot-proof.sh (relative to this dir); it is copied
#               into the http workspace and named as the driver's --recipe.
# The 8GB wd0.img is decompressed into a RAM-backed tmpfs at /work each run,
# so every iteration starts from a pristine image with fast native I/O.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
IMG_DIR="${CLODE_SPARC_IMG_DIR:-$HOME/clode-ci-images/sparc}"
IMG_ZST="${CLODE_SPARC_IMG:-wd0-pristine-10.1.img.zst}"
RECIPE="${1:-boot-proof.sh}"; shift 2>/dev/null || true
RECIPE_BASE=$(basename "$RECIPE")

# qemu tunables (env-overridable): SS-20 allows >256MB; TCG-scale timeouts.
MEMORY="${CLODE_SPARC_MEMORY:-512M}"
MACHINE="${CLODE_SPARC_MACHINE:-SS-20}"
OVERALL="${CLODE_SPARC_OVERALL_TIMEOUT:-3600}"
SETUP="${CLODE_SPARC_SETUP_TIMEOUT:-600}"
RECIPE_TO="${CLODE_SPARC_RECIPE_TIMEOUT:-1200}"

exec docker run --rm \
  --tmpfs /work:rw,size=10g \
  -v "$IMG_DIR:/img:ro" \
  -v "$HERE/..:/repo:ro" \
  clode-sparc-ci \
  sh -eu -c '
    RECIPE_SRC="/repo/docker-loop/'"$RECIPE_BASE"'"
    mkdir -p /work/workdir /work/workspace
    echo "[run.sh] decompressing '"$IMG_ZST"' -> /work/workdir/wd0.img (8GB, tmpfs)"
    zstd -d -q "/img/'"$IMG_ZST"'" -o /work/workdir/wd0.img
    cp "$RECIPE_SRC" "/work/workspace/'"$RECIPE_BASE"'"
    echo "[run.sh] launching driver (machine='"$MACHINE"' mem='"$MEMORY"')"
    /opt/venv/bin/python3 /repo/ci-sparc-driver.py \
      --workdir /work/workdir --workspace /work/workspace \
      --recipe "'"$RECIPE_BASE"'" \
      --memory "'"$MEMORY"'" --machine "'"$MACHINE"'" \
      --overall-timeout '"$OVERALL"' --setup-timeout '"$SETUP"' --recipe-timeout '"$RECIPE_TO"' &
    dpid=$!
    # mirror the serial console live while the driver runs headless
    for i in $(seq 1 30); do [ -f /work/workdir/ci-sparc-console.log ] && break; sleep 1; done
    tail -n +1 -f /work/workdir/ci-sparc-console.log &
    tpid=$!
    wait $dpid; rc=$?
    sleep 1; kill $tpid 2>/dev/null || true
    echo "[run.sh] driver exit=$rc"
    exit $rc
  ' "$@"
