#!/bin/sh
# guest-p3.sh — phase-3 scorecard: build the PATCHED tjs in-guest, then probe
# the CURRENT clode-under-tjs stack (bundle 2.1.204) against HOST-SIDE MOCK
# Anthropic servers (no credentials, no live API). Runs INSIDE the
# NetBSD/evbarm-aarch64 guest (fetched by run-in-guest.py --script
# guest-p3.sh). Console output is the evidence; grep for `p3-*-exit=` markers.
# Payload staged by qemu/stage-p3.sh; mock ports come from p3-ports.env
# (written by the host mock-server script after its servers bind).
set -ux
HOSTD=http://10.0.2.2:8080
W=/root/p3work; mkdir -p "$W"; cd "$W"

# Raise the C stack before anything runs tjs: the 4MB JS ceiling needs
# headroom (NetBSD's soft default may be 4MB). Hard-limit fallback keeps going.
ulimit -s 16384 || ulimit -s "$(ulimit -H -s)" || true
ulimit -s

ftp -o PINS.md "$HOSTD/PINS.md"
TJS_TAG=$(awk '$1=="txiki.js"{print $2; exit}' PINS.md)
ftp -o tjs.tgz     "$HOSTD/vendor/dist/txiki-$TJS_TAG.tar.gz"
ftp -o simde.tgz   "$HOSTD/vendor/dist/simde-v0.8.2.tar.gz"
ftp -o runtime.tgz "$HOSTD/vendor/dist/p3-runtime.tar.gz"
ftp -o cli.cjs     "$HOSTD/vendor/dist/cli.cjs"
ftp -o ports.env   "$HOSTD/vendor/dist/p3-ports.env"
# Separate extractions (no && chain): xattr-restore warnings can make tar
# exit nonzero without meaning a broken tree; the dir checks below are the
# real gate.
tar xzf tjs.tgz
tar xzf simde.tgz
tar xzf runtime.tgz
for d in txiki.js simde-src node-shim node_modules; do
  [ -d "$W/$d" ] || { echo "FATAL: $d missing after extraction"; echo "=== GUEST-DONE ==="; exit 1; }
done
[ -f "$W/probes.cjs" ] || { echo "FATAL: probes.cjs missing"; echo "=== GUEST-DONE ==="; exit 1; }
. "$W/ports.env"   # PORT_A (PONG mock), PORT_B (agentic Bash mock)
[ -n "${PORT_A:-}" ] && [ -n "${PORT_B:-}" ] \
  || { echo "FATAL: mock ports missing from p3-ports.env"; echo "=== GUEST-DONE ==="; exit 1; }

# Patched-source sanity before burning ~15 build minutes (one distinctive
# line per phase-3 patch; phase-2 ones are checked at staging too):
grep -c 'cci.origin = NULL' txiki.js/src/httpclient.c            # expect 1
grep -c 'JS_IsNumber(js_stdin)' txiki.js/src/mod_process.c       # expect 1 (spawn-inherit-fd)
grep -c 'return the byte COUNT' txiki.js/src/mod_streams.c       # expect 1 (stream-write-sync-number)
grep -c 'expects initialized streams' txiki.js/src/mod_process.c # expect 1 (spawn-fail-uaf)
ls txiki.js/src/mod_spawn_sync.c

# The bundle's Bash tool shell discovery (jsg() in cli.cjs) accepts ONLY
# paths containing "bash" or "zsh" — SHELL=/bin/sh and even CLAUDE_CODE_SHELL=
# /bin/sh are rejected by the name filter before any exec check, and NetBSD
# base ships /bin/sh only. Run 1's agentic probe failed with "No suitable
# shell found" (tool_result is_error:true); pkgsrc bash (driver --pkgs) closes it.
BASH=/usr/pkg/bin/bash
[ -x "$BASH" ] || { echo "FATAL: pkgsrc bash not installed (Bash tool shell discovery needs bash/zsh)"; echo "=== GUEST-DONE ==="; exit 1; }

# deps/ada needs C++20 constexpr std::string — beyond base g++ 10.5 (the
# phase-1 gate-3 wall). Use pkgsrc gcc12 (pkg_add'd by the driver).
GCC12=/usr/pkg/gcc12/bin
[ -x "$GCC12/g++" ] || { echo "FATAL: pkgsrc gcc12 not installed"; echo "=== GUEST-DONE ==="; exit 1; }
LD_LIBRARY_PATH=/usr/pkg/gcc12/lib; export LD_LIBRARY_PATH

