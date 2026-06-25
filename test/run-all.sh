#!/bin/sh
# run-all.sh — run the test suite, report pass/fail, exit nonzero on any fail.
# OFFLINE BY DEFAULT: no network or login required. The online tests (live model
# round-trips and a logged-in ~/.claude — print/assets/tools) are opt-in.
# Normal entry point: `npm test` (offline) / `npm run test:online` (adds online).
# Direct usage: sh test/run-all.sh            (offline, the default)
#               sh test/run-all.sh --online   (also run the network/model tests)
cd "$(dirname "$0")/.."
# Discover host tools on PATH; CLODE_* override per machine. No hardcoded prefixes
# (the Python/Node helpers also resolve via their `#!/usr/bin/env` shebangs).
: "${CLODE_NODE:=$(command -v node)}"
: "${CLODE_PYTHON:=$(command -v python3)}"
: "${CLODE_BATS:=$(command -v bats)}"
export CLODE_NODE CLODE_PYTHON
NODE="$CLODE_NODE"; PYTHON="$CLODE_PYTHON"; BATS="$CLODE_BATS"
[ -n "$NODE" ]   || { echo "run-all: node not found on PATH (set CLODE_NODE)" >&2; exit 2; }
[ -n "$PYTHON" ] || { echo "run-all: python3 not found on PATH (set CLODE_PYTHON)" >&2; exit 2; }
[ -n "$BATS" ]   || { echo "run-all: bats not found on PATH (set CLODE_BATS)" >&2; exit 2; }
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

run "pytest extract"  "$PYTHON" -m pytest -q test/test_extract.py
run "pytest inspect"  "$PYTHON" -m pytest -q test/test_inspect.py
run "node tests"      "$NODE" --test test/*.test.cjs
run "bats suite"      "$BATS" test/

echo
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; else echo "$fails FAILED"; exit 1; fi
