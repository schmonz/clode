#!/bin/sh
# guest-sparc-gates.sh — ENGINE VERDICT for the sparc rung (RUNBOOK-sparc.md
# gates S0 + S3). Runs INSIDE the NetBSD/sparc 10.1 sun4m guest (SS-20,
# -m 512M, snapshot=on). Fetches payload from the host at 10.0.2.2:8180,
# builds bare qjs/qjsc from quickjs-ng v0.15.1 WITHOUT cmake (host-derived
# recipe, see below), runs the S3 big-endian correctness micro-probes FIRST
# (fail-fast: a broken engine invalidates the expensive S0 rows), then the
# S0 RAM-fit measurements (/usr/bin/time -l; NetBSD reports KB).
#
# No-cmake recipe (derived + verified on darwin host 2026-07-09; mirrors
# CMakeLists.txt: qjs lib = dtoa.c libregexp.c libunicode.c quickjs.c,
# qjs-libc = quickjs-libc.c, qjs_exe = qjs.c gen/repl.c gen/standalone.c,
# qjsc = qjsc.c; defines _GNU_SOURCE QUICKJS_NG_BUILD; project-wide
# -funsigned-char; C11 gnu; Release => -DNDEBUG; libs m + pthread).
#
# Markers: s1-*-exit=N (build), s3-<n>-*-exit=N (probes),
# s0-*-exit=N (memory rows), '=== GUEST-DONE ===' at the end.
# Build failures are findings — keep going and report.
set -ux
H=http://10.0.2.2:8180
W=/root/sparcwork
mkdir -p "$W"; cd "$W" || exit 1

echo "=== HOSTINFO ==="
date
uname -a
cc --version 2>&1 | head -2
sysctl hw.model machdep.cpu_arch 2>/dev/null
ulimit -a
# raise the data-size soft limit to its hard limit (32-bit NetBSD defaults
# can be far below physmem; a low limit would masquerade as engine OOM)
ulimit -d unlimited 2>/dev/null || ulimit -d "$(ulimit -H -d)" 2>/dev/null
echo "datasize-now=$(ulimit -d)"

echo "=== RAMPROBE ==="
# what does NetBSD actually map at -m 512M on qemu SS-20? (S0 first question)
dmesg | grep -i 'memory'
sysctl hw.physmem hw.usermem 2>/dev/null
swapctl -l; echo "ramprobe-swap-exit=$?"
df -m /tmp /root

echo "=== FETCH ==="
f1() { # $1=out $2=url ; 3 tries
  n=0
  while [ "$n" -lt 3 ]; do
    ftp -o "$1" "$2" && return 0
    n=$((n+1)); sleep 10
  done
  echo "FETCH-FAILED $2"; return 1
}
f1 qjs.tgz "$H/vendor/dist/quickjs-ng-v0.15.1.tar.gz"; echo "fetch-qjs-src-exit=$?"
f1 exepath.patch "$H/patches/quickjs-ng-js_exepath-netbsd.patch"; echo "fetch-patch-exit=$?"
# run-3 root cause (gdb: SIGBUS `ldd` at quickjs.c:38005, %g1 4-mod-8):
# JSFunctionBytecode's trailing JSValue cpool array sits at sizeof(*b),
# which is 4-mod-8 on sparc32 — 8-byte nan-boxed loads fault. Patch rounds
# cpool_offset to 8 at both layout sites (writer + reader); host-validated.
f1 cpool-align.patch "$H/vendor/dist/quickjs-ng-cpool-align.diff"; echo "fetch-patch2-exit=$?"
f1 probe.js "$H/probe.js"; echo "fetch-probe-exit=$?"
f1 cli.cjs "$H/vendor/dist/cli.cjs"; echo "fetch-cli-exit=$?"
wc -c qjs.tgz exepath.patch cpool-align.patch probe.js cli.cjs

echo "=== BUILD-QJS ==="
date
tar xzf qjs.tgz && mv quickjs-0.15.1 qjs-src
cd "$W/qjs-src" || exit 1
patch -p1 < ../exepath.patch; echo "s1-patch-exit=$?"
patch -p1 < ../cpool-align.patch; echo "s1-patch2-exit=$?"

