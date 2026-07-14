#!/bin/sh
# ci-sparc-bake.sh — the netbsd-sparc ENGINE bake, run IN the BAKED (gmake+cmake)
# sun4m guest by ci-sparc-driver.py on a tjs-cache MISS. Builds the
# clode-compatible sparc `tjs` from clode's PINNED canonical-LE source, then
# SYNCS IT OUT over the serial console (gzip|base64, framed) so the x64 runner
# can cross-fuse the builder against it. Proven in the docker-loop wall-walk
# (2026-07-14). The caller stages, under the served workspace at
# .matrix/qemu-bake/ (http://10.0.2.2:8180/.matrix/qemu-bake/):
#   txiki-canonical-le.tar.gz  — a tar of the patched txiki.js tree
#                                (scripts/build-tjs.mjs --source-only output)
#   simde-v0.8.2.tar.gz        — the simde source (FetchContent offline)
# canonical-LE matters: it makes the engine READ little-endian bytecode on this
# big-endian host, so (a) NO in-guest tjsc BE-regen is needed, and (b) the LE
# bytecode the linux cross-fuse worker writes is readable here (a non-canonical
# engine gives "SyntaxError: checksum error" on the cross-fused builder).
# Keeps the sparc32 atomic-shim (base has no libatomic). Flags match the leg:
# ADA=OFF/wurl, FFI/MIMALLOC/WASM off.
# Markers: cle-fetch-*, cle-canon-present, cle-configure-exit, cle-build-exit,
# cle-engine-exit, bake-tjs-cksum=, bake-exit, === GUEST-DONE ===.
set -ux
S=http://10.0.2.2:8180/.matrix/qemu-bake
W=/root/bakework
mkdir -p "$W"; cd "$W" || exit 1

echo "=== HOSTINFO ==="
date; uname -a
cc --version 2>&1 | head -1
/usr/local/bin/gmake --version 2>&1 | head -1; echo "bake-gmake-present=$?"
/usr/local/bin/cmake --version 2>&1 | head -1; echo "bake-cmake-present=$?"
df -m / /tmp
ulimit -d unlimited 2>/dev/null || ulimit -d "$(ulimit -H -d)" 2>/dev/null
ulimit -s 16384 2>/dev/null || ulimit -s "$(ulimit -H -s)" 2>/dev/null || true
ulimit -t 7200
echo "datasize-now=$(ulimit -d) stacksize-now=$(ulimit -s) cputime-now=$(ulimit -t)"

echo "=== FETCH ==="
f1() { n=0; while [ "$n" -lt 3 ]; do ftp -o "$1" "$2" && return 0; n=$((n+1)); sleep 10; done; echo "FETCH-FAILED $2"; return 1; }
f1 tjs.tgz   "$S/txiki-canonical-le.tar.gz"; echo "cle-fetch-tjs-exit=$?"
f1 simde.tgz "$S/simde-v0.8.2.tar.gz";        echo "cle-fetch-simde-exit=$?"
wc -c tjs.tgz simde.tgz
tar xzf tjs.tgz
tar xzf simde.tgz
for d in txiki.js simde-src; do
  [ -d "$W/$d" ] || { echo "FATAL: $d missing after extraction"; echo "bake-exit=1"; echo "=== GUEST-DONE ==="; exit 1; }
done

# Canonical-LE MUST be present (else we rebuild the checksum-error engine).
CANON=$(grep -c 'bc_bswap_op_operands' txiki.js/deps/quickjs/quickjs.c 2>/dev/null || echo 0)
echo "cle-canon-present=$CANON"
[ "$CANON" -ge 1 ] || { echo "FATAL: canonical-LE patch absent from served source"; echo "bake-exit=1"; echo "=== GUEST-DONE ==="; exit 1; }
grep -c 'function_size + 7' txiki.js/deps/quickjs/quickjs.c   # cpool-align, expect 2

# Strip -Werror (clang/MSVC pragmas trip gcc -Wunknown-pragmas)
sed -i.bak '/list(APPEND tjs_cflags -Werror)/d' txiki.js/CMakeLists.txt

