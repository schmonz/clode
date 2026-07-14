#!/bin/sh
# cross-build.sh — LOCAL cross-build of the tjs engine for a Debian cross target,
# then a qemu-user eval smoke. De-risks the linux-s390x/riscv64 tier-2 legs in
# minutes before any GHA run (same role the sparc docker-loop played). Builds
# the ENGINE from the pinned canonical-LE tarball with the leg's toolchain file
# (a faithful proxy for build-leg's exec=cross step); the cross-fuse + fuse+PONG
# path is already proven by sparc, so this only proves cross-compile + run.
#
# Usage: cross-build.sh <triple> <cross-file> <apt-cross-pkgs> <qemu-arch>
#   cross-build.sh riscv64-linux-gnu scripts/linux-riscv64.toolchain.cmake \
#     "gcc-riscv64-linux-gnu g++-riscv64-linux-gnu" riscv64
#   cross-build.sh s390x-linux-gnu scripts/linux-s390x.toolchain.cmake \
#     "gcc-s390x-linux-gnu g++-s390x-linux-gnu" s390x
set -eu
TRIPLE="$1"; CROSS="$2"; PKG="$3"; QA="${4:-}"
REPO=$(cd "$(dirname "$0")/../../../.." && pwd)
OUT="${CLODE_SPARC_OUT:-$HOME/clode-ci-images/sparc/out}"; mkdir -p "$OUT"

# Cross-compile the engine inside node:24-bookworm (Debian, matches the CI
# cross-image family). Uses the SAME toolchain file build-leg passes; -G Ninja
# here (build-leg uses Make) — generator-agnostic for the toolchain file.
# The extract + build workspace AND the compiler's temp files (TMPDIR) live on a
# RAM-backed tmpfs: the docker VM's overlay disk is small (~3GB free) and shared
# with the user's GUI-app images, but it has 16GB RAM — so the ~2-3GB build tree
# stays off disk (mirrors the sparc docker-loop's --tmpfs workspace).
docker run --rm -v "$REPO:/repo:ro" -v "$OUT:/out:rw" \
  --tmpfs /work:exec,size=10g -e TMPDIR=/work \
  -e TRIPLE="$TRIPLE" -e PKG="$PKG" -e CROSS="$CROSS" node:24-bookworm bash -eu -c '
  apt-get update -qq && apt-get install -y --no-install-recommends cmake ninja-build $PKG file >/dev/null
  W=$(mktemp -d); cd "$W"
  tar xzf /repo/spike/quickjs/vendor/dist/txiki-canonical-le.tar.gz
  tar xzf /repo/spike/quickjs/vendor/dist/simde-v0.8.2.tar.gz
  sed -i.bak "/list(APPEND tjs_cflags -Werror)/d" txiki.js/CMakeLists.txt || true
  cmake -S txiki.js -B txiki.js/build -G Ninja -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_TOOLCHAIN_FILE=/repo/$CROSS \
    "-DFETCHCONTENT_SOURCE_DIR_SIMDE=$W/simde-src" \
    -DTJS_USE_ADA=OFF -DBUILD_WITH_FFI=OFF -DBUILD_WITH_MIMALLOC=OFF -DBUILD_WITH_WASM=OFF
  cmake --build txiki.js/build -j "$(nproc)"
  cp txiki.js/build/tjs "/out/tjs-$TRIPLE"; file "/out/tjs-$TRIPLE"
'

# qemu-user eval smoke: the cross-built engine runs + computes on the target arch
# under binfmt. 42 == the canonical-LE reader deserialized its LE core bytecode
# on this arch and evaluated correctly (for 64-bit-BE s390x, the canonical-LE-on-
# 64-bit-BE proof). --platform is required on this docker (20.10.24) to pull the
# foreign-arch rootfs; GHA's docker/setup-qemu-action resolves it natively.
if [ -n "$QA" ]; then
  docker run --rm --privileged multiarch/qemu-user-static --reset -p yes >/dev/null 2>&1 || true
  docker run --rm --platform "linux/$QA" -v "$OUT:/out:ro" "$QA/debian:trixie-slim" \
    /out/tjs-"$TRIPLE" eval 'console.log(6*7)' 2>&1 | tail -1
fi
