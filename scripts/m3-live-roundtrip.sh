#!/bin/sh
# M3 gated LIVE finale. Runs the real -p 'say PONG' round-trip under tjs against
# api.anthropic.com. Requires CLODE_LIVE_ROUNDTRIP=1, ANTHROPIC_API_KEY in the
# environment, CLODE_PROVIDER_BIN pointing at a fetched darwin-arm64 binary, and
# build/tjs/tjs. NEVER prints, logs, or persists the key. Paste the transcript +
# timing it emits into spike/quickjs/results/phase2-m3-roundtrip.md yourself.
set -e
if [ "$CLODE_LIVE_ROUNDTRIP" != "1" ]; then echo "SKIP: set CLODE_LIVE_ROUNDTRIP=1 to run the live finale"; exit 0; fi
if [ -z "$ANTHROPIC_API_KEY" ]; then echo "SKIP: export ANTHROPIC_API_KEY (never committed)"; exit 0; fi
if [ -z "$CLODE_PROVIDER_BIN" ] || [ ! -f "$CLODE_PROVIDER_BIN" ]; then echo "SKIP: set CLODE_PROVIDER_BIN to a fetched darwin-arm64 binary"; exit 0; fi
REPO=$(cd "$(dirname "$0")/.." && pwd)
TJS="${CLODE_TJS:-$REPO/build/tjs/tjs}"
[ -x "$TJS" ] || { echo "SKIP: no tjs at $TJS (run scripts/build-tjs.mjs)"; exit 0; }
SCRATCH=$(mktemp -d)
node "$REPO/libexec/extract-claude-js.cjs" "$CLODE_PROVIDER_BIN" "$SCRATCH/cli.cjs"
cp "$REPO/libexec/bun-shim.cjs" "$SCRATCH/bun-shim.cjs"
echo "=== M3 LIVE round-trip (api.anthropic.com) ==="
START=$(date +%s)
NODE_PATH="$REPO/node_modules" "$TJS" run "$REPO/libexec/node-shim/loader.cjs" "$SCRATCH/cli.cjs" -p 'say PONG' < /dev/null
CODE=$?
END=$(date +%s)
echo "=== exit=$CODE elapsed=$((END-START))s ==="
# The key was used from the env by the child only; this script never read it into a variable.
