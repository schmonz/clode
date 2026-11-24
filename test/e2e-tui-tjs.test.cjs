'use strict';
// M1 (phase 3): the real Ink TUI renders under a built quaude (tjs + node-shim).
// Builds a real quaude (`clode build`) and spawns IT directly (no
// launcher/CLODE_ENGINE involved — a blobulated quaude carries its own engine and
// deps as members). On darwin this is opt-in (spawning the real bundle probes
// the macOS Keychain); elsewhere it runs by default — see
// live-render-helper.cjs. Gates: CLODE_TJS (or build/tjs/tjs) + a resolvable
// provider + (darwin only) CLODE_LIVE_RENDER=1.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sandbox, REPO } = require('./e2e.cjs');
const { seedClaudeProfile, captureBoot } = require('./e2e-pty.cjs');
const { resolveClaudeBin } = require('../libexec/clode-resolve.cjs');
const { tjsPath } = require('./node-shim-helper.cjs');
const { stateRoot } = require('./state-root-helper.cjs');
const { liveRenderSkipReason } = require('./live-render-helper.cjs');
const { removeNamingRefusals } = require('./suite-home.cjs');

const ENTRY = path.join(REPO, 'scripts', 'stage0.mjs');
function realProvider() {
  try { const p = resolveClaudeBin({ env: process.env }); if (p && fs.existsSync(p)) return p; } catch { /* */ }
  const home = process.env.CLODE_TEST_NATIVE_LAUNCHER || path.join(os.homedir(), '.local', 'bin', 'claude');
  return fs.existsSync(home) ? home : null;
}

let SKIP = null, SCREEN = '', BOOT = null, CAPTURE_ERROR = null, SBX = null, DIR = null;
before(async () => {
  if (!tjsPath()) { SKIP = 'no tjs binary (CLODE_TJS or build/tjs/tjs)'; return; }
  const liveRenderSkip = liveRenderSkipReason();
  if (liveRenderSkip) { SKIP = liveRenderSkip; return; }
  const provider = realProvider();
  if (!provider) { SKIP = 'no resolvable Claude Code provider'; return; }
  SBX = sandbox();
  seedClaudeProfile(SBX.home, { cwd: REPO });
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-tui-tjs-'));
  // `.exe` on win32 (written reason for the per-platform name): a native build
  // honours an explicit --out VERBATIM (libexec/clode-build.cjs resolveBuildOut),
  // and libuv cannot spawn an extensionless file on Windows. With bare `quaude`
  // the windows-amd64-tui job built, died in SMOKE with `spawn …\quaude ENOENT`,
  // and SKIPPED this file's only render test — green while asserting nothing
  // (CI runs 35727111476, 35692420157). Same spelling as test/built-binary.cjs.
  const quaude = path.join(DIR, process.platform === 'win32' ? 'quaude.exe' : 'quaude');
  const build = spawnSync(process.execPath, [ENTRY, 'build', '--out', quaude], {
    encoding: 'utf8',
    timeout: 300000,
    env: {
      ...process.env,
      CLODE_CLAUDE_BIN: provider,
      CLODE_CACHE: path.join(DIR, 'cache'),   // hermetic: never the real cache
      // stateRoot(DIR): respects test/run.mjs's central CLODE_STATE_ROOT when
      // present, else falls back to this file's own private DIR -- needed
      // for a standalone `node --test` run and for CI, which invokes this
      // file directly (.github/workflows/ci.yml runs e2e-tui-tjs.test.cjs).
      CLODE_STATE_ROOT: stateRoot(DIR),
      CLODE_TJS: tjsPath(),
      DYLD_INSERT_LIBRARIES: '',
    },
  });
  if (build.status !== 0) { SKIP = `clode build failed:\n${build.stdout}\n${build.stderr}`; return; }
  // The boot frame once its paint has settled (captureBoot), not the screen at a fixed 12 s: a fixed
  // window is outrun on a loaded box (test/fixed-window-captures.test.cjs). The capture THROWS when the
  // driver reports quaude outlived its stop (exit 4, tui-screen.cjs stopChild) or produced no frame
  // sequence; that error is kept for the second test, which is about exactly that. windows-amd64-tui
  // (CI 44460009323) found quaude.exe still mapped at cleanup, because the driver's kill never reached
  // it on Windows and nothing waited.
  try {
    BOOT = await captureBoot(SBX, { cmd: [quaude] });
    SCREEN = BOOT.text;
  } catch (e) { CAPTURE_ERROR = e; }
});
// A dir that will not go is a finding, named entry by entry (suite-home.cjs removeNamingRefusals), never swallowed:
// windows-amd64-tui (CI 44443821699) failed removing the suite home at exit with node's root-only EPERM, and these two
// (DIR holds the built quaude.exe) used to fail, if they did, silently. Both are tried before either failure is thrown.
after(() => {
  const failures = [];
  if (SBX) { try { removeNamingRefusals(SBX.dir, { what: 'the e2e sandbox' }); } catch (e) { failures.push(e); } }
  if (DIR) { try { removeNamingRefusals(DIR, { what: 'the build dir (quaude, its cache and state)' }); } catch (e) { failures.push(e); } }
  if (failures.length) throw new Error(failures.map((e) => e.message).join('\n'));
});

test('TUI renders the welcome box (Claude Code) under a built quaude', (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  assert.ifError(CAPTURE_ERROR);
  assert.ok(BOOT.settled, `the TUI never painted and settled (${BOOT.ms} ms):\n${SCREEN}`);
  assert.match(SCREEN, /Claude Code/);
});

test('the driver stopped the built quaude and saw it gone before it returned (it outlives nothing)', (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  // captureSession refuses a driver exit 4 (the TUI outlived its stop) and any exit that left no whole
  // frame sequence, so no error here is the driver's word that quaude was stopped and gone.
  assert.ifError(CAPTURE_ERROR);
});
