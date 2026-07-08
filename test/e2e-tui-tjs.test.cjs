'use strict';
// M1 (phase 3): the real Ink TUI renders under CLODE_ENGINE=tjs. Opt-in — spawns
// the real Claude Code bundle under the patched tjs (touches the Keychain, may
// touch the network). Gates: CLODE_TJS (or build/tjs/tjs) + CLODE_LIVE_RENDER=1.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sandbox, REPO } = require('./e2e.cjs');
const { makeWsWorlds, seedClaudeProfile, capture, worldNode } = require('./e2e-pty.cjs');
const { resolveClaudeBin } = require('../libexec/clode-resolve.cjs');
const { tjsPath } = require('./node-shim-helper.cjs');

const BIN = path.join(REPO, 'bin', 'clode');
function realProvider() {
  try { const p = resolveClaudeBin({ env: process.env }); if (p && fs.existsSync(p)) return p; } catch { /* */ }
  const home = path.join(os.homedir(), '.local', 'bin', 'claude');
  return fs.existsSync(home) ? home : null;
}

let SKIP = null, SCREEN = '', SBX = null;
before(async () => {
  if (!tjsPath()) { SKIP = 'no tjs binary (CLODE_TJS or build/tjs/tjs)'; return; }
  if (process.env.CLODE_LIVE_RENDER !== '1') { SKIP = 'live-render opt-in only (set CLODE_LIVE_RENDER=1)'; return; }
  const provider = realProvider();
  if (!provider) { SKIP = 'no resolvable Claude Code provider'; return; }
  SBX = sandbox();
  SBX.env.CLODE_CLAUDE_BIN = provider;
  SBX.env.CLODE_ENGINE = 'tjs';
  SBX.env.CLODE_TJS = tjsPath();
  seedClaudeProfile(SBX.home, { cwd: REPO });
  const { withws } = makeWsWorlds(SBX);
  // Warm the per-binary extract cache so a (re)extract never eats the timed capture.
  spawnSync(worldNode(withws), [BIN, '--version'],
    { env: { ...SBX.env, CLODE_NODE: worldNode(withws) }, encoding: 'utf8' });
  SCREEN = capture(SBX, { seconds: 12, cmd: [worldNode(withws), BIN],
    env: { CLODE_NODE: worldNode(withws) } });
});
after(() => { if (SBX) { try { fs.rmSync(SBX.dir, { recursive: true, force: true }); } catch { /* */ } } });

test('TUI renders the welcome box (Claude Code) under CLODE_ENGINE=tjs', (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  assert.match(SCREEN, /Claude Code/);
});
