#!/bin/sh
# refresh-doctor-golden.sh — regenerate the pinned /doctor comparator goldens
# (test/fixtures/doctor/{native,clode}-sample.txt) that test/doctor-parity.test.cjs
# asserts against. Run manually (a dev tool, NOT part of `npm test`).
#
# clode itself never runs Claude Code — it only BUILDS quaude (`clode build`) — so
# the "clode" side of this comparison has to be a BUILT quaude, not bare `./scripts/stage0.mjs`
# (which is clode's own dispatch surface: it prints usage + exits 2 with no /doctor
# to capture). This script builds one the same way test/e2e-doctor-parity.test.cjs
# does (same-provider-bundle discipline, hermetic CLODE_CACHE) and drives that.
#
# SIDE EFFECTS: spawns the REAL native `claude` and a built quaude, which render the
# /doctor screen. On macOS this probes the login Keychain and may pop system dialogs,
# and may touch the network — the same reason the live e2e-doctor-parity test is
# opt-in (CLODE_LIVE_RENDER=1). Run this only when you intend to.
#
# REFRESH POLICY: regenerate when bumping the pinned bundle version, or when a dev with
# both native `claude` and clode installed sees the live parity test (e2e-doctor-parity,
# run with CLODE_LIVE_RENDER=1) flag a new INTENDED deviation. Requires a native `claude`
# on PATH, a built tjs template (CLODE_TJS, or run scripts/build-tjs.cjs first), and the
# node-pty harness installed.
set -eu
cd "$(dirname "$0")/.."
: "${CLODE_NODE:=$(command -v node)}"
: "${CLODE_TJS:=$("$CLODE_NODE" -p "require('./scripts/platform-tag.cjs').tjsBin(process.cwd())")}"
NATIVE="$(command -v claude || { echo 'no native claude on PATH' >&2; exit 2; })"
[ -x "$CLODE_TJS" ] || { echo "no tjs template at '$CLODE_TJS' (set CLODE_TJS, or run scripts/build-tjs.cjs)" >&2; exit 2; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
QUAUDE="$WORK/quaude"
# Build FROM the same provider bundle native runs (CLODE_CLAUDE_BIN), into a hermetic
# CLODE_CACHE — never the real one — so this doesn't disturb the dev's own clode state.
CLODE_CLAUDE_BIN="$NATIVE" CLODE_CACHE="$WORK/cache" CLODE_TJS="$CLODE_TJS" \
  "$CLODE_NODE" scripts/stage0.mjs build --out "$QUAUDE"

# Each side's screen once "/doctor" is in the prompt and Enter's report (its footer "Enter to
# close") has painted and settled: a scripted session (test/e2e-pty.cjs captureSession), not a
# screen read at a fixed 16 s with the keys at 4 s and 6 s, a guess a loaded box outruns
# (test/fixed-window-captures.test.cjs). Your own environment, as before: a login is what opens
# the report. The text is the same rows-joined screen the fixed capture printed.
CAP() { # $1=out, $2...=cmd
  out=$1; shift
  DISABLE_AUTOUPDATER=1 "$CLODE_NODE" -e '
    const { captureSession, frameText } = require("./test/e2e-pty.cjs");
    const [out, ...cmd] = process.argv.slice(1);
    captureSession({ env: process.env }, { rows: 120, cols: 100, cmd, script: [
      { label: "type", send: "2f646f63746f72", until: "/doctor" },
      { label: "enter", send: "0d", until: "Enter to close" },
    ] }).then((s) => {
      const last = s.frames[s.frames.length - 1];
      if (!last || last.label !== "enter" || !last.settled) { console.error("no settled /doctor report from " + cmd[0]); process.exit(1); }
      require("node:fs").writeFileSync(out, frameText(last.frame));
    }).catch((e) => { console.error(e.message); process.exit(1); });
  ' "$out" "$@"
}
CAP test/fixtures/doctor/native-sample.txt "$NATIVE"
CAP test/fixtures/doctor/clode-sample.txt  "$QUAUDE"
echo "refreshed test/fixtures/doctor/{native,clode}-sample.txt" >&2
