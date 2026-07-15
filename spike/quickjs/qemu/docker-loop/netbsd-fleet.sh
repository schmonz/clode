#!/bin/sh
# netbsd-fleet.sh — LOCAL prover for the NetBSD arch fleet. For each MACHINE:
# build.sh a cross toolchain + sysroot, cross-build the tjs engine against it
# via the GENERIC scripts/netbsd.toolchain.cmake (triple discovered from the
# tooldir), and `file` the result. De-risks the fleet arch-by-arch before CI —
# each arch's walls (like m68k's -ldl / atomic-shim) surface here in the loop.
#
# Runs entirely on the local linux/x86_64 docker (build.sh cross-builds fine on
# Linux). ONE src clone shared across arches; per-arch tool/dest freed after each
# so tmpfs (RAM) peak stays ~src + one arch. SEQUENTIAL — build.sh is heavy and
# the VM is shared. Report + engines land in $OUT.
#
# Usage: netbsd-fleet.sh <machine> [<machine> ...]
#   netbsd-fleet.sh sparc64                 # one clean 64-bit BE proof
#   netbsd-fleet.sh sparc64 alpha vax hppa macppc
set -eu
REPO=$(cd "$(dirname "$0")/../../../.." && pwd)
OUT="${CLODE_SPARC_OUT:-$HOME/clode-ci-images/sparc/out}"; mkdir -p "$OUT"
MACHINES="$*"; [ -n "$MACHINES" ] || MACHINES="sparc64"
REPORT="$OUT/netbsd-fleet-report.txt"

docker run --rm -v "$REPO:/repo:ro" -v "$OUT:/out:rw" --tmpfs /work:exec,size=12g \
  -e TMPDIR=/work -e MACHINES="$MACHINES" node:24-bookworm bash -eu -c '
  apt-get update -qq
  apt-get install -y --no-install-recommends build-essential git cmake ninja-build file zlib1g-dev >/dev/null
  cd /work
  echo "=== clone NetBSD src (netbsd-10, shared) ===" >&2
  git clone --depth 1 --branch netbsd-10 https://github.com/NetBSD/src src 2>/dev/null
  for M in $MACHINES; do
    echo "" >> /out/netbsd-fleet-report.txt
    echo "### $M ($(date -u +%H:%M:%S)) ###" | tee -a /out/netbsd-fleet-report.txt >&2
    rm -rf /work/tool /work/dest /work/tjs
    if ! ( cd /work/src && ./build.sh -m "$M" -U -T /work/tool -D /work/dest -j "$(nproc)" tools distribution ) >/work/bsh.log 2>&1; then
      echo "  build.sh FAILED (tail): $(tail -2 /work/bsh.log)" | tee -a /out/netbsd-fleet-report.txt >&2; continue
    fi
    GCC=$(ls /work/tool/bin/*--netbsd*-gcc 2>/dev/null | head -1)
    [ -n "$GCC" ] || { echo "  no cross gcc under /work/tool/bin" | tee -a /out/netbsd-fleet-report.txt >&2; continue; }
    TRIPLE=$(basename "$GCC" | sed "s/-gcc\$//")
    echo "  toolchain ok: $TRIPLE" | tee -a /out/netbsd-fleet-report.txt >&2
    # extract the pinned canonical-LE txiki + simde
    W=/work/tjs; mkdir -p "$W"; cd "$W"
    tar xzf /repo/spike/quickjs/vendor/dist/txiki-canonical-le.tar.gz
    tar xzf /repo/spike/quickjs/vendor/dist/simde-v0.8.2.tar.gz
    sed -i.bak "/list(APPEND tjs_cflags -Werror)/d" txiki.js/CMakeLists.txt || true
    cfg() { cmake -S txiki.js -B txiki.js/build -G Ninja -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_TOOLCHAIN_FILE=/repo/scripts/netbsd.toolchain.cmake \
      "-DFETCHCONTENT_SOURCE_DIR_SIMDE=$W/simde-src" \
      -DTJS_USE_ADA=OFF -DBUILD_WITH_FFI=OFF -DBUILD_WITH_MIMALLOC=OFF -DBUILD_WITH_WASM=OFF "$@" >/work/cmake.log 2>&1; }
    export CLODE_NETBSD_TOOLDIR=/work/tool CLODE_NETBSD_DESTDIR=/work/dest
    SHIM=""
    cfg || { echo "  cmake configure FAILED: $(tail -2 /work/cmake.log)" | tee -a /out/netbsd-fleet-report.txt >&2; continue; }
    if ! cmake --build txiki.js/build -j "$(nproc)" >/work/build.log 2>&1; then
      if grep -q "__atomic_" /work/build.log; then
        echo "  link needs the atomic shim -> relinking with atomic-shim.o" | tee -a /out/netbsd-fleet-report.txt >&2
        "$TRIPLE-gcc" --sysroot=/work/dest -O2 -c /repo/spike/quickjs/atomic-shim.c -o /work/atomic-shim.o
        rm -rf txiki.js/build
        cfg -DCMAKE_EXE_LINKER_FLAGS=/work/atomic-shim.o
        cmake --build txiki.js/build -j "$(nproc)" >/work/build.log 2>&1 || {
          echo "  BUILD FAILED even with shim: $(tail -3 /work/build.log)" | tee -a /out/netbsd-fleet-report.txt >&2; continue; }
        SHIM=" +atomic-shim"
      else
        echo "  BUILD FAILED: $(tail -3 /work/build.log)" | tee -a /out/netbsd-fleet-report.txt >&2; continue
      fi
    fi
    cp txiki.js/build/tjs "/out/tjs-netbsd-$M"
    echo "  ENGINE$SHIM: $(file -b /out/tjs-netbsd-$M)" | tee -a /out/netbsd-fleet-report.txt >&2
    cd /work
  done
  echo "" ; echo "=== fleet report ===" ; cat /out/netbsd-fleet-report.txt
'
echo "report: $REPORT"
