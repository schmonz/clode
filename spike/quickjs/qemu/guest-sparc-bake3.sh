#!/bin/sh
# guest-sparc-bake3.sh — PHASE A run 3 (persist): cmake, take three.
# Run 2 (sparc-s2a-console.log.run2) died at the FINAL bin/cmake link:
# undefined __atomic_fetch_add_8/_sub_8 — the S0 campaign's Wall #3
# (NetBSD/sparc base has NO libatomic; sparc32 __atomic_*_8 are libcalls)
# biting cmake itself. Every referencing object was cmDebugger*/cmcppdap
# (cmake's DAP debugger). Run 2's unconditional CLEANUP then deleted the
# ~9h build tree before halt (lesson: cleanup only on success).
# Fixes here:
#   1. ./bootstrap --no-debugger  (first-class flag; drops cmDebugger +
#      cmcppdap = the only 64-bit-atomics users, and shrinks the build)
#   2. belt-and-suspenders: pthread-mutex __atomic_* shim object passed via
#      -DCMAKE_EXE_LINKER_FLAGS (proven in the S0 gates; also inoculates
#      ctest/cpack links if anything else uses _8 atomics)
#   3. CLEANUP runs only when a-cmake-exit=0.
# gmake 4.4.1 is already baked (/usr/local/bin/make + gmake symlink, runs 1-2).
set -ux
H=http://10.0.2.2:8180
W=/root/bakework
mkdir -p "$W"; cd "$W" || exit 1

echo "=== HOSTINFO ==="
date
uname -a
df -m /
ulimit -d unlimited 2>/dev/null || ulimit -d "$(ulimit -H -d)" 2>/dev/null
echo "datasize-now=$(ulimit -d)"
ulimit -t 7200
echo "cputime-now=$(ulimit -t)"
GMAKE=/usr/local/bin/gmake
"$GMAKE" --version > /tmp/gmv.txt 2>&1
echo "a3-gmake-present-exit=$?"
sed -n 1,1p /tmp/gmv.txt
[ -x "$GMAKE" ] || { echo "a-cmake-exit=SKIP (probed $GMAKE: not executable)"; echo "=== GUEST-DONE ==="; exit 1; }

echo "=== ATOMIC-SHIM ==="
# Same shim as the S0 gates (results/phase3-sparc-engine-verdict.md Wall #3);
# single global pthread mutex, semantically sound for cmake's uses too.
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
cc -O2 -c atomic-shim.c -o "$W/atomic-shim.o"; echo "a3-shim-cc-exit=$?"

echo "=== BAKE-CMAKE (take 3: --no-debugger + shim) ==="
f1() { n=0; while [ "$n" -lt 3 ]; do ftp -o "$1" "$2" && return 0; n=$((n+1)); sleep 10; done; echo "FETCH-FAILED $2"; return 1; }
f1 cmake.tgz "$H/vendor/dist/srcpkgs/cmake-3.28.6.tar.gz"
echo "a-fetch-cmake-exit=$?"
wc -c cmake.tgz
rm -rf cmake-3.28.6
tar xzf cmake.tgz || echo "a-cmake-untar-failed"
cd "$W/cmake-3.28.6" || exit 1
env MAKE="$GMAKE" ./bootstrap --prefix=/usr/local --parallel=1 --no-debugger -- \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_C_FLAGS_RELEASE="-O1 -DNDEBUG" \
  -DCMAKE_CXX_FLAGS_RELEASE="-O1 -DNDEBUG" \
  -DBUILD_TESTING=OFF \
  -DBUILD_CursesDialog=OFF \
  -DCMAKE_USE_OPENSSL=OFF \
  "-DCMAKE_EXE_LINKER_FLAGS=$W/atomic-shim.o"
echo "a-cmake-bootstrap-exit=$?"
date
"$GMAKE"
echo "a-cmake-build-exit=$?"
"$GMAKE" install
CINST=$?
echo "a-cmake-exit=$CINST"
/usr/local/bin/cmake --version
echo "a-cmake-version-exit=$?"
date

if [ "$CINST" = 0 ]; then
  echo "=== CLEANUP (success only; keep the baked image lean) ==="
  cd "$W" || exit 1
  rm -rf make-4.4.1 cmake-3.28.6 make.tgz cmake.tgz atomic-shim.c
  df -m /
else
  echo "=== CLEANUP SKIPPED (build tree kept for post-mortem/relink) ==="
  df -m /
fi
sync
echo "=== GUEST-DONE ==="
