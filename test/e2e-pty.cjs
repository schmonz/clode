'use strict';
// node:test PTY capture harness — the node-native successor to test_helper.bash's
// _tui_capture / _doctor_capture. Drives a TUI command under a real pseudo-terminal by
// spawning the existing test/tui-screen.cjs driver (node-pty + @xterm/headless) with the
// Spec 2a constructed-clean sandbox env, and returns the rendered screen as a string.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { REPO, NODE, seedRenderDeps } = require('./e2e.cjs');

const TUI_SCREEN = path.join(REPO, 'test', 'tui-screen.cjs');

// Fake no-connect ws (verbatim from test_tui.bats): enough for the bundle's startup
// require() to succeed and the TUI to render; never connects (Remote Control unused).
const FAKE_WS = `const { EventEmitter } = require('events');
class WebSocket extends EventEmitter {
  constructor(u){ super(); this.url = u; this.readyState = 0; }
  send(){} close(){} ping(){} terminate(){} addEventListener(){} removeEventListener(){}
}
WebSocket.CONNECTING=0; WebSocket.OPEN=1; WebSocket.CLOSING=2; WebSocket.CLOSED=3;
WebSocket.WebSocket=WebSocket; WebSocket.default=WebSocket;
class WebSocketServer extends EventEmitter {}
WebSocket.WebSocketServer=WebSocketServer; WebSocket.Server=WebSocketServer;
module.exports=WebSocket;
`;

function writeMod(nmDir, name, body) {
  const d = path.join(nmDir, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'package.json'),
    JSON.stringify({ name, version: '0.0.0-clode-test', main: 'index.js' }) + '\n');
  fs.writeFileSync(path.join(d, 'index.js'), body);
}

const worldNode = (prefix) => path.join(prefix, 'bin', 'node');

// Build the withws/ and nows/ node prefixes the TUI tests need under sbx.dir/world.
// Each has bin/node -> real NODE and lib/node_modules with functional-fake render deps;
// withws also gets fake ws. The bundle resolves ws only via NODE_PATH derived from
// $CLODE_NODE's prefix (set_node_path), so the chosen prefix decides ws visibility.
function makeWsWorlds(sbx) {
  const root = path.join(sbx.dir, 'world');
  const out = {};
  for (const which of ['withws', 'nows']) {
    const prefix = path.join(root, which);
    fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
    const nm = path.join(prefix, 'lib', 'node_modules');
    fs.mkdirSync(nm, { recursive: true });
    fs.symlinkSync(NODE, worldNode(prefix));
    seedRenderDeps(nm);
    if (which === 'withws') writeMod(nm, 'ws', FAKE_WS);
    out[which] = prefix;
  }
  return out;
}

// Minimal synthetic ~/.claude.json: past onboarding + the capture cwd pre-trusted, so a
// fixed-duration no-keystroke capture never blocks on the theme-onboarding or the
// per-project trust prompt. Keyed by cwd (regenerated per run). If a future Claude Code
// changes these keys, this is the one place to adjust (see e2e-tui verification).
function seedClaudeProfile(home, opts = {}) {
  const profile = { hasCompletedOnboarding: true, theme: 'dark' };
  if (opts.trust !== false && opts.cwd) {
    profile.projects = { [opts.cwd]: {
      hasTrustDialogAccepted: true,
      hasCompletedProjectOnboarding: true,
    } };
  }
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify(profile));
}

// Drive opts.cmd under a PTY via tui-screen.cjs; return the rendered screen (stdout).
// tui-screen self-terminates after opts.seconds, so no external timeout is needed.
// opts: { seconds, cmd:[...], sendHex?, thenHex?:[...], rows?, cols?, env? }. cmd[0] is
// the absolute program to run under the PTY (e.g. a world node + BIN, or a native binary).
function capture(sbx, opts) {
  const args = [String(opts.seconds)];
  if (opts.sendHex) args.push('--send-hex', opts.sendHex);
  for (const th of opts.thenHex || []) args.push('--then-hex', th);
  if (opts.rows) args.push('--rows', String(opts.rows));
  if (opts.cols) args.push('--cols', String(opts.cols));
  args.push('--', ...opts.cmd);
  const env = { ...sbx.env, ...(opts.env || {}), TERM: 'xterm-256color' };
  for (const k of ['TMUX', 'TMUX_PANE', 'TERM_PROGRAM', 'NODE_PATH']) delete env[k];
  const r = spawnSync(NODE, [TUI_SCREEN, ...args], { encoding: 'utf8', env, maxBuffer: 8 * 1024 * 1024 });
  return r.stdout || '';
}

module.exports = { makeWsWorlds, seedClaudeProfile, capture, worldNode, TUI_SCREEN };