# ccg: compile one file with an address-space cap so gcc FAILS FAST instead
# of swap-thrashing for hours under TCG (512M guest; clang needed 336MB RSS
# for quickjs.c -O2 on the host). Fallback ladder -O2 -> -O1 -> -O0; the
# chosen level is a marker, not a failure.
CFBASE="-std=gnu11 -funsigned-char -D_GNU_SOURCE -DQUICKJS_NG_BUILD -DNDEBUG -I."
ccg() { # $1 = src (no .c), out $1.o
  for opt in -O2 -O1 -O0; do
    if (ulimit -v 409600; /usr/bin/time cc $opt $CFBASE -c "$1.c" -o "$1.o"); then
      echo "s1-cc-$1-opt=$opt"
      return 0
    fi
    echo "s1-cc-$1-$opt-failed (retrying lower)"
  done
  echo "s1-cc-$1-FAILED-ALL"
  return 1
}
FAIL=0
for f in quickjs libregexp libunicode dtoa quickjs-libc qjs qjsc; do
  ccg "$f" || FAIL=1
done
LIBOBJS="quickjs.o libregexp.o libunicode.o dtoa.o quickjs-libc.o"

# RUN-1 FINDING (2026-07-09): the tarball's gen/repl.c + gen/standalone.c
# are qjsc bytecode PRE-GENERATED on upstream's little-endian 64-bit host;
# JS_ReadObjectAtoms' host-order checksum can never match on BE, so
# `qjs -c` (which JS_ReadObject's qjsc_standalone first) dies with
# "SyntaxError: checksum error" (risk #3 biting the build inputs, not the
# engine). Fix: link qjsc FIRST (qjsc.c has no gen/ dependency),
# REGENERATE the gen files natively (= big-endian), then compile them and
# link qjs. Regen commands are upstream's own (Makefile lines 77-78);
# flow validated on the darwin host with the no-cmake objects.
#
# Link ladder (run-1: plain and -latomic both failed — NetBSD/sparc base
# has no libatomic; shim WORKED): sparc32 (v8) __atomic_* are not
# lock-free -> gcc emits libatomic calls. pthread-mutex shim preserves
# semantics for these single-threaded gates.
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
cc -O2 -c atomic-shim.c -o atomic-shim.o; echo "s1-shim-cc-exit=$?"

linkbin() { # $1 = output, $2... = objects; ladder: plain -> -latomic -> shim
  out="$1"; shift
  if cc -o "$out" "$@" -lm -lpthread 2> "link-$out-1.err"; then
    echo "s1-link-$out-variant=plain"
  elif cc -o "$out" "$@" -lm -lpthread -latomic 2> "link-$out-2.err"; then
    echo "s1-link-$out-variant=latomic"
  elif cc -o "$out" "$@" atomic-shim.o -lm -lpthread 2> "link-$out-3.err"; then
    echo "s1-link-$out-variant=shim"
  else
    sed -n 1,10p "link-$out-1.err" "link-$out-3.err"
    echo "s1-link-$out-variant=none"
    return 1
  fi
}

# 1. qjsc (no gen/ dependency)
linkbin qjsc qjsc.o $LIBOBJS || FAIL=1
# 2. regenerate the gen bytecode natively (big-endian)
./qjsc -ss -o gen/repl.c -m repl.js; echo "s1-regen-repl-exit=$?"
./qjsc -ss -o gen/standalone.c -m standalone.js; echo "s1-regen-standalone-exit=$?"
head -5 gen/standalone.c | tail -2
# 3. compile regenerated gen files, link qjs
ccg gen/repl || FAIL=1
ccg gen/standalone || FAIL=1
QJSOBJS="qjs.o gen/repl.o gen/standalone.o"
linkbin qjs $QJSOBJS $LIBOBJS || FAIL=1
[ -x ./qjs ] || FAIL=1
ls -l qjs qjsc
echo "s1-build-qjs-exit=$FAIL"
date
Q="$W/qjs-src/qjs"
cd "$W" || exit 1

