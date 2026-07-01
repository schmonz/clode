#!/bin/sh
# run-all.sh — run the test suite, report pass/fail, exit nonzero on any fail.
# OFFLINE BY DEFAULT: no network or login required. The online tests (live model
# round-trips and a logged-in ~/.claude — print/assets/tools) are opt-in.
# Normal entry point: `npm test` (offline) / `npm run test:online` (adds online).
# Direct usage: sh test/run-all.sh            (offline, the default)
#               sh test/run-all.sh --online   (also run the network/model tests)
cd "$(dirname "$0")/.."
# Discover host tools on PATH; CLODE_* override per machine. No hardcoded prefixes
# (the Node helpers also resolve via their `#!/usr/bin/env` shebangs).
# Both the shipped runtime (bin/ + libexec/) AND the test suite are now
# Python-free: node + sh + bats only (plus npm for the node-pty devDep install).
: "${CLODE_NODE:=$(command -v node)}"
: "${CLODE_BATS:=$(command -v bats)}"
export CLODE_NODE
NODE="$CLODE_NODE"; BATS="$CLODE_BATS"
[ -n "$NODE" ]   || { echo "run-all: node not found on PATH (set CLODE_NODE)" >&2; exit 2; }
[ -n "$BATS" ]   || { echo "run-all: bats not found on PATH (set CLODE_BATS)" >&2; exit 2; }
# Test harness deps (node-pty, @xterm/headless) live in a SEPARATE manifest
# (test/package.json -> test/node_modules), by convention — NOT in the root
# package.json. The fail-loud ext-dep tests (semver/websocket/yaml/text-utils) are
# now ISOLATED from the repo's own node_modules: they run their shim children from a
# temp copy of bun-shim.cjs OUTSIDE the repo tree (test/isolated-shim.cjs), so a
# stray root `npm install` can no longer make the runtime deps resolvable and defeat
# the "dep is ABSENT" assertions. The PTY tests are NOT optional, so install the
# harness here and fail loudly rather than skip.
if ! "$NODE" test/harness-preflight.cjs 2>/dev/null; then
  echo "run-all: installing test harness deps (test/node_modules)..." >&2
  npm install --prefix test >/dev/null 2>&1 || true
fi
"$NODE" test/harness-preflight.cjs || { echo "run-all: PTY test harness unavailable (see above)" >&2; exit 2; }
# The runner is the single source of truth for the CLODE_OFFLINE gate the bats
# tests read: callers pass a flag, not an env var, and an ambient CLODE_OFFLINE
# never leaks in. Offline is the default; --online opts in.
case "${1:-}" in
  --online)     unset CLODE_OFFLINE ;;
  ''|--offline) export CLODE_OFFLINE=1 ;;
  *) echo "usage: $0 [--online|--offline]" >&2; exit 2 ;;
esac
fails=0

run() { # name, command...
  name=$1; shift
  printf '%-26s' "$name"
  if out=$("$@" 2>&1); then echo "OK"; else echo "FAIL"; echo "$out" | sed 's/^/    /'; fails=$((fails+1)); fi
}

run "node tests"      "$NODE" --test test/*.test.cjs
run "bats suite"      "$BATS" test/

echo
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; else echo "$fails FAILED"; exit 1; fi
