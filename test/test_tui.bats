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

_tui_mod() {  # $1 = node_modules dir, $2 = package name; index.js body on stdin
  mkdir -p "$1/$2"
  printf '{"name":"%s","version":"0.0.0-clode-test","main":"index.js"}\n' "$2" > "$1/$2/package.json"
  cat > "$1/$2/index.js"
}

# The render ext-deps (string-width/strip-ansi/wrap-ansi/semver) are now REQUIRED for
# clode to render at all, so both worlds get functional-enough fakes — `ws` is the
# only difference between them. The fakes only need to be good enough that the welcome
# box renders (ASCII width, basic ANSI strip, identity wrap, numeric version compare).
_tui_render_deps() {  # $1 = node_modules dir
  _tui_mod "$1" string-width <<'JS'
module.exports = (s) => [...String(s).replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '')].length;
JS
  _tui_mod "$1" strip-ansi <<'JS'
module.exports = (s) => String(s).replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '');
JS
  _tui_mod "$1" wrap-ansi <<'JS'
module.exports = (s) => String(s);
JS
  _tui_mod "$1" semver <<'JS'
const P = (v) => String(v).replace(/^[v=]+/, '').split('.').map((n) => parseInt(n, 10) || 0);
exports.compare = (a, b) => { const x = P(a), y = P(b); for (let i = 0; i < 3; i++) if ((x[i]||0) !== (y[i]||0)) return (x[i]||0) < (y[i]||0) ? -1 : 1; return 0; };
exports.satisfies = () => true;
JS
}

_tui_make_world() {  # $1 = root; builds withws/ (all deps) and nows/ (no ws) prefixes
  local r=$1 realnode; realnode="${CLODE_NODE:-$(command -v node)}"
  mkdir -p "$r/withws/bin" "$r/withws/lib/node_modules" "$r/nows/bin" "$r/nows/lib/node_modules"
  ln -s "$realnode" "$r/withws/bin/node"
  ln -s "$realnode" "$r/nows/bin/node"
  _tui_render_deps "$r/withws/lib/node_modules"
  _tui_render_deps "$r/nows/lib/node_modules"
  # ws: present only in withws, so nows exercises the ws fail-loud path specifically.
  _tui_mod "$r/withws/lib/node_modules" ws <<'JS'
// Fake no-connect ws: enough for the bundle's startup require() to succeed and the
// TUI to render. Never connects (Remote Control isn't exercised here).
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
  # Drive clode under a pty (tui-screen.cjs self-terminates after its SECONDS arg, so
  # no GNU `timeout` needed). Clear tmux hints so Ink doesn't emit passthrough the
  # emulator can't decode. NODE_PATH cleared so ONLY the chosen prefix decides ws
  # visibility. The harness loads node-pty's prebuilt addon, so it must run under a
  # node-pty-capable node — the world node is a symlink to the box's real node, so it
  # qualifies; the spawned ./bin/clode child still resolves its deps via CLODE_NODE.
  ( unset TMUX TMUX_PANE TERM_PROGRAM NODE_PATH
    export TERM=xterm-256color
    export CLODE_NODE="$2/$1/bin/node"
    "$CLODE_NODE" test/tui-screen.cjs 11 -- ./bin/clode
  ) > "$3" 2>/dev/null || true
}

setup_file() {
  cd "$BATS_TEST_DIRNAME/.."
  local world="$BATS_FILE_TMPDIR/world"
  _tui_make_world "$world"
  # Warm the per-binary cache first so a (re)extract never eats into the timed pty
  # captures below.
  ( export CLODE_NODE="$world/withws/bin/node"; ./bin/clode --version >/dev/null 2>&1 ) || true
  _tui_capture withws "$world" "$BATS_FILE_TMPDIR/withws.txt"
  _tui_capture nows   "$world" "$BATS_FILE_TMPDIR/nows.txt"
}

setup() {
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
