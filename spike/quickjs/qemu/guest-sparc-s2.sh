#!/bin/sh
# guest-sparc-s2.sh — sparc rung gates S2 + S4 + S5: build the FULL patched
# tjs (pure-C configuration: TJS_USE_ADA=OFF selects deps/wurl, no C++20, so
# base gcc/g++ 10.5 suffices — the wurl patch is what unblocked this rung),
# then boot the clode loader (S4 hello.cjs) and run the mock-PONG -p flow
# (S5, bundle 2.1.204, host-side mock at 10.0.2.2:$PORT_A, NO live network).
# Runs INSIDE the NetBSD/sparc 10.1 sun4m guest (SS-20, -m 512M, snapshot=on;
# the gmake+cmake bake from phase A persists in the image).
#
# Build divergences vs the aarch64 p3 run, all deliberate:
#   -DTJS_USE_ADA=OFF        (wurl instead of ada; the campaign's point)
#   -DBUILD_WITH_FFI=OFF     (sparc32 libffi = moderate risk, FFI unused by
#                             S4/S5; aarch64 built FFI=ON via pkgsrc libffi)
#   -j1                      (single TCG vcpu)
#   base gcc 10.5            (no pkgsrc gcc12 exists for sparc; none needed)
#   atomic-shim.o via CMAKE_EXE_LINKER_FLAGS (NetBSD/sparc base has NO
#                             libatomic; sparc32 __atomic_*_8 are libcalls —
#                             covers tjs AND the in-build qjsc host tool,
#                             which regenerates core bytecode natively = BE)
# Same as p3: -DBUILD_WITH_MIMALLOC=OFF, -DBUILD_WITH_WASM=OFF, -Werror
# stripped, simde pre-seeded (harmless with WASM off).
#
# Markers: s2-fetch-*, s2-configure-exit, s2-build-exit, s2-engine-exit,
# s2-wurl-url-probe-exit, s4-loader-exit, s5-pong-exit, '=== GUEST-DONE ==='.
# Failures are findings — keep going and report.
set -ux
H=http://10.0.2.2:8180
W=/root/s2work
mkdir -p "$W"; cd "$W" || exit 1

echo "=== HOSTINFO ==="
date
uname -a
cc --version 2>&1 | head -2
c++ --version 2>&1 | head -2
/usr/local/bin/gmake --version 2>&1 | head -1; echo "bake-gmake-present=$?"
/usr/local/bin/cmake --version 2>&1 | head -1; echo "bake-cmake-present=$?"
df -m / /tmp
# data-size soft limit up to hard; C stack up for the 4MB JS ceiling (p3)
ulimit -d unlimited 2>/dev/null || ulimit -d "$(ulimit -H -d)" 2>/dev/null
ulimit -s 16384 2>/dev/null || ulimit -s "$(ulimit -H -s)" 2>/dev/null || true
echo "datasize-now=$(ulimit -d) stacksize-now=$(ulimit -s)"
# per-process CPU cap: runaway guard, inherited by every compile/probe child
ulimit -t 7200
echo "cputime-now=$(ulimit -t)"

echo "=== FETCH ==="
f1() { # $1=out $2=url ; 3 tries
  n=0
  while [ "$n" -lt 3 ]; do
    ftp -o "$1" "$2" && return 0
    n=$((n+1)); sleep 10
  done
  echo "FETCH-FAILED $2"; return 1
}
f1 tjs.tgz     "$H/vendor/dist/txiki-v26.6.0-s2.tar.gz"; echo "s2-fetch-tjs-exit=$?"
f1 simde.tgz   "$H/vendor/dist/simde-v0.8.2.tar.gz";     echo "s2-fetch-simde-exit=$?"
f1 runtime.tgz "$H/vendor/dist/s2-runtime.tar.gz";       echo "s2-fetch-runtime-exit=$?"
f1 cli.cjs     "$H/vendor/dist/cli.cjs";                 echo "s2-fetch-cli-exit=$?"
f1 ports.env   "$H/vendor/dist/s2-ports.env";            echo "s2-fetch-ports-exit=$?"
wc -c tjs.tgz simde.tgz runtime.tgz cli.cjs ports.env

# Separate extractions (xattr-restore warnings can make tar exit nonzero
# without a broken tree; the dir checks below are the real gate)
tar xzf tjs.tgz
tar xzf simde.tgz
tar xzf runtime.tgz
for d in txiki.js simde-src node-shim node_modules; do
  [ -d "$W/$d" ] || { echo "FATAL: $d missing after extraction"; echo "=== GUEST-DONE ==="; exit 1; }
done
[ -f "$W/hello.cjs" ] || { echo "FATAL: hello.cjs missing"; echo "=== GUEST-DONE ==="; exit 1; }
. "$W/ports.env"   # PORT_A (PONG mock)
[ -n "${PORT_A:-}" ] || { echo "FATAL: mock port missing from s2-ports.env"; echo "=== GUEST-DONE ==="; exit 1; }

