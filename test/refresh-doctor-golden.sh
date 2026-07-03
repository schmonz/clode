#!/bin/sh
# refresh-doctor-golden.sh — regenerate the pinned /doctor comparator goldens
# (test/fixtures/doctor/{native,clode}-sample.txt) that test/doctor-parity.test.cjs
# asserts against. Run manually (a dev tool, NOT part of `npm test`).
#
# SIDE EFFECTS: spawns the REAL native `claude` and clode, which render the /doctor
# screen. On macOS this probes the login Keychain and may pop system dialogs, and may
# touch the network — the same reason the live e2e-doctor-parity test is opt-in
# (CLODE_LIVE_RENDER=1). Run this only when you intend to.
#
# REFRESH POLICY: regenerate when bumping the pinned bundle version, or when a dev with
# both native `claude` and clode installed sees the live parity test (e2e-doctor-parity,
# run with CLODE_LIVE_RENDER=1) flag a new INTENDED deviation. Requires a native `claude`
# on PATH and the node-pty harness installed.
set -eu
cd "$(dirname "$0")/.."
: "${CLODE_NODE:=$(command -v node)}"
NATIVE="$(command -v claude || { echo 'no native claude on PATH' >&2; exit 2; })"
CAP() { # $1=out, $2...=cmd
  out=$1; shift
  DISABLE_AUTOUPDATER=1 TERM=xterm-256color "$CLODE_NODE" test/tui-screen.cjs 16 \
    --then-hex 2f646f63746f72@4 --then-hex 0d@6 --rows 120 --cols 100 -- "$@" > "$out"
}
CAP test/fixtures/doctor/native-sample.txt "$NATIVE"
CAP test/fixtures/doctor/clode-sample.txt  ./bin/clode
echo "refreshed test/fixtures/doctor/{native,clode}-sample.txt" >&2
