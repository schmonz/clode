const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sandbox, REPO } = require('./e2e.cjs');
const { makeWsWorlds, seedClaudeProfile, capture, worldNode } = require('./e2e-pty.cjs');
const { resolveClaudeBin } = require('../libexec/clode-resolve.cjs');

const BIN = path.join(REPO, 'bin', 'clode');

// Resolve a REAL Claude Code provider from the ambient environment (these tests render
// the real Ink TUI; the fake fixture can't). Skip everything when none is available.
function realProvider() {
  try {
    const p = resolveClaudeBin({ env: process.env });
    if (p && fs.existsSync(p)) return p;
  } catch { /* fall through */ }
  const home = path.join(os.homedir(), '.local', 'bin', 'claude');
  return fs.existsSync(home) ? home : null;
}

let SKIP = null;   // reason string, or null if we captured
let WS = '';       // rendered screen with ws present
let NOWS = '';     // rendered screen with ws missing
let SBX = null;

before(async () => {
  // OPT-IN ONLY. This spawns the REAL Claude Code bundle to render the Ink TUI, which
  // probes the macOS login Keychain (auth status) and pops system dialogs, and may touch
  // the network. Keep it OUT of the default offline `npm test`; a dev opts in explicitly.
  if (process.env.CLODE_LIVE_RENDER !== '1') {
    SKIP = 'live-render opt-in only (set CLODE_LIVE_RENDER=1; spawns the real bundle, touches Keychain)';
    return;
  }
  const provider = realProvider();
  if (!provider) { SKIP = 'no resolvable Claude Code provider (environmental)'; return; }
  SBX = sandbox();                                  // no per-test t; cleaned up in after()
  SBX.env.CLODE_CLAUDE_BIN = provider;              // determinism, not ambient PATH order
  // Seed a past-onboarding + trusted profile keyed by the capture cwd (REPO), so the
  // fixed-duration, no-keystroke capture reaches the render / the ws-use point.
  seedClaudeProfile(SBX.home, { cwd: REPO });
  const { withws, nows } = makeWsWorlds(SBX);
  // Warm the per-binary cache first so a (re)extract never eats into the timed captures.
  spawnSync(worldNode(withws), [BIN, '--version'],
    { env: { ...SBX.env, CLODE_NODE: worldNode(withws) }, encoding: 'utf8' });
  WS = capture(SBX, { seconds: 11, cmd: [worldNode(withws), BIN],
    env: { CLODE_NODE: worldNode(withws) } });
  NOWS = capture(SBX, { seconds: 11, cmd: [worldNode(nows), BIN],
    env: { CLODE_NODE: worldNode(nows) } });
});

after(() => { if (SBX) { try { fs.rmSync(SBX.dir, { recursive: true, force: true }); } catch { /* */ } } });

test('TUI renders the welcome box (Claude Code) when ws is present', (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  assert.match(WS, /Claude Code/);
});

test('TUI reaches an interactive prompt when ws is present', (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  assert.match(WS, /shortcuts|for agents|\/effort|trust this folder|Accessing workspace/);
});

test('TUI has no npm-deprecation banner when ws is present', (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  assert.doesNotMatch(WS, /deprecated/i);
});

test('TUI fails LOUD (not a blank hang) when the ws ext-dep is missing', (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  // Regression guard (#60): missing ws used to be swallowed by a render-gating promise,
  // leaving a blank screen. It must surface a clear message. The hermetic ws-fail-loud
  // CONTRACT is covered by test/websocket.test.cjs; this asserts it reaches the SCREEN
  // during a real TUI render.
  assert.match(NOWS, /WebSocket features/);
  assert.match(NOWS, /npm install -g ws/);
});
