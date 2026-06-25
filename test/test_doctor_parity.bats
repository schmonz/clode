#!/usr/bin/env bats

load test_helper

# Render /doctor under native `claude` and under clode on THIS machine and assert
# clode deviates only in the intended ways (see
# docs/superpowers/specs/2026-06-25-doctor-parity-test-design.md). The two live
# renders are compared against EACH OTHER, so host-specific content cancels out.
#
# Skips cleanly (not fails) when:
#   - pyte (real terminal emulator, test-only dep) is missing
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
    "$CLODE_PYTHON" test/tui_screen.py 16 \
      --then-hex 2f646f63746f72@4 \
      --then-hex 0d@6 \
      --rows 120 --cols 100 \
      -- "$@"
  ) > "$out" 2>/dev/null || true
}

setup_file() {
  cd "$BATS_TEST_DIRNAME/.."
  local skipfile="$BATS_FILE_TMPDIR/skip"
  if ! "$CLODE_PYTHON" -c 'import pyte' 2>/dev/null; then
    echo "pyte not installed" > "$skipfile"; return
  fi
  local native; native="$(command -v claude || true)"
  if [ -z "$native" ]; then
    echo "native claude not on PATH" > "$skipfile"; return
  fi
  local nver cver
  nver="$(DISABLE_AUTOUPDATER=1 "$native" --version 2>/dev/null | head -1)"
  if [ -z "$nver" ]; then
    echo "native claude did not run here" > "$skipfile"; return
  fi
  cver="$(./bin/clode --version 2>/dev/null | head -1)"
  if [ "$nver" != "$cver" ]; then
    echo "version mismatch: native='$nver' clode='$cver'" > "$skipfile"; return
  fi
  # Parity needs clode's REAL render deps — fake string-width/wrap-ansi would change
  # text wrapping and forge spurious deviations. Expose the deps a normal clode install
  # resolves, but stay offline: a user-managed CLODE_DEPS (node_modules symlink, no
  # .deps-sig) makes ensure_deps trust them and never npm-install. Skip if absent.
  local real_nm="${XDG_DATA_HOME:-$HOME/.local/share}/clode/node_modules"
  if [ ! -d "$real_nm/string-width" ] || [ ! -d "$real_nm/wrap-ansi" ]; then
    echo "clode render deps not installed at $real_nm (run clode once online first)" > "$skipfile"; return
  fi
  local deps_dir="$BATS_FILE_TMPDIR/deps"
  mkdir -p "$deps_dir"
  ln -sf "$real_nm" "$deps_dir/node_modules"
  export CLODE_DEPS="$deps_dir"
  # Warm clode's per-binary cache so a (re)extract never eats the timed capture.
  ./bin/clode --version >/dev/null 2>&1 || true
  _doctor_capture "$BATS_FILE_TMPDIR/native.txt" "$native"
  _doctor_capture "$BATS_FILE_TMPDIR/clode.txt"  ./bin/clode
}

setup() {
  [ -f "$BATS_FILE_TMPDIR/skip" ] && skip "$(cat "$BATS_FILE_TMPDIR/skip")"
  NATIVE="$BATS_FILE_TMPDIR/native.txt"
  CLODE="$BATS_FILE_TMPDIR/clode.txt"
}

@test "both /doctor renders were captured" {
  grep -aq 'Enter to close' "$NATIVE"
  grep -aq 'Enter to close' "$CLODE"
}

@test "clode /doctor matches native except for allowlisted deviations" {
  run "$CLODE_PYTHON" test/doctor_parity.py "$NATIVE" "$CLODE"
  echo "$output"
  [ "$status" -eq 0 ]
}
