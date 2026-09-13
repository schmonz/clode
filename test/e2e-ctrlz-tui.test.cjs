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
// Build + real TUI: tjs + a provider, always. On darwin ALSO opt-in
// (CLODE_LIVE_RENDER=1) because spawning the real bundle probes the macOS
// Keychain; elsewhere it runs by default — see live-render-helper.cjs.
// POSIX only (Ctrl-Z/SIGTSTP is a POSIX terminal concept).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { sandbox, REPO } = require('./e2e.cjs');
const { seedClaudeProfile, capture } = require('./e2e-pty.cjs');
const { tjsPath } = require('./node-shim-helper.cjs');
const { liveRenderSkipReason } = require('./live-render-helper.cjs');
const { builtQuaude } = require('./built-binary.cjs');

const MARKER = 'ctrlz-survivor-73';

let SKIP = null, SCREEN = '', SBX = null;
before(() => {
  if (process.platform === 'win32') { SKIP = 'POSIX only (Ctrl-Z/SIGTSTP is a POSIX terminal concept)'; return; }
  if (!tjsPath()) { SKIP = 'no tjs binary (CLODE_TJS or build/tjs/tjs)'; return; }
  const liveRenderSkip = liveRenderSkipReason();
  if (liveRenderSkip) { SKIP = liveRenderSkip; return; }

  // CLODE_QUAUDE if pointed at one (fast, and how CI/a slow box hands one over),
  // else builtQuaude() builds one hermetically ONCE for this process.
  const built = builtQuaude();
  if (built.skip) { SKIP = built.skip; return; }
  const quaude = built.path;

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
});

test('quaude survives Ctrl-Z: the TUI stays alive and responsive after suspend', (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  // Did NOT crash on Ctrl-Z: the welcome box is still (re)painted...
  assert.match(SCREEN, /Claude Code/, `TUI did not survive Ctrl-Z (no welcome box):\n${SCREEN}`);
  // ...and input still works: the marker typed AFTER Ctrl-Z landed in the prompt.
  assert.match(SCREEN, new RegExp(MARKER), `input unresponsive after Ctrl-Z (marker missing):\n${SCREEN}`);
});
