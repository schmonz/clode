#!/bin/sh
# Runs INSIDE a NetBSD guest (evbarm-aarch64, amd64, or mac68k). Fetches
# pinned sources and the probe/memory tools from the host over qemu
# user-net (host=10.0.2.2), builds, runs, prints delimited results to the
# serial console for the driver to capture. Build failures are findings —
# keep going.
# Env: SKIP_TJS=1 to skip the txiki leg (default on mac68k).
#      PROBE_NET=0 (set by the driver when guest->internet is dead) makes
#      probe.js skip its fetch-tls exercise instead of hanging on a TLS
#      connection slirp will never complete.
set -ux
HOSTD=http://10.0.2.2:8080
[ "${PROBE_NET:-1}" = 0 ] && { NET=0; export NET; }
W=/root/qjswork; mkdir -p "$W"; cd "$W"
ftp -o PINS.md         "$HOSTD/PINS.md"
ftp -o probe.js        "$HOSTD/probe.js"
ftp -o measure-mem.sh  "$HOSTD/measure-mem.sh"
ftp -o cli.cjs         "$HOSTD/vendor/dist/cli.cjs"
QJS_TAG=$(awk '$1=="quickjs-ng"{print $2; exit}' PINS.md)
ftp -o qjs.tgz "$HOSTD/vendor/dist/quickjs-ng-$QJS_TAG.tar.gz"
tar xzf qjs.tgz && mv quickjs-* qjs-src
echo "=== BUILD-QJS ==="
(cd qjs-src && cmake -S . -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build -j2); echo "qjs-build-exit=$?"
echo "=== PROBE-QJS ==="
./qjs-src/build/qjs probe.js; echo "probe-qjs-exit=$?"
if [ "${SKIP_TJS:-0}" != 1 ]; then
  TJS_TAG=$(awk '$1=="txiki.js"{print $2; exit}' PINS.md)
  ftp -o tjs.tgz "$HOSTD/vendor/dist/txiki-$TJS_TAG.tar.gz"
  tar xzf tjs.tgz
  # wamr's simde.cmake FetchContent git-clones at configure time; the guest
  # has no git (and unreliable outbound net) -> pre-seed the source dir.
  ftp -o simde.tgz "$HOSTD/vendor/dist/simde-v0.8.2.tar.gz"
  tar xzf simde.tgz
  echo "=== BUILD-TJS ==="
  # BUILD_WITH_WASM=OFF: txiki maps every non-Darwin/Windows/Android system
  # to wamr's "linux" platform, and wamr has no netbsd port — its
  # posix_memmap.c calls Linux's 4-arg mremap (NetBSD's takes 5) and the
  # build dies. Nothing probe.js exercises needs WASM. Finding, not a fix.
  (cd txiki.js && cmake -S . -B build -DCMAKE_BUILD_TYPE=Release \
     "-DFETCHCONTENT_SOURCE_DIR_SIMDE=$W/simde-src" \
     -DBUILD_WITH_WASM=OFF \
   && cmake --build build -j2); echo "tjs-build-exit=$?"
  echo "=== PROBE-TJS ==="
  ./txiki.js/build/tjs run probe.js; echo "probe-tjs-exit=$?"
fi
echo "=== MEMORY ==="
# sh -x: measure-mem.sh is silent on the console until its final cat (its
# output goes to the results file first), which starves the driver's
# silence-based timeout and hides WHERE a hung measurement hangs. The
# xtrace goes to stderr = the console = keepalive + a pointer to the
# offending command.
# ulimit -t 300 (CPU seconds, inherited by every measurement child): the
# standalone bundle-exe SPINS on this guest (>=14 min at full CPU where
# darwin exits in 0.4s). SIGXCPU kills just the spinning child; time(1)
# still reports its rusage, so the row becomes "peak RSS while spinning" —
# valid ceiling evidence. 300s CPU is >10x any legitimate measurement here.
(ulimit -t 300; QJS="$W/qjs-src/build/qjs" QJSC="$W/qjs-src/build/qjsc" CLI="$W/cli.cjs" sh -x measure-mem.sh "guest-$(uname -m)")
echo "=== HOSTINFO ==="
uname -a; cc --version 2>&1 | head -1; cmake --version 2>&1 | head -1
echo "=== GUEST-DONE ==="
