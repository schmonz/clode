#!/bin/sh
# run-all.sh — run the whole test suite, report pass/fail, exit nonzero on any fail.
# Normal entry point: `make test` (or `CLODE_OFFLINE=1 make test`).
# Some tests need a logged-in ~/.claude + network (print/assets/tools).
# Direct usage: sh test/run-all.sh            (all)
#               sh test/run-all.sh --offline  (skip network/model tests)
cd "$(dirname "$0")/.."
export CLODE_NODE="${CLODE_NODE:-/opt/pkg/bin/node}"
NODE="$CLODE_NODE"
offline=0; [ "$1" = "--offline" ] && offline=1
[ "$offline" -eq 1 ] && export CLODE_OFFLINE=1
fails=0

run() { # name, command...
  name=$1; shift
  printf '%-26s' "$name"
  if out=$("$@" 2>&1); then echo "OK"; else echo "FAIL"; echo "$out" | sed 's/^/    /'; fails=$((fails+1)); fi
}

run "pytest extract"  /opt/pkg/bin/python3 -m pytest -q test/test_extract.py
run "pytest inspect"  /opt/pkg/bin/python3 -m pytest -q test/test_inspect.py
run "node tests"      "$NODE" --test test/*.test.cjs
run "bats suite"      /opt/pkg/bin/bats test/

echo
if [ "$fails" -eq 0 ]; then echo "ALL PASS"; else echo "$fails FAILED"; exit 1; fi
