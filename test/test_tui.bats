#!/usr/bin/env bats

load test_helper

# These tests CONTROL whether the bundle can resolve `ws`, instead of depending on
# what happens to be installed on the host — so both the render path AND the
# fail-loud path are exercised every run.
#
# The bundle resolves `ws` only via NODE_PATH, and bin/clode's set_node_path derives
# the global dir from $CLODE_NODE's prefix. So a symlinked node in a prefix we
# populate decides ws visibility. A FAKE no-connect `ws` is enough: we're testing
# clode's presence/absence behavior, not ws itself, and the bundle only needs the
# startup require() to succeed (it doesn't open a connection until Remote Control is
# actually used). Two worlds:
#   withws/ — a fake `ws` on the resolution path -> the TUI must render
#   nows/   — nothing on the resolution path     -> clode must fail LOUD, not hang

_tui_make_world() {  # $1 = root; builds withws/ (fake ws) and nows/ (empty) prefixes
  local r=$1 realnode; realnode="${CLODE_NODE:-$(command -v node)}"
  mkdir -p "$r/withws/bin" "$r/withws/lib/node_modules/ws" "$r/nows/bin" "$r/nows/lib/node_modules"
  ln -s "$realnode" "$r/withws/bin/node"
  ln -s "$realnode" "$r/nows/bin/node"
  printf '{"name":"ws","version":"0.0.0-clode-test","main":"index.js"}\n' \
    > "$r/withws/lib/node_modules/ws/package.json"
  cat > "$r/withws/lib/node_modules/ws/index.js" <<'JS'
// Fake no-connect ws: enough for the bundle's startup require() to succeed and the
// TUI to render. Never connects (Remote Control isn't exercised here). Mirrors the
// shape clode shipped before the real adapter.
const { EventEmitter } = require('events');
class WebSocket extends EventEmitter {
  constructor(u){ super(); this.url = u; this.readyState = 0; }
  send(){} close(){} ping(){} terminate(){} addEventListener(){} removeEventListener(){}
}
WebSocket.CONNECTING=0; WebSocket.OPEN=1; WebSocket.CLOSING=2; WebSocket.CLOSED=3;
WebSocket.WebSocket=WebSocket; WebSocket.default=WebSocket;
class WebSocketServer extends EventEmitter {}
WebSocket.WebSocketServer=WebSocketServer; WebSocket.Server=WebSocketServer;
module.exports=WebSocket;
JS
}

_tui_capture() {  # $1 = withws|nows, $2 = world root, $3 = out file
  # Drive clode under a pty (tui_screen.py self-terminates after its SECONDS arg, so
  # no GNU `timeout` needed). Clear tmux hints so Ink doesn't emit passthrough pyte
  # can't decode. NODE_PATH cleared so ONLY the chosen prefix decides ws visibility.
  ( unset TMUX TMUX_PANE TERM_PROGRAM NODE_PATH
    export TERM=xterm-256color
    export CLODE_NODE="$2/$1/bin/node"
    "$CLODE_PYTHON" test/tui_screen.py 11 -- ./bin/clode
  ) > "$3" 2>/dev/null || true
}

setup_file() {
  cd "$BATS_TEST_DIRNAME/.."
  # pyte (a real terminal emulator) is a test-only dependency; skip cleanly where
  # it isn't installed (cf. the mandoc/offline skips).
  if ! "$CLODE_PYTHON" -c 'import pyte' 2>/dev/null; then
    touch "$BATS_FILE_TMPDIR/skip"; return
  fi
  local world="$BATS_FILE_TMPDIR/world"
  _tui_make_world "$world"
  # Warm the per-binary cache first so a (re)extract never eats into the timed pty
  # captures below.
  ( export CLODE_NODE="$world/withws/bin/node"; ./bin/clode --version >/dev/null 2>&1 ) || true
  _tui_capture withws "$world" "$BATS_FILE_TMPDIR/withws.txt"
  _tui_capture nows   "$world" "$BATS_FILE_TMPDIR/nows.txt"
}

setup() {
  [ -f "$BATS_FILE_TMPDIR/skip" ] && skip "pyte not installed"
  WS="$BATS_FILE_TMPDIR/withws.txt"
  NOWS="$BATS_FILE_TMPDIR/nows.txt"
}

@test "TUI renders the welcome box (Claude Code) when ws is present" {
  grep -aq 'Claude Code' "$WS"
}

@test "TUI reaches an interactive prompt when ws is present" {
  grep -aqE 'shortcuts|for agents|/effort|trust this folder|Accessing workspace' "$WS"
}

@test "TUI has no npm-deprecation banner when ws is present" {
  ! grep -aqi 'deprecated' "$WS"
}

@test "TUI fails LOUD (not a blank hang) when the ws ext-dep is missing" {
  # Regression guard: missing ws used to be swallowed by a render-gating promise,
  # leaving a blank screen. It must surface a clear, actionable message instead.
  grep -aq 'WebSocket features' "$NOWS"
  grep -aq 'npm install -g ws' "$NOWS"
}