echo "=== ATOMIC-SHIM ==="
cat > atomic-shim.c <<'EOF'
#include <pthread.h>
#include <stdint.h>
#include <stddef.h>
static pthread_mutex_t L = PTHREAD_MUTEX_INITIALIZER;
#define OPS(n, t) \
t __atomic_load_##n(const volatile void *p, int mo){ t v; pthread_mutex_lock(&L); v = *(const volatile t*)p; pthread_mutex_unlock(&L); return v; } \
void __atomic_store_##n(volatile void *p, t v, int mo){ pthread_mutex_lock(&L); *(volatile t*)p = v; pthread_mutex_unlock(&L); } \
t __atomic_exchange_##n(volatile void *p, t v, int mo){ t o; pthread_mutex_lock(&L); o = *(volatile t*)p; *(volatile t*)p = v; pthread_mutex_unlock(&L); return o; } \
_Bool __atomic_compare_exchange_##n(volatile void *p, void *e, t d, _Bool w, int s, int f){ _Bool r; pthread_mutex_lock(&L); t o = *(volatile t*)p; if (o == *(t*)e) { *(volatile t*)p = d; r = 1; } else { *(t*)e = o; r = 0; } pthread_mutex_unlock(&L); return r; } \
t __atomic_fetch_add_##n(volatile void *p, t v, int mo){ pthread_mutex_lock(&L); t o = *(volatile t*)p; *(volatile t*)p = o + v; pthread_mutex_unlock(&L); return o; } \
t __atomic_fetch_sub_##n(volatile void *p, t v, int mo){ pthread_mutex_lock(&L); t o = *(volatile t*)p; *(volatile t*)p = o - v; pthread_mutex_unlock(&L); return o; } \
t __atomic_fetch_and_##n(volatile void *p, t v, int mo){ pthread_mutex_lock(&L); t o = *(volatile t*)p; *(volatile t*)p = o & v; pthread_mutex_unlock(&L); return o; } \
t __atomic_fetch_or_##n(volatile void *p, t v, int mo){ pthread_mutex_lock(&L); t o = *(volatile t*)p; *(volatile t*)p = o | v; pthread_mutex_unlock(&L); return o; } \
t __atomic_fetch_xor_##n(volatile void *p, t v, int mo){ pthread_mutex_lock(&L); t o = *(volatile t*)p; *(volatile t*)p = o ^ v; pthread_mutex_unlock(&L); return o; }
OPS(1, uint8_t) OPS(2, uint16_t) OPS(4, uint32_t) OPS(8, uint64_t)
_Bool __atomic_is_lock_free(size_t sz, const volatile void *p){ (void)sz; (void)p; return 0; }
EOF
cc -O2 -c atomic-shim.c -o "$W/atomic-shim.o"; echo "cle-shim-cc-exit=$?"

echo "=== CONFIGURE ==="
date
CMAKE=/usr/local/bin/cmake
GMAKE=/usr/local/bin/gmake
(cd txiki.js && $CMAKE -S . -B build -DCMAKE_BUILD_TYPE=Release \
   "-DCMAKE_MAKE_PROGRAM=$GMAKE" \
   "-DFETCHCONTENT_SOURCE_DIR_SIMDE=$W/simde-src" \
   -DTJS_USE_ADA=OFF -DBUILD_WITH_FFI=OFF -DBUILD_WITH_MIMALLOC=OFF -DBUILD_WITH_WASM=OFF \
   "-DCMAKE_EXE_LINKER_FLAGS=$W/atomic-shim.o")
echo "cle-configure-exit=$?"
date

echo "=== BUILD TJS (canonical-LE: no regen needed) ==="
(cd txiki.js && $CMAKE --build build -j1)
echo "cle-build-exit=$?"
date
[ -x ./txiki.js/build/tjs ] || { echo "FATAL: no tjs binary after build"; echo "bake-exit=1"; echo "=== GUEST-DONE ==="; exit 1; }
TJS=./txiki.js/build/tjs
ls -l "$TJS"; file "$TJS" 2>/dev/null || true

echo "=== ENGINE SANITY (also proves canonical-LE reads upstream LE bundle bytecode on BE) ==="
(ulimit -t 900; $TJS eval 'const a=typeof __tjs_spawn_sync, b=typeof __tjs_fs_sync; console.log("spawn_sync:",a,"fs_sync:",b); if(a!=="function"||b!=="object") throw new Error("engine sanity failed")' < /dev/null)
echo "cle-engine-exit=$?"

echo "=== SYNC-OUT (gzip|base64 over serial, framed) ==="
cksum "$TJS" | awk '{print "bake-tjs-cksum="$1" bake-tjs-len="$2}'
set +x
echo "=== TJS-GZB64-BEGIN ==="
gzip -9 -c "$TJS" | openssl base64
echo "=== TJS-GZB64-END ==="
echo "bake-exit=0"
echo "=== GUEST-DONE ==="
