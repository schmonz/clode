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
tar xzf tjs.tgz && tar xzf simde.tgz && tar xzf runtime.tgz

# Patched-source sanity before burning ~15 build minutes:
grep -c 'cci.origin = NULL' txiki.js/src/httpclient.c   # expect 1
ls txiki.js/src/mod_spawn_sync.c

echo "=== BUILD-TJS ==="
(cd txiki.js && cmake -S . -B build -DCMAKE_BUILD_TYPE=Release \
   "-DFETCHCONTENT_SOURCE_DIR_SIMDE=$W/simde-src" \
   -DBUILD_WITH_WASM=OFF \
 && cmake --build build -j2); echo "tjs-build-exit=$?"
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
