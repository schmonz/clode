#!/usr/bin/env bats

load test_helper

setup() {
  cd "$BATS_TEST_DIRNAME/.."
  OUT="$BATS_TMPDIR/test_tui_screen.txt"
  PYTHON="$CLODE_PYTHON"
  # pyte (a real terminal emulator) is a test-only dependency. Where it isn't
  # installed, skip these cleanly instead of failing (cf. the mandoc/offline skips).
  "$PYTHON" -c 'import pyte' 2>/dev/null || { TUI_SKIP="pyte not installed"; return; }
  # Drive clode under a pty and capture the rendered screen. tui_screen.py
  # self-terminates after its SECONDS arg, so no external `timeout` is needed
  # (BSD/macOS lack GNU `timeout`). Clear tmux/program hints with the shell's own
  # `unset` (BSD `env` has no `-u`) so the Ink TUI doesn't emit tmux passthrough
  # sequences pyte can't decode.
  ( unset TMUX TMUX_PANE TERM_PROGRAM
    export TERM=xterm-256color
    "$PYTHON" test/tui_screen.py 11 -- ./bin/clode
  ) > "$OUT" 2>/dev/null || true
}

@test "TUI renders the welcome box (Claude Code)" {
  [ -n "${TUI_SKIP:-}" ] && skip "$TUI_SKIP"
  grep -aq 'Claude Code' "$OUT"
}

@test "TUI reaches an interactive prompt" {
  [ -n "${TUI_SKIP:-}" ] && skip "$TUI_SKIP"
  grep -aqE 'shortcuts|for agents|/effort|trust this folder|Accessing workspace' "$OUT"
}

@test "TUI has no npm-deprecation banner" {
  [ -n "${TUI_SKIP:-}" ] && skip "$TUI_SKIP"
  ! grep -aqi 'deprecated' "$OUT"
}
