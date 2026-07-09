#!/bin/sh
# stage-p3.sh — refresh the served payload for the PHASE-3 guest scorecard run
# (bundle 2.1.204, all phase-3 tjs patches, MOCK API only — no credentials, no
# Keychain, no live api.anthropic.com). Based on stage-m4.sh; everything lands
# in spike/quickjs/vendor/dist/ (uncommitted scratch). Serve spike/quickjs/
# with a LOOPBACK-ONLY http.server (slirp's 10.0.2.2 reaches host 127.0.0.1).
# The mock-server ports file (p3-ports.env) is written by the mock script
# AFTER its servers bind — staging does not depend on it.
set -eu
cd "$(dirname "$0")/../../.."   # repo root
DIST=spike/quickjs/vendor/dist
TJS_TAG=$(awk '$1=="txiki.js"{print $2; exit}' spike/quickjs/PINS.md)

# 1. txiki tarball FROM THE PATCHED CHECKOUT — sanity-grep one distinctive
#    line per phase-2/3 patch before tarring (a stale checkout burns a ~25 min
#    guest run):
V=spike/quickjs/vendor/txiki.js
[ -f "$V/src/mod_spawn_sync.c" ] \
  || { echo "FATAL: mod_spawn_sync.c missing — sync-spawn patch not applied"; exit 1; }
[ -f "$V/src/mod_fs_sync.c" ] \
  || { echo "FATAL: mod_fs_sync.c missing — sync-fs patch not applied"; exit 1; }
grep -q 'cci.origin = NULL' "$V/src/httpclient.c" \
  || { echo "FATAL: no-origin patch not applied"; exit 1; }
grep -q 'recurses past txiki' "$V/src/vm.c" \
  || { echo "FATAL: default-stack-size patch not applied"; exit 1; }
grep -q 'AI_V4MAPPED' "$V/src/mod_dns.c" \
  || { echo "FATAL: netbsd-portability patch not applied"; exit 1; }
grep -q 'expects initialized streams' "$V/src/mod_process.c" \
  || { echo "FATAL: spawn-fail-uaf patch not applied"; exit 1; }
grep -q 'JS_IsNumber(js_stdin)' "$V/src/mod_process.c" \
  || { echo "FATAL: spawn-inherit-fd patch not applied"; exit 1; }
grep -q 'return the byte COUNT' "$V/src/mod_streams.c" \
  || { echo "FATAL: stream-write-sync-number patch not applied"; exit 1; }
grep -q 'KERN_PROC_PATHNAME' "$V/deps/quickjs/cutils.h" \
  || { echo "FATAL: quickjs-ng js_exepath NetBSD patch not applied in deps/quickjs"; exit 1; }
# --no-xattrs: bsdtar otherwise records com.apple.provenance xattrs that make
# NetBSD tar exit nonzero ("Error exit delayed") when it can't restore them.
# Extra excludes vs stage-m4.sh: build-asan (the phase-3 UAF-hunt ASAN build),
# website + node_modules (npm trees) — ~590MB of host-only scratch the guest
# build never reads; without these the tarball balloons past 500MB.
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$DIST/txiki-$TJS_TAG.tar.gz" \
  -C spike/quickjs/vendor --exclude 'txiki.js/build' --exclude 'txiki.js/.git' \
  --exclude 'txiki.js/.cache' --exclude 'txiki.js/build-asan' \
  --exclude 'txiki.js/website' --exclude 'txiki.js/node_modules' \
  --exclude '._*' txiki.js

# 2. cli.cjs: bundle 2.1.204 (phase-3 pin)
node libexec/extract-claude-js.cjs "$HOME/.local/share/claude/versions/2.1.204" "$DIST/cli.cjs"

# 3. runtime tree: CURRENT bun-shim + node-shim + ext-dep node_modules +
#    probes.cjs (staged copy so a single tar root keeps guest-extraction
#    layout flat under $W)
STAGE=$(mktemp -d)
cp libexec/bun-shim.cjs "$STAGE/"
cp -R libexec/node-shim "$STAGE/"
cp -R node_modules "$STAGE/"
cp spike/quickjs/qemu/probes.cjs "$STAGE/"
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$DIST/p3-runtime.tar.gz" --exclude '._*' \
  -C "$STAGE" bun-shim.cjs node-shim node_modules probes.cjs
rm -rf "$STAGE"

# 4. NO hosts.frag, NO credentials: this run talks only to the host-side mock
#    servers at 10.0.2.2 (mock ports arrive via p3-ports.env, written by the
#    mock-server script). Deliberately no `security`/Keychain access.

# 5. hygiene checks
[ "$(tar tzf "$DIST/txiki-$TJS_TAG.tar.gz" | grep -c '/\._' || true)" = 0 ] \
  || { echo "FATAL: sidecars in txiki tarball"; exit 1; }
[ "$(tar tzf "$DIST/p3-runtime.tar.gz" | grep -c '/\._' || true)" = 0 ] \
  || { echo "FATAL: sidecars in runtime tarball"; exit 1; }
tar tzf "$DIST/p3-runtime.tar.gz" | grep -q 'node-shim/loader.cjs' \
  || { echo "FATAL: loader missing from runtime tarball"; exit 1; }
tar tzf "$DIST/p3-runtime.tar.gz" | grep -q 'probes.cjs' \
  || { echo "FATAL: probes.cjs missing from runtime tarball"; exit 1; }
head -c 64 "$DIST/cli.cjs" >/dev/null || { echo "FATAL: cli.cjs unreadable"; exit 1; }
echo "stage-p3: OK"
