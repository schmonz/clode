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
# Canonicalize CLODE_NODE to the REAL interpreter binary. A version-manager SHIM
# (asdf/nvm) re-derives PATH internally when exec'd, which defeats a test's minimal
# PATH and can leak a real `claude` back in (see test_resolve #5). process.execPath
# is the concrete binary the shim ultimately runs, so resolving through it once
# yields a stable, shim-free node — and removes the need to hand-set CLODE_NODE.
if _real=$("$CLODE_NODE" -e 'process.stdout.write(process.execPath)' 2>/dev/null) \
   && [ -n "$_real" ]; then CLODE_NODE="$_real"; export CLODE_NODE; fi
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
# node-pty carries a NATIVE binary, so the harness is per-platform: scope it under a
# tag dir (test/.harness/<os>-<osver>-<arch>-node<major>) so a shared/NFS test/ tree can
# host harnesses for different OS/arch/node without one host's compiled binary clobbering
# another's. NODE_PATH points node's module resolution at the tagged dir (there is no
# stray test/node_modules to shadow it). The tag is computed by the same helper the SEA
# build uses, from THIS node — so the harness ABI always matches the node running tests.
TAG=$("$NODE" -e 'process.stdout.write(require("./scripts/platform-tag.cjs").platformTag())') \
  || { echo "run-all: could not compute platform tag" >&2; exit 2; }
HARNESS="$PWD/test/.harness/$TAG"
export NODE_PATH="$HARNESS/node_modules${NODE_PATH:+:$NODE_PATH}"
if ! "$NODE" test/harness-preflight.cjs 2>/dev/null; then
  echo "run-all: installing PTY test harness deps into test/.harness/$TAG ..." >&2
  echo "run-all: node-pty has no Linux prebuilt binary, so it compiles from source" >&2
  echo "run-all: (needs python3 + a C/C++ toolchain; the first build also downloads" >&2
  echo "run-all:  Node headers, so it can take a few minutes — output is shown below)" >&2
  # Do NOT swallow npm's output or its exit status: a slow source build must be
  # visible (else it looks like a hang), and a failed one must fail loud with the
  # real node-gyp error rather than surfacing later as an opaque "harness missing".
  # Run npm IN the harness dir (cwd), not --prefix: --prefix mis-derives the root
  # package name from the dir basename when cwd is a different package (the repo root).
  mkdir -p "$HARNESS"
  cp test/package.json "$HARNESS/package.json"
  [ -f test/package-lock.json ] && cp test/package-lock.json "$HARNESS/package-lock.json"
  if ! ( cd "$HARNESS" && npm install ); then
    echo "run-all: harness dep install failed (see npm output above)" >&2
    exit 2
  fi
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
