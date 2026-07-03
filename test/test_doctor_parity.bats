#!/usr/bin/env bats

load test_helper

# Render /doctor under native `claude` and under clode on THIS machine and assert
# clode deviates only in the intended ways (see
# docs/superpowers/specs/2026-06-25-doctor-parity-test-design.md). The two live
# renders are compared against EACH OTHER, so host-specific content cancels out.
#
# The PTY/TUI harness (node-pty + @xterm/headless) is non-optional (run-all's
# preflight guarantees it). This test still skips cleanly (not fails) for genuine
# ENVIRONMENTAL reasons — never for a missing harness:
#   - native `claude` is missing or won't run here (clode's whole reason to exist)
#   - native and clode resolve to different versions (would pollute the comparison)
#
# DISABLE_AUTOUPDATER=1 is forced for BOTH captures: it keeps the real native
# binary from auto-updating mid-test (possibly to a build that can't run here) and
# keeps the env identical so the Updates section cancels. See the spec's "Capture
# environment" section.

_doctor_capture() {  # $1 = out file; rest = command (+args) to run
  local out=$1; shift
  ( unset TMUX TMUX_PANE TERM_PROGRAM NODE_PATH
    export TERM=xterm-256color DISABLE_AUTOUPDATER=1
    "$CLODE_NODE" test/tui-screen.cjs 16 \
      --then-hex 2f646f63746f72@4 \
      --then-hex 0d@6 \
      --rows 120 --cols 100 \
      -- "$@"
  ) > "$out" 2>/dev/null || true
}

setup_file() {
  cd "$BATS_TEST_DIRNAME/.."
  local skipfile="$BATS_FILE_TMPDIR/skip"
  local native; native="$(command -v claude || true)"
  if [ -z "$native" ]; then
    echo "native claude not on PATH" > "$skipfile"; return
  fi
  local nver cver
  nver="$(DISABLE_AUTOUPDATER=1 "$native" --version 2>/dev/null | head -1)"
  if [ -z "$nver" ]; then
    echo "native claude did not run here" > "$skipfile"; return
  fi
  cver="$("$CLODE_BIN" --version 2>/dev/null | head -1)"
  if [ "$nver" != "$cver" ]; then
    echo "version mismatch: native='$nver' clode='$cver'" > "$skipfile"; return
  fi
  # NOTE: this test is explicitly quarantined (see the @tests below) pending the
  # bats->node conversion, which will restore parity coverage against a hermetic
  # golden fixture instead of clode's REAL render deps. Formerly this block exposed
  # the deps a normal clode install resolves (a user-managed CLODE_DEPS symlink to
  # the real ~/.local/share/clode/node_modules) so fake string-width/wrap-ansi
  # wouldn't forge spurious wrapping deviations; that real-store read is removed —
  # captures below now resolve via the sandbox's seeded fakes instead.
  # Warm clode's per-binary cache so a (re)extract never eats the timed capture.
  "$CLODE_BIN" --version >/dev/null 2>&1 || true
  _doctor_capture "$BATS_FILE_TMPDIR/native.txt" "$native"
  _doctor_capture "$BATS_FILE_TMPDIR/clode.txt"  "$CLODE_BIN"
}

setup() {
  [ -f "$BATS_FILE_TMPDIR/skip" ] && skip "$(cat "$BATS_FILE_TMPDIR/skip")"
  NATIVE="$BATS_FILE_TMPDIR/native.txt"
  CLODE="$BATS_FILE_TMPDIR/clode.txt"
}

@test "both /doctor renders were captured" {
  clode_quarantine
  grep -aq 'Enter to close' "$NATIVE"
  grep -aq 'Enter to close' "$CLODE"
}

@test "clode /doctor matches native except for allowlisted deviations" {
  clode_quarantine
  run "$CLODE_NODE" test/doctor-parity.cjs "$NATIVE" "$CLODE"
  echo "$output"
  [ "$status" -eq 0 ]
}