# Patched-source sanity before burning build hours (p3 set + this campaign's
# two: cpool-align applied in deps/quickjs, wurl vendored):
grep -c 'cci.origin = NULL' txiki.js/src/httpclient.c            # expect 1
grep -c 'JS_IsNumber(js_stdin)' txiki.js/src/mod_process.c       # expect 1
grep -c 'return the byte COUNT' txiki.js/src/mod_streams.c       # expect 1
grep -c 'expects initialized streams' txiki.js/src/mod_process.c # expect 1
grep -c 'function_size + 7' txiki.js/deps/quickjs/quickjs.c      # expect 2
grep -c 'KERN_PROC_PATHNAME' txiki.js/deps/quickjs/cutils.h      # expect >=1
ls txiki.js/src/mod_spawn_sync.c txiki.js/deps/wurl/wurl_url.c
grep -c 'TJS_USE_ADA' txiki.js/CMakeLists.txt                    # expect >=1
# plain-JS bundles for the BE regen (host-esbuild'd; 4 core + 12 stdlib)
ls txiki.js/src/bundles/js/core/*.js txiki.js/src/bundles/js/stdlib/*.js | wc -l  # expect 16
[ -f txiki.js/src/bundles/js/core/polyfills.js ] || { echo "FATAL: staged js bundles missing"; echo "=== GUEST-DONE ==="; exit 1; }

# Strip -Werror (clang/MSVC pragmas in txiki src trip gcc -Wunknown-pragmas)
sed -i.bak '/list(APPEND tjs_cflags -Werror)/d' txiki.js/CMakeLists.txt
grep -c 'Werror' txiki.js/CMakeLists.txt || true   # expect 0

echo "=== ATOMIC-SHIM ==="
# NetBSD/sparc base has no libatomic and sparc32 (v8) __atomic_*_8 lower to
# libcalls (S0 campaign, link ladder: plain and -latomic both failed, shim
# WORKED — results/phase3-sparc-engine-verdict.md Wall #3). pthread-mutex
# shim; global lock is semantically sound (tjs Workers are not exercised by
# these gates). Passed as an extra link input via CMAKE_EXE_LINKER_FLAGS —
# object files are always fully included regardless of command-line position,
# so flags-before-objects ordering is safe; covers every executable target
# (tjs itself AND deps/quickjs's qjsc build tool).
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
cc -O2 -c atomic-shim.c -o "$W/atomic-shim.o"; echo "s2-shim-cc-exit=$?"

echo "=== S2 BUILD-TJS ==="
date
CMAKE=/usr/local/bin/cmake
GMAKE=/usr/local/bin/gmake
(cd txiki.js && $CMAKE -S . -B build -DCMAKE_BUILD_TYPE=Release \
   "-DCMAKE_MAKE_PROGRAM=$GMAKE" \
   "-DFETCHCONTENT_SOURCE_DIR_SIMDE=$W/simde-src" \
   -DTJS_USE_ADA=OFF \
   -DBUILD_WITH_FFI=OFF \
   -DBUILD_WITH_MIMALLOC=OFF \
   -DBUILD_WITH_WASM=OFF \
   "-DCMAKE_EXE_LINKER_FLAGS=$W/atomic-shim.o")
echo "s2-configure-exit=$?"
date

echo "=== S2 TJSC + BE BUNDLE REGEN ==="
# Run-B1 wall: txiki ships its core/stdlib JS as PRE-COMPILED BYTECODE .c
# arrays in-tree (src/bundles/c/**), LE-baked on upstream's host. Host-order
# bytecode -> "SyntaxError: checksum error" -> vm.c:484 boot assert (exit
# 134) on BE — the quickjs gen/*.c wall one layer up. Fix: build tjsc first
# (src/qjsc.c + libqjs, EXCLUDE_FROM_ALL, bundle-free, cpool-patched writer)
# and regenerate ALL 18 bundle .c files natively (= big-endian) from the
# plain-JS bundles staged in the tarball (src/bundles/js/**, esbuild'd on
# the host per the Makefile rules — text, endian-neutral). Exact tjsc flags
# from the Makefile rules (incl. TJSC_PARAMS_STIP=-s release strip).
(cd txiki.js && $CMAKE --build build --target tjsc -j1)
echo "s2-tjsc-exit=$?"
[ -x txiki.js/build/tjsc ] || { echo "FATAL: no tjsc after build"; echo "=== GUEST-DONE ==="; exit 1; }
cd txiki.js || exit 1
RFAIL=0
regen() { # $1=out.c $2=module-name $3=var-prefix $4=in.js
  mkdir -p "$(dirname "$1")"
  ./build/tjsc -m -s -o "$1" -n "$2" -p "$3" "$4" || { echo "s2-regen-FAIL $1"; RFAIL=1; }
}
regen src/bundles/c/core/polyfills.c "tjs:internal/polyfills" tjs__ src/bundles/js/core/polyfills.js
regen src/bundles/c/core/core.c "tjs:internal/bootstrap" tjs__ src/bundles/js/core/core.js
regen src/bundles/c/core/run-main.c "tjs:internal/run-main" tjs__ src/bundles/js/core/run-main.js
regen src/bundles/c/core/run-repl.c "tjs:internal/run-repl" tjs__ src/bundles/js/core/run-repl.js
regen src/bundles/c/core/worker-bootstrap.c "tjs:internal/worker-bootstrap" tjs__ src/js/worker/worker-bootstrap.js
regen src/bundles/c/internal/path.c "tjs:internal/path" tjs__internal_ src/js/internal/path.js
for f in src/bundles/js/stdlib/*.js; do
  n=$(basename "$f" .js)
  regen "src/bundles/c/stdlib/$n.c" "tjs:$n" tjs__ "$f"
done
echo "s2-regen-exit=$RFAIL"
[ "$RFAIL" = 0 ] || { echo "FATAL: BE bundle regen failed"; echo "=== GUEST-DONE ==="; exit 1; }
head -3 src/bundles/c/core/polyfills.c
cd "$W" || exit 1
date

(cd txiki.js && $CMAKE --build build -j1)
echo "s2-build-exit=$?"
date
[ -x ./txiki.js/build/tjs ] || { echo "FATAL: no tjs binary after build"; echo "=== GUEST-DONE ==="; exit 1; }
TJS=./txiki.js/build/tjs
ls -l ./txiki.js/build/tjs

echo "=== S2-ENGINE (sync-spawn + sync-fs globals) ==="
(ulimit -t 900; $TJS eval 'const a=typeof __tjs_spawn_sync, b=typeof __tjs_fs_sync; console.log("spawn_sync:",a,"fs_sync:",b); if(a!=="function"||b!=="object") throw new Error("engine sanity failed")' < /dev/null)
echo "s2-engine-exit=$?"

echo "=== S2-WURL (URL parsing on 32-bit BE: components, punycode, loud IDNA reject) ==="
(ulimit -t 900; $TJS eval '
const u = new URL("https://user@example.com:8443/p/q?x=1&y=2#frag");
console.log("wurl-basic", u.protocol, u.username, u.hostname, u.port, u.pathname, u.search, u.hash);
if (u.hostname !== "example.com" || u.port !== "8443" || u.pathname !== "/p/q") throw new Error("basic URL components wrong");
const p = new URL("http://bücher.example/x");
console.log("wurl-punycode", p.hostname);
if (p.hostname !== "xn--bcher-kva.example") throw new Error("punycode hostname wrong: " + p.hostname);
const s = new URL("http://☃.example/");
console.log("wurl-punycode-snowman", s.hostname);
if (s.hostname !== "xn--n3h.example") throw new Error("snowman punycode wrong: " + s.hostname);
const sp = new URL("https://h.example/a?b=c");
sp.searchParams.append("k", "v v");
console.log("wurl-params", sp.href);
if (sp.href !== "https://h.example/a?b=c&k=v+v") throw new Error("searchParams roundtrip wrong: " + sp.href);
// U+200D ZWJ: context-dependent joiner, REJECTED by the L1 allow-bitmap
// (verified against idna_allow.h on the host) — the loud accepted-reject class
let rejected = false;
try { new URL("http://a\u200Db.example/"); } catch (e) { rejected = true; console.log("wurl-idna-reject LOUD:", String(e).slice(0, 120)); }
if (!rejected) throw new Error("IDNA L1-disallowed host (U+200D ZWJ) was silently ACCEPTED");
console.log("wurl-probe-ok");
' < /dev/null)
echo "s2-wurl-url-probe-exit=$?"

echo "=== S4 (loader boots hello.cjs under node-shim) ==="
(ulimit -t 1800; NODE_PATH="$W/node_modules" $TJS run "$W/node-shim/loader.cjs" "$W/hello.cjs" < /dev/null)
echo "s4-loader-exit=$?"

echo "=== S5 (mock PONG, bundle 2.1.204, -p flow, host mock 10.0.2.2:$PORT_A) ==="
# minimal profile: onboarding done + cwd pre-trusted (p3 pattern). NO
# credentials — ANTHROPIC_API_KEY=sk-ant-mock goes to the MOCK only.
printf '{"hasCompletedOnboarding":true,"theme":"dark","projects":{"%s":{"hasTrustDialogAccepted":true,"hasCompletedProjectOnboarding":true}}}\n' \
  "$W" > /root/.claude.json
RUNNER=/usr/bin/timeout; [ -x "$RUNNER" ] || RUNNER=""
date
(ulimit -t 3600; NODE_PATH="$W/node_modules" TERM=vt100 \
  ANTHROPIC_BASE_URL="http://10.0.2.2:$PORT_A" ANTHROPIC_API_KEY=sk-ant-mock \
  $RUNNER ${RUNNER:+3000} $TJS run "$W/node-shim/loader.cjs" \
  "$W/cli.cjs" -p 'say PONG' < /dev/null)
echo "s5-pong-exit=$?"
date
echo "=== GUEST-DONE ==="