# BUILD_WITH_MIMALLOC=OFF: mimalloc 3.2.7 doesn't compile on NetBSD (upstream
# regression, see phase-2 M4 results). Strip -Werror: clang/MSVC pragmas in
# txiki src trip gcc's -Wunknown-pragmas (see phase-2 M4 results).
sed -i.bak '/list(APPEND tjs_cflags -Werror)/d' txiki.js/CMakeLists.txt
grep -c 'Werror' txiki.js/CMakeLists.txt || true   # expect 0

echo "=== BUILD-TJS ==="
(cd txiki.js && cmake -S . -B build -DCMAKE_BUILD_TYPE=Release \
   "-DCMAKE_C_COMPILER=$GCC12/gcc" "-DCMAKE_CXX_COMPILER=$GCC12/g++" \
   "-DFETCHCONTENT_SOURCE_DIR_SIMDE=$W/simde-src" \
   -DBUILD_WITH_WASM=OFF \
   -DBUILD_WITH_MIMALLOC=OFF \
 && cmake --build build -j2); echo "p3-build-exit=$?"
[ -x ./txiki.js/build/tjs ] || { echo "FATAL: no tjs binary after build"; echo "=== GUEST-DONE ==="; exit 1; }
TJS=./txiki.js/build/tjs

# minimal profile: onboarding done + cwd pre-trusted (shape mirrors the PTY
# harness's seedClaudeProfile in test/e2e-pty.cjs). NO credentials file —
# ANTHROPIC_API_KEY=sk-ant-mock (a dummy) goes to the MOCK servers only.
printf '{"hasCompletedOnboarding":true,"theme":"dark","projects":{"%s":{"hasTrustDialogAccepted":true,"hasCompletedProjectOnboarding":true}}}\n' \
  "$W" > /root/.claude.json

RUNNER=/usr/bin/timeout; [ -x "$RUNNER" ] || RUNNER=""

# --- probe a: engine sanity (sync-spawn + sync-fs globals) -----------------
echo "=== P3-ENGINE ==="
$TJS eval 'const a=typeof __tjs_spawn_sync, b=typeof __tjs_fs_sync; console.log("spawn_sync:",a,"fs_sync:",b); if(a!=="function"||b!=="object") throw new Error("engine sanity failed")'
echo "p3-engine-exit=$?"

# --- probe b: v-flag regexp downgrade path (string-width under the loader) --
echo "=== P3-VFLAG ==="
NODE_PATH="$W/node_modules" $RUNNER ${RUNNER:+120} \
  $TJS run "$W/node-shim/loader.cjs" "$W/probes.cjs" sw
echo "p3-vflag-exit=$?"

# --- probe c: asyncDispose FileHandle tail-reader (Uyn repro) ---------------
echo "=== P3-UYN ==="
NODE_PATH="$W/node_modules" $RUNNER ${RUNNER:+120} \
  $TJS run "$W/node-shim/loader.cjs" "$W/probes.cjs" uyn
echo "p3-uyn-exit=$?"

# --- probe d: mock PONG round-trip (bundle 2.1.204, port A) ------------------
echo "=== P3-PONG ==="
NODE_PATH="$W/node_modules" TERM=vt100 \
  ANTHROPIC_BASE_URL="http://10.0.2.2:$PORT_A" ANTHROPIC_API_KEY=sk-ant-mock \
  $RUNNER ${RUNNER:+300} $TJS run "$W/node-shim/loader.cjs" \
  "$W/cli.cjs" -p 'say PONG' < /dev/null
echo "p3-pong-exit=$?"

# --- probe e: agentic Bash tool round-trip (scripted mock, port B) -----------
# SHELL must point at a bash/zsh-named shell or the Bash tool's discovery
# fails ("No suitable shell found") even though the agentic LOOP works; the
# guest-side exit stays 0 in that case (the mock answers TOOLDONE regardless),
# so the REAL oracle is host-side: the tool_result block in the port-B request
# log must carry the command's stdout with is_error absent/false.
echo "=== P3-AGENTIC ==="
NODE_PATH="$W/node_modules" TERM=vt100 SHELL="$BASH" \
  ANTHROPIC_BASE_URL="http://10.0.2.2:$PORT_B" ANTHROPIC_API_KEY=sk-ant-mock \
  $RUNNER ${RUNNER:+300} $TJS run "$W/node-shim/loader.cjs" \
  "$W/cli.cjs" -p 'run the command' --allowedTools Bash < /dev/null
echo "p3-agentic-exit=$?"

echo "=== GUEST-DONE ==="
