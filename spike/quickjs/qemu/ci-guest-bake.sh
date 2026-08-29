#!/bin/sh
# ci-guest-bake.sh — the in-guest ENGINE bake, run IN a BAKED (gmake+cmake)
# sun4m guest by ci-sparc-driver.py on a tjs-cache MISS. Builds the
# clode-compatible sparc `tjs` from clode's PINNED canonical-LE source, then
# SYNCS IT OUT over the serial console (gzip|base64, framed) so the x64 runner
# can cross-fuse the builder against it. Proven in the docker-loop wall-walk
# (2026-07-14). The caller stages, under the served workspace at
# .matrix/qemu-bake/ (http://10.0.2.2:8180/.matrix/qemu-bake/):
#   txiki-canonical-le.tar.gz  — a tar of the patched, BYTECODE-REGENERATED
#                                txiki.js tree (scripts/build-tjs.mjs
#                                --source-only then --regen-only)
#   simde-v0.8.2.tar.gz        — the simde source (FetchContent offline)
#   engine-api-floor.js        — the shared engine-API floor check, generated
#                                from scripts/engine-api-floor.mjs
# canonical-LE matters: it makes the engine READ little-endian bytecode on this
# big-endian host, so (a) NO in-guest tjsc BE-regen is needed, and (b) the LE
# bytecode the linux cross-fuse worker writes is readable here (a non-canonical
# engine gives "SyntaxError: checksum error" on the cross-fused builder).
# Keeps the sparc32 atomic-shim (base has no libatomic). Flags match the leg:
# ADA=OFF/wurl, FFI/MIMALLOC/WASM off.
#
# THIS SCRIPT DOES NOT GENERATE ANYTHING. It compiles a tree that arrived
# complete. That is deliberate and it is the fix for a real bug: this used to be
# the ONE build path in the matrix that did not run scripts/build-tjs.mjs, and it
# hand-rolled a cmake invocation with no bytecode regen — so the JS half of
# patches/txiki-engine-module-meta.patch (src/js/core/engine.js, which reaches a
# binary only through a regen of txiki's git-tracked pre-compiled
# src/bundles/c/**) never landed, and the leg died 927 seconds into the fuse with
# "quaude-fuse: this engine does not report moduleMeta". Canonical-LE removed the
# need to regen for ENDIANNESS; it said nothing about CONTENT. The runner now
# regenerates with --regen-only, using the same functions every other leg uses,
# and the two checks below (cle-regen-present, cle-floor-exit) make it impossible
# for a non-regenerated tree to get this far again in silence.
# Markers: cle-fetch-*, cle-canon-present, cle-regen-present, cle-configure-exit,
# cle-build-exit, cle-floor-exit, bake-tjs-cksum=, bake-exit, === GUEST-DONE ===.
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
f1 engine-api-floor.js "$S/engine-api-floor.js"; echo "cle-fetch-floor-exit=$?"
wc -c tjs.tgz simde.tgz engine-api-floor.js
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

# The bytecode arrays MUST have been regenerated on the runner (build-tjs.mjs
# --regen-only), or this build compiles the upstream pin's committed bytecode and
# silently drops every src/js/** patch — the moduleMeta bug, and before it the
# whole class 0c72693 was written to close. build-tjs.mjs stamps each regenerated
# .c with a `clode:bytecode-regen src=... sha256=...` trailer; demand it HERE, in
# the first minute, rather than discovering the omission 927 seconds into a fuse.
REGEN=$(cat txiki.js/src/bundles/c/core/core.c txiki.js/src/bundles/c/core/polyfills.c 2>/dev/null | grep -c 'clode:bytecode-regen') || REGEN=0
echo "cle-regen-present=$REGEN"
[ "$REGEN" -ge 2 ] || { echo "FATAL: served tree was NOT bytecode-regenerated (no clode:bytecode-regen trailer in src/bundles/c/core/) — the runner must run 'node scripts/build-tjs.mjs --regen-only' over this tree before tarring it, or the engine ships without the JS half of every src/js/** patch"; echo "bake-exit=1"; echo "=== GUEST-DONE ==="; exit 1; }

# Strip -Werror (clang/MSVC pragmas trip gcc -Wunknown-pragmas)
sed -i.bak '/list(APPEND tjs_cflags -Werror)/d' txiki.js/CMakeLists.txt

# CLODE_GUEST_ATOMIC_SHIM=1 (default): link the __atomic_*_8 pthread shim for
# 32-bit targets with no libatomic (sparc, m68k). Set 0 for native-64-bit-atomics.
SHIM="${CLODE_GUEST_ATOMIC_SHIM:-1}"
SHIM_LDFLAGS=""
if [ "$SHIM" = 1 ]; then
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
SHIM_LDFLAGS="$W/atomic-shim.o"
fi

echo "=== CONFIGURE ==="
date
CMAKE=/usr/local/bin/cmake
GMAKE=/usr/local/bin/gmake
(cd txiki.js && $CMAKE -S . -B build -DCMAKE_BUILD_TYPE=Release \
   "-DCMAKE_MAKE_PROGRAM=$GMAKE" \
   "-DFETCHCONTENT_SOURCE_DIR_SIMDE=$W/simde-src" \
   -DTJS_USE_ADA=OFF -DBUILD_WITH_FFI=OFF -DBUILD_WITH_MIMALLOC=OFF -DBUILD_WITH_WASM=OFF \
   "-DCMAKE_EXE_LINKER_FLAGS=$SHIM_LDFLAGS")
echo "cle-configure-exit=$?"
date

# No regen step here: the served tree arrived already regenerated (asserted
# above). Compiling is all this guest does — see the header.
echo "=== BUILD TJS (tree pre-regenerated on the runner) ==="
(cd txiki.js && $CMAKE --build build -j1)
echo "cle-build-exit=$?"
date
[ -x ./txiki.js/build/tjs ] || { echo "FATAL: no tjs binary after build"; echo "bake-exit=1"; echo "=== GUEST-DONE ==="; exit 1; }
TJS=./txiki.js/build/tjs
ls -l "$TJS"; file "$TJS" 2>/dev/null || true

# ENGINE SANITY is now the SHARED engine-API floor (scripts/engine-api-floor.mjs),
# fetched above — not a fourth hand-written `typeof __tjs_fs_sync` copy. Running
# it also proves canonical-LE reads upstream LE bundle bytecode on this BE host.
# A missing binding prints MISSING-ENGINE-API: <name> and exits nonzero, so the
# driver's cle-floor-exit=0 rule turns it red here, minutes in, instead of at the
# fuse at the end of the longest job in the matrix.
echo "=== ENGINE API FLOOR (shared list; also proves canonical-LE reads LE bytecode on BE) ==="
(ulimit -t 900; $TJS run "$W/engine-api-floor.js" < /dev/null)
echo "cle-floor-exit=$?"

echo "=== SYNC-OUT (gzip|base64 over serial, framed) ==="
cksum "$TJS" | awk '{print "bake-tjs-cksum="$1" bake-tjs-len="$2}'
set +x
echo "=== TJS-GZB64-BEGIN ==="
gzip -9 -c "$TJS" | openssl base64
echo "=== TJS-GZB64-END ==="
echo "bake-exit=0"
echo "=== GUEST-DONE ==="
