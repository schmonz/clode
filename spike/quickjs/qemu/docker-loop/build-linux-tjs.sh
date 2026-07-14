#!/bin/sh
# build-linux-tjs.sh — build a linux/x86_64 host `tjs` (the cross-fuse WORKER)
# from clode's PINNED canonical-LE-patched source (txiki-canonical-le.tar.gz =
# a tar of spike/quickjs/vendor/txiki.js). The cross-fuse REQUIRES canonical-LE
# so the LE bytecode the worker writes is readable by the BE sparc engine
# (built from the SAME source). Flags mirror the sparc bake (ADA=OFF/wurl,
# FFI/MIMALLOC/WASM off). x64 is LE → no atomic-shim, no regen. Output:
# $OUT_DIR/tjs-linux.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
SPK=$(cd "$HERE/../.." && pwd)                       # spike/quickjs
OUT_DIR="${CLODE_SPARC_OUT:-$HOME/clode-ci-images/sparc/out}"
SRC="${CLODE_TJS_SRC_TARBALL:-txiki-canonical-le.tar.gz}"
mkdir -p "$OUT_DIR"

exec docker run --rm \
  -e SRC="$SRC" \
  -v "$SPK/vendor/dist:/dist:ro" \
  -v "$OUT_DIR:/out:rw" \
  clode-xfuse \
  bash -eu -c '
    W=$(mktemp -d)
    cd "$W"
    echo "[tjs] extracting txiki ($SRC) + simde..."
    tar xzf "/dist/$SRC"
    tar xzf /dist/simde-v0.8.2.tar.gz
    test -d txiki.js && test -d simde-src
    # same -Werror strip as the guest recipe (clang/MSVC pragmas trip gcc)
    sed -i.bak "/list(APPEND tjs_cflags -Werror)/d" txiki.js/CMakeLists.txt || true
    echo "[tjs] configure (Ninja, gcc)..."
    cmake -S txiki.js -B txiki.js/build -G Ninja -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_C_COMPILER=gcc -DCMAKE_CXX_COMPILER=g++ \
      "-DFETCHCONTENT_SOURCE_DIR_SIMDE=$W/simde-src" \
      -DTJS_USE_ADA=OFF -DBUILD_WITH_FFI=OFF -DBUILD_WITH_MIMALLOC=OFF -DBUILD_WITH_WASM=OFF
    echo "[tjs] build..."
    cmake --build txiki.js/build -j "$(nproc)"
    test -x txiki.js/build/tjs
    cp txiki.js/build/tjs /out/tjs-linux
    file /out/tjs-linux
    echo "[tjs] smoke: engine globals..."
    /out/tjs-linux eval "const a=typeof __tjs_spawn_sync,b=typeof __tjs_fs_sync; console.log(\"spawn_sync:\",a,\"fs_sync:\",b); if(a!==\"function\"||b!==\"object\") throw new Error(\"engine sanity failed\")" < /dev/null
    echo "[tjs] wrote /out/tjs-linux ($(wc -c < /out/tjs-linux) bytes)"
  '
