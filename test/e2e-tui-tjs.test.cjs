'use strict';
// M1 (phase 3): the real Ink TUI renders under a built quaude (tjs + node-shim).
// Opt-in — builds a real quaude (`clode build`) and spawns IT directly (touches the
// Keychain, may touch the network; no launcher/CLODE_ENGINE involved — a fused
// quaude carries its own engine and deps as members). Gates: CLODE_TJS (or
// build/tjs/tjs) + CLODE_LIVE_RENDER=1 + a resolvable provider.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sandbox, REPO } = require('./e2e.cjs');
const { seedClaudeProfile, capture } = require('./e2e-pty.cjs');
const { resolveClaudeBin } = require('../libexec/clode-resolve.cjs');
const { tjsPath } = require('./node-shim-helper.cjs');

const ENTRY = path.join(REPO, 'bin', 'clode');
function realProvider() {
  try { const p = resolveClaudeBin({ env: process.env }); if (p && fs.existsSync(p)) return p; } catch { /* */ }
  const home = path.join(os.homedir(), '.local', 'bin', 'claude');
  return fs.existsSync(home) ? home : null;
}

let SKIP = null, SCREEN = '', SBX = null, DIR = null;
before(() => {
  if (!tjsPath()) { SKIP = 'no tjs binary (CLODE_TJS or build/tjs/tjs)'; return; }
  if (process.env.CLODE_LIVE_RENDER !== '1') { SKIP = 'live-render opt-in only (set CLODE_LIVE_RENDER=1)'; return; }
  const provider = realProvider();
  if (!provider) { SKIP = 'no resolvable Claude Code provider'; return; }
  SBX = sandbox();
  seedClaudeProfile(SBX.home, { cwd: REPO });
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-tui-tjs-'));
  const quaude = path.join(DIR, 'quaude');
  const build = spawnSync(process.execPath, [ENTRY, 'build', '--out', quaude], {
    encoding: 'utf8',
    timeout: 300000,
    env: {
      ...process.env,
      CLODE_CLAUDE_BIN: provider,
      CLODE_CACHE: path.join(DIR, 'cache'),   // hermetic: never the real cache
      CLODE_TJS: tjsPath(),
      DYLD_INSERT_LIBRARIES: '',
    },
  });
  if (build.status !== 0) { SKIP = `clode build failed:\n${build.stdout}\n${build.stderr}`; return; }
  SCREEN = capture(SBX, { seconds: 12, cmd: [quaude] });
});
after(() => {
  if (SBX) { try { fs.rmSync(SBX.dir, { recursive: true, force: true }); } catch { /* */ } }
  if (DIR) { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } }
});

test('TUI renders the welcome box (Claude Code) under a built quaude', (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  assert.match(SCREEN, /Claude Code/);
});
