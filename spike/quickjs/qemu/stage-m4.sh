#!/bin/sh
# stage-m4.sh — refresh the served payload for the phase-2 M4 guest run.
# Run from anywhere; cd's to the repo root. Everything lands in
# spike/quickjs/vendor/dist/ (uncommitted scratch) except the credential,
# which lives on LOCAL disk under /private/tmp/qemu-anita/creds (0700/0600)
# and is only symlinked into dist/. Serve dist/ with a LOOPBACK-ONLY
# http.server (slirp's 10.0.2.2 reaches host 127.0.0.1); delete the
# credential right after the run.
set -eu
cd "$(dirname "$0")/../../.."   # repo root
DIST=spike/quickjs/vendor/dist
TJS_TAG=$(awk '$1=="txiki.js"{print $2; exit}' spike/quickjs/PINS.md)

# 1. txiki tarball FROM THE PATCHED CHECKOUT (build-tjs.mjs keeps patches applied)
[ -f spike/quickjs/vendor/txiki.js/src/mod_spawn_sync.c ] \
  || { echo "FATAL: mod_spawn_sync.c missing — sync-spawn patch not applied"; exit 1; }
grep -q 'cci.origin = NULL' spike/quickjs/vendor/txiki.js/src/httpclient.c \
  || { echo "FATAL: no-origin patch not applied in vendor checkout"; exit 1; }
# --no-xattrs: bsdtar otherwise records com.apple.provenance xattrs that make
# NetBSD tar exit nonzero ("Error exit delayed") when it can't restore them.
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$DIST/txiki-$TJS_TAG.tar.gz" \
  -C spike/quickjs/vendor --exclude 'txiki.js/build' --exclude 'txiki.js/.git' \
  --exclude 'txiki.js/.cache' --exclude '._*' txiki.js

# 2. cli.cjs: same 2.1.202 extraction the M3b oracle used
node libexec/extract-claude-js.cjs "$HOME/.local/share/claude/versions/2.1.202" "$DIST/cli.cjs"

# 3. runtime tree: bun-shim + node-shim + ext-dep node_modules (staged copy so
#    a single tar root keeps guest-extraction layout flat under $W)
STAGE=$(mktemp -d)
cp libexec/bun-shim.cjs "$STAGE/"
cp -R libexec/node-shim "$STAGE/"
cp -R node_modules "$STAGE/"
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$DIST/m4-runtime.tar.gz" --exclude '._*' \
  -C "$STAGE" bun-shim.cjs node-shim node_modules
rm -rf "$STAGE"

# 4. IPv4 pins for the API hostnames (slirp DNS is IPv6-first and IPv6 is dead)
: > "$DIST/hosts.frag"
for h in api.anthropic.com console.anthropic.com statsig.anthropic.com; do
  ip=$(dig +short A "$h" | awk '/^[0-9]/{print; exit}')
  [ -n "$ip" ] && printf '%s %s\n' "$ip" "$h" >> "$DIST/hosts.frag"
done
grep -q api.anthropic.com "$DIST/hosts.frag" \
  || { echo "FATAL: could not resolve api.anthropic.com"; exit 1; }

# 5. subscription credential -> LOCAL disk, symlinked into dist/
CREDDIR=/private/tmp/qemu-anita/creds
mkdir -p "$CREDDIR" && chmod 700 "$CREDDIR"
security find-generic-password -s "Claude Code-credentials" -w > "$CREDDIR/.credentials.json"
chmod 600 "$CREDDIR/.credentials.json"
ln -sfn "$CREDDIR" "$DIST/creds"

# 6. hygiene checks
[ "$(tar tzf "$DIST/txiki-$TJS_TAG.tar.gz" | grep -c '/\._' || true)" = 0 ] \
  || { echo "FATAL: sidecars in txiki tarball"; exit 1; }
[ "$(tar tzf "$DIST/m4-runtime.tar.gz" | grep -c '/\._' || true)" = 0 ] \
  || { echo "FATAL: sidecars in runtime tarball"; exit 1; }
tar tzf "$DIST/m4-runtime.tar.gz" | grep -q 'node-shim/loader.cjs' \
  || { echo "FATAL: loader missing from runtime tarball"; exit 1; }
python3 -c "import json,sys; d=json.load(open('$CREDDIR/.credentials.json')); sys.exit(0 if d.get('claudeAiOauth',{}).get('accessToken') else 1)" \
  || { echo "FATAL: credential JSON lacks claudeAiOauth.accessToken"; exit 1; }
echo "stage-m4: OK"
