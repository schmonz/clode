#!/bin/sh
# guest-sparc-debug.sh — DEBUG run for the qjsc bytecode-writer SIGBUS on
# NetBSD/sparc 10.1 (run-2 finding: `qjsc -ss -o gen/repl.c -m repl.js`
# exits 138 = 128+SIGBUS, deterministically, while the same-recipe qjs
# interpreter runs 19MB of JS fine). Goal: come back with a FILE:LINE
# backtrace, not a pass. Authorized as a one-off diagnostic run.
#
# A/B/C matrix (all with -g, all linked with the atomic _8 shim):
#   A: -O2                  (the faulting configuration, now with symbols)
#   B: -O0                  (does the fault survive without optimization?
#                            no -> gcc alignment-assumption strength-reduction;
#                            yes -> genuine unaligned access in source logic)
#   C: -O2 -fno-strict-aliasing  (cheap aliasing-UB discriminator)
# Each variant: plain run (exit code), tiny-module + tiny-script repros
# (how minimal is the repro?), then gdb -batch backtrace on the repl.js case.
# Markers: dbg-<v>-exit= / dbg-<v>-tinym-exit= / dbg-<v>-tinys-exit= /
# dbg-<v>-gdb-exit= ; sections === DBG-<v> === ; === GUEST-DONE === at end.
set -ux
H=http://10.0.2.2:8180
W=/root/sparcdbg
mkdir -p "$W"; cd "$W" || exit 1

echo "=== HOSTINFO ==="
date; uname -a
cc --version 2>&1 | head -1
command -v gdb; gdb --version 2>&1 | head -1; echo "gdb-present-exit=$?"
ulimit -d unlimited 2>/dev/null || ulimit -d "$(ulimit -H -d)" 2>/dev/null
ulimit -c unlimited
ulimit -a | head -12

echo "=== FETCH ==="
f1() { n=0; while [ "$n" -lt 3 ]; do ftp -o "$1" "$2" && return 0; n=$((n+1)); sleep 10; done; echo "FETCH-FAILED $2"; return 1; }
f1 qjs.tgz "$H/vendor/dist/quickjs-ng-v0.15.1.tar.gz"; echo "fetch-qjs-src-exit=$?"
f1 exepath.patch "$H/patches/quickjs-ng-js_exepath-netbsd.patch"; echo "fetch-patch-exit=$?"
tar xzf qjs.tgz && mv quickjs-0.15.1 qjs-src
cd "$W/qjs-src" || exit 1
patch -p1 < ../exepath.patch; echo "patch-exit=$?"

CFBASE="-g -std=gnu11 -funsigned-char -D_GNU_SOURCE -DQUICKJS_NG_BUILD -DNDEBUG -I."
SRCS="quickjs libregexp libunicode dtoa quickjs-libc qjsc"

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
cc -O2 -c atomic-shim.c -o atomic-shim.o; echo "shim-cc-exit=$?"

printf 'export default 1;\n' > tiny-module.js
printf 'var x = 1;\n' > tiny-script.js

# build one variant: $1 = name, $2... = extra cflags
buildv() {
  name="$1"; shift
  echo "=== BUILD-$name ==="
  date
  ok=0
  for f in $SRCS; do
    if ! (ulimit -v 409600; cc "$@" $CFBASE -c "$f.c" -o "$f-$name.o"); then
      echo "dbg-$name-cc-$f-FAILED"; ok=1
    fi
  done
  cc -o "qjsc-$name" qjsc-$name.o quickjs-$name.o libregexp-$name.o \
     libunicode-$name.o dtoa-$name.o quickjs-libc-$name.o atomic-shim.o \
     -lm -lpthread || ok=1
  echo "dbg-$name-build-exit=$ok"
  date
  return $ok
}

# probe one variant
probev() {
  name="$1"
  echo "=== DBG-$name ==="
  rm -f ./*.core /tmp/out-$name-*.c
  ./"qjsc-$name" -ss -o "/tmp/out-$name-repl.c" -m repl.js
  echo "dbg-$name-exit=$?"
  ./"qjsc-$name" -ss -o "/tmp/out-$name-tinym.c" -m tiny-module.js
  echo "dbg-$name-tinym-exit=$?"
  ./"qjsc-$name" -ss -o "/tmp/out-$name-tinys.c" tiny-script.js
  echo "dbg-$name-tinys-exit=$?"
  ls -l ./*.core 2>/dev/null
  echo "--- dbg-$name-gdb-bt (repl.js case) ---"
  gdb -batch \
      -ex 'set pagination off' \
      -ex run \
      -ex 'bt full' \
      -ex 'info registers' \
      -ex 'x/3i $pc' \
      --args ./"qjsc-$name" -ss -o "/tmp/out-$name-gdb.c" -m repl.js
  echo "dbg-$name-gdb-exit=$?"
}

buildv O2 -O2 && probev O2
buildv O0 -O0 && probev O0
buildv FNSA -O2 -fno-strict-aliasing && probev FNSA

echo "=== GUEST-DONE ==="
