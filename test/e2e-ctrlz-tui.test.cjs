'use strict';
// Ctrl-Z against a REAL quaude TUI: the regression guard for the crash-on-suspend
// bug (6300aa3/[[quaude-tty-quit-ctrlz-diagnosis]] — the suspend path printed a
// message then DIED on a swallowed TypeError). Drives a built quaude's Ink TUI
// under a PTY, sends the raw Ctrl-Z byte (0x1a) the way a terminal in raw mode
// delivers it — quaude's own handler reads it and self-suspends via
// process.kill(0,"SIGTSTP"); on resume its process.on('SIGCONT') repaints — then
// types a marker and asserts the TUI is STILL ALIVE and RESPONSIVE (welcome box
// repainted + the marker landed in the input). This replaces node-shim-ctrlz-pty:
// that test drove the COOKED-mode line-discipline SIGTSTP (a path quaude never uses
// — it runs raw with ISIG off) and its `sh -m` orphan-avoidance held on NetBSD but
// not darwin, where the kernel discards SIGTSTP to the orphaned pgroup (host node
// failed identically — not a clode/tjs defect). This test needs neither the actual
// kernel-stop nor cooked mode, so it is deterministic across platforms.
//
// The SIGTSTP/SIGCONT wiring itself stays covered by node-shim-signals.test.cjs.
// Opt-in (build + real TUI + Keychain): CLODE_LIVE_RENDER=1 + tjs + a provider.
// POSIX only (Ctrl-Z/SIGTSTP is a POSIX terminal concept).
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
const MARKER = 'ctrlz-survivor-73';

function realProvider() {
  try { const p = resolveClaudeBin({ env: process.env }); if (p && fs.existsSync(p)) return p; } catch { /* */ }
  const home = path.join(os.homedir(), '.local', 'bin', 'claude');
  return fs.existsSync(home) ? home : null;
}

let SKIP = null, SCREEN = '', SBX = null, DIR = null;
before(() => {
  if (process.platform === 'win32') { SKIP = 'POSIX only (Ctrl-Z/SIGTSTP is a POSIX terminal concept)'; return; }
  if (!tjsPath()) { SKIP = 'no tjs binary (CLODE_TJS or build/tjs/tjs)'; return; }
  if (process.env.CLODE_LIVE_RENDER !== '1') { SKIP = 'live-render opt-in only (set CLODE_LIVE_RENDER=1)'; return; }

  // Use a prebuilt quaude if pointed at one (fast), else build one hermetically.
  let quaude = process.env.CLODE_QUAUDE;
  if (!(quaude && fs.existsSync(quaude))) {
    const provider = realProvider();
    if (!provider) { SKIP = 'no resolvable Claude Code provider (and no CLODE_QUAUDE)'; return; }
    DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-ctrlz-'));
    quaude = path.join(DIR, 'quaude');
    const build = spawnSync(process.execPath, [ENTRY, 'build', '--out', quaude], {
      encoding: 'utf8', timeout: 300000,
      // CLODE_STATE_ROOT: clodeBuild's finally now appends one build-trace.jsonl
      // line per build (Task 5), resolved off HOME/XDG when nothing overrides it.
      env: { ...process.env, CLODE_CLAUDE_BIN: provider, CLODE_CACHE: path.join(DIR, 'cache'), CLODE_STATE_ROOT: DIR, CLODE_TJS: tjsPath(), DYLD_INSERT_LIBRARIES: '' },
    });
    if (build.status !== 0) { SKIP = `clode build failed:\n${build.stdout}\n${build.stderr}`; return; }
  }

  SBX = sandbox();
  seedClaudeProfile(SBX.home, { cwd: REPO });
  // Send Ctrl-Z (0x1a) after the TUI is up, then type the marker; capture the final
  // screen. Survival + responsiveness = the marker landed in the input prompt.
  SCREEN = capture(SBX, {
    seconds: 14,
    cmd: [quaude],
    sendHex: '1a',
    thenHex: [Buffer.from(MARKER).toString('hex')],
  });
});
after(() => {
  if (SBX) { try { fs.rmSync(SBX.dir, { recursive: true, force: true }); } catch { /* */ } }
  if (DIR) { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } }
});

test('quaude survives Ctrl-Z: the TUI stays alive and responsive after suspend', (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  // Did NOT crash on Ctrl-Z: the welcome box is still (re)painted...
  assert.match(SCREEN, /Claude Code/, `TUI did not survive Ctrl-Z (no welcome box):\n${SCREEN}`);
  // ...and input still works: the marker typed AFTER Ctrl-Z landed in the prompt.
  assert.match(SCREEN, new RegExp(MARKER), `input unresponsive after Ctrl-Z (marker missing):\n${SCREEN}`);
});