echo "=== S3 (BE correctness micro-probes, bare qjs) ==="
# 3.1 minimal life sign — if 32-bit-BE quickjs-ng is broken, fail here first
(ulimit -t 900; "$Q" --eval 'print(1+1)' < /dev/null); echo "s3-1-print-exit=$?"
# 3.2 endianness self-check: host order must be BIG; DataView explicit-endian
(ulimit -t 900; "$Q" --eval 'const u8=new Uint8Array(new Uint16Array([1]).buffer);const b=new ArrayBuffer(4);const dv=new DataView(b);dv.setUint32(0,0x11223344,false);const v8=new Uint8Array(b);print("host-BE="+(u8[0]===0)+" dv-be-byte0=0x"+v8[0].toString(16)+" dv-le-read=0x"+dv.getUint32(0,true).toString(16));if(u8[0]!==0)throw new Error("host order not big-endian");if(v8[0]!==0x11)throw new Error("DataView BE write broken");if(dv.getUint32(0,true)!==0x44332211)throw new Error("DataView LE read broken")' < /dev/null); echo "s3-2-endian-exit=$?"
# 3.3 regexp char classes + unicode (historically BE-buggy lre paths)
(ulimit -t 900; "$Q" --eval 'if(!/[a-z]+/u.test("abc"))throw new Error("u-flag charclass");if(!/\p{L}/u.test("\u00e9"))throw new Error("p{L} u-flag");if("a1b2".replace(/[0-9]/g,"")!=="ab")throw new Error("global charclass");print("regexp-ok");try{print("vflag-informational="+/[\p{L}]/v.test("x"))}catch(e){print("vflag-informational-ERR "+e)}' < /dev/null); echo "s3-3-regexp-exit=$?"
# 3.4 bytecode round-trip IN-GUEST (BE-produced, BE-consumed; js_exepath patch
# is what makes the standalone actually run its payload on NetBSD)
printf 'print("bc-ok",6*7);\n' > hello.js
(ulimit -t 1800; "$Q" -c hello.js -o hello-exe && ./hello-exe < /dev/null); echo "s3-4-bytecode-exit=$?"
# 3.5 dtoa / Date / JSON spot checks
(ulimit -t 900; "$Q" --eval 'const s=(0.1+0.2).toString();print("sum="+s);if(s!=="0.30000000000000004")throw new Error("dtoa");const n=Date.now();print("now="+n);if(!(n>1600000000000&&n<9999999999999))throw new Error("Date.now");const j=JSON.parse("{\"a\":1e300}");print("j.a="+j.a);if(j.a!==1e300)throw new Error("json 1e300")' < /dev/null); echo "s3-5-dtoa-date-json-exit=$?"
# 3.6 full capability probe (diff against gate2 darwin control)
(ulimit -t 1800; "$Q" probe.js < /dev/null); echo "s3-6-probe-exit=$?"
echo "s3-7-inventory=SKIPPED (inventory.cjs is node/tjs-only CommonJS; S2-prime scope)"

echo "=== S0 (RAM-fit measurements; /usr/bin/time -l, NetBSD units = KB) ==="
date
# control: interpreter floor
(ulimit -t 900; /usr/bin/time -l "$Q" --eval '1+1' < /dev/null > /dev/null); echo "s0-control-exit=$?"
# ladder rung (a): run-from-source peak on the 19MB bundle. Crash at first
# missing Node API is EXPECTED evidence; OOM/timeout is a DATA POINT.
(ulimit -t 5400; /usr/bin/time -l "$Q" cli.cjs < /dev/null > /dev/null); echo "s0-run-from-source-exit=$?"
# ladder rung (b/c) producer: compile peak (bytecode-embedding standalone)
(ulimit -t 5400; /usr/bin/time -l "$Q" -c cli.cjs -o /tmp/bundle-exe < /dev/null); echo "s0-compile-exit=$?"
ls -l /tmp/bundle-exe 2>/dev/null
# ladder rung (b/c) consumer: run-from-bytecode peak
if [ -x /tmp/bundle-exe ]; then
  (ulimit -t 1800; /usr/bin/time -l /tmp/bundle-exe < /dev/null > /dev/null); echo "s0-run-from-bytecode-exit=$?"
else
  echo "s0-run-from-bytecode-exit=SKIP (no /tmp/bundle-exe)"
fi
date
echo "=== GUEST-DONE ==="
