#!/bin/sh
# guest-m4.sh — phase-2 M4: build the PATCHED tjs in-guest, then run the real
# Claude Code bundle under it, subscription-authenticated, against the live
# API. Runs INSIDE the NetBSD/evbarm-aarch64 guest (fetched by
# run-in-guest.py --script guest-m4.sh). Console output is the evidence.
# Payload staged by qemu/stage-m4.sh on the host.
set -ux
HOSTD=http://10.0.2.2:8080
W=/root/m4work; mkdir -p "$W"; cd "$W"

# Raise the C stack before anything runs tjs: the 4MB JS ceiling needs
# headroom (NetBSD's soft default may be 4MB). Hard-limit fallback keeps going.
ulimit -s 16384 || ulimit -s "$(ulimit -H -s)" || true
ulimit -s

ftp -o PINS.md "$HOSTD/PINS.md"
TJS_TAG=$(awk '$1=="txiki.js"{print $2; exit}' PINS.md)
ftp -o tjs.tgz     "$HOSTD/vendor/dist/txiki-$TJS_TAG.tar.gz"
ftp -o simde.tgz   "$HOSTD/vendor/dist/simde-v0.8.2.tar.gz"
ftp -o runtime.tgz "$HOSTD/vendor/dist/m4-runtime.tar.gz"
ftp -o cli.cjs     "$HOSTD/vendor/dist/cli.cjs"
ftp -o hosts.frag  "$HOSTD/vendor/dist/hosts.frag"
# Separate extractions (no && chain): xattr-restore warnings can make tar
# exit nonzero without meaning a broken tree; the dir checks below are the
# real gate.
tar xzf tjs.tgz
tar xzf simde.tgz
tar xzf runtime.tgz
for d in txiki.js simde-src node-shim node_modules; do
  [ -d "$W/$d" ] || { echo "FATAL: $d missing after extraction"; echo "=== GUEST-DONE ==="; exit 1; }
done

# Patched-source sanity before burning ~15 build minutes:
grep -c 'cci.origin = NULL' txiki.js/src/httpclient.c   # expect 1
ls txiki.js/src/mod_spawn_sync.c

# deps/ada needs C++20 constexpr std::string — beyond base g++ 10.5 (the
# phase-1 gate-3 wall). Use pkgsrc gcc12 (pkg_add'd by the driver).
GCC12=/usr/pkg/gcc12/bin
[ -x "$GCC12/g++" ] || { echo "FATAL: pkgsrc gcc12 not installed"; echo "=== GUEST-DONE ==="; exit 1; }
LD_LIBRARY_PATH=/usr/pkg/gcc12/lib; export LD_LIBRARY_PATH

# BUILD_WITH_MIMALLOC=OFF: mimalloc 3.2.7's options.c has a
# #if defined(__NetBSD__) branch referencing mi_option_eager_commit_delay,
# an enum member renamed to mi_option_deprecated_eager_commit_delay — so
# mimalloc doesn't compile on NetBSD at all (upstream regression; report
# candidate). System malloc instead; divergence vs darwin recorded, same
# class as WASM-off.
echo "=== BUILD-TJS ==="
(cd txiki.js && cmake -S . -B build -DCMAKE_BUILD_TYPE=Release \
   "-DCMAKE_C_COMPILER=$GCC12/gcc" "-DCMAKE_CXX_COMPILER=$GCC12/g++" \
   "-DFETCHCONTENT_SOURCE_DIR_SIMDE=$W/simde-src" \
   -DBUILD_WITH_WASM=OFF \
   -DBUILD_WITH_MIMALLOC=OFF \
 && cmake --build build -j2); echo "tjs-build-exit=$?"
[ -x ./txiki.js/build/tjs ] || { echo "FATAL: no tjs binary after build"; echo "=== GUEST-DONE ==="; exit 1; }
./txiki.js/build/tjs eval 'console.log("spawn_sync:", typeof __tjs_spawn_sync, "fs_sync:", typeof __tjs_fs_sync)' || true

# Live-API reachability: pin IPv4 (slirp DNS is IPv6-first, IPv6 unroutable),
# then probe with the freshly built tjs itself (NetBSD base ftp(1) has no TLS
# — this also exercises lws TLS + the embedded CA bundle + the hosts pin):
cat hosts.frag >> /etc/hosts
./txiki.js/build/tjs eval \
  'fetch("https://api.anthropic.com/",{method:"HEAD"}).then(r=>console.log("api-status",r.status)).catch(e=>console.log("api-error",String(e)))' \
  || true

# Subscription credential -> file store (never cat this file; 0600)
mkdir -p /root/.claude
ftp -o /root/.claude/.credentials.json "$HOSTD/vendor/dist/creds/.credentials.json"
chmod 600 /root/.claude/.credentials.json
# minimal profile: onboarding done + cwd pre-trusted (shape mirrors the PTY
# harness's seedClaudeProfile in test/e2e-pty.cjs)
printf '{"hasCompletedOnboarding":true,"theme":"dark","projects":{"%s":{"hasTrustDialogAccepted":true,"hasCompletedProjectOnboarding":true}}}\n' \
  "$W" > /root/.claude.json

RUNNER=/usr/bin/timeout; [ -x "$RUNNER" ] || RUNNER=""
i=1
while [ "$i" -le 3 ]; do
  echo "=== M4-ORACLE run $i ==="
  NODE_PATH="$W/node_modules" TERM=vt100 \
    $RUNNER ${RUNNER:+300} ./txiki.js/build/tjs run "$W/node-shim/loader.cjs" \
    "$W/cli.cjs" -p 'say PONG' < /dev/null
  echo "m4-run-$i-exit=$?"
  i=$((i + 1))
done
echo "=== GUEST-DONE ==="
