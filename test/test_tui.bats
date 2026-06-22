#!/usr/bin/env bats

load test_helper

setup() {
  cd "$BATS_TEST_DIRNAME/.."
  OUT="$BATS_TMPDIR/test_tui_screen.txt"
  # pyte emulates an xterm. Clear tmux/program hints so Ink TUI doesn't emit
  # tmux passthrough sequences that pyte can't decode.
  timeout 20 \
    env -u TMUX -u TMUX_PANE -u TERM_PROGRAM TERM=xterm-256color \
    /opt/pkg/bin/python3 test/tui_screen.py 11 -- ./bin/clode > "$OUT" 2>/dev/null || true
}

@test "TUI renders the welcome box (Claude Code)" {
  grep -aq 'Claude Code' "$OUT"
}

@test "TUI reaches an interactive prompt" {
  grep -aqE 'shortcuts|for agents|/effort|trust this folder|Accessing workspace' "$OUT"
}

@test "TUI has no npm-deprecation banner" {
  ! grep -aqi 'deprecated' "$OUT"
}
