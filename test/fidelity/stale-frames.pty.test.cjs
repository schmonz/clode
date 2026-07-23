'use strict';
// Worked example: capture-a-live-render-bug -> test, for RECIPE row F3
// (`test/fidelity/RECIPE.md`, category F, OPEN):
//
//   F3 | ? OPEN: stale frames -- a finished /login/doctor lingers; repaint
//   does not erase prior lines | repaint erases prior lines | - | NEW
//
// This drives a REAL built quaude under a real PTY (test/e2e-pty.cjs +
// test/tui-screen.cjs, the same harness test/e2e-tui-tjs.test.cjs and
// test/e2e-doctor-parity.test.cjs use): open /doctor (a full-screen report
// ending in the literal footer "Enter to close"), send a second Enter to
// close it, let the TUI repaint, and assert the FINAL rendered screen no
// longer shows the report's footer or its leading full-width rule
// (test/doctor-parity.cjs's own REPORT_RULE anchor) -- i.e. the finished
// command's frame was actually erased, not left lingering underneath/above
// the live prompt.
//
// NOTE (Task 6 brief): the plan's original Step-2 skeleton referenced
// `makeWsWorlds`/`worlds.naude`/`worlds.quaude` from ../e2e-pty.cjs -- those
// names do not exist. test/e2e-pty.cjs's real, exported surface is
// `seedClaudeProfile(home, opts)`, `capture(sbx, opts)`, `TUI_SCREEN`, and a
// "world" is `sandbox()` from test/e2e.cjs (a single {dir, home, stateRoot,
// env}), not a pair. There is also no ready-made "run naude and quaude side
// by side" helper for a full interactive render -- test/e2e-doctor-parity.
// test.cjs is the closest existing two-sided PTY capture, and it compares
// the NATIVE provider binary against quaude (not naude), with the strict
// comparison itself left `t.skip`'d pending an allowlist. Per the brief's
// fallback instruction, this worked example is therefore SINGLE-ENGINE
// (quaude only): it asserts a client-observable render invariant directly
// against the rendered screen, rather than diffing two live captures. A
// genuine two-engine (naude vs quaude, or native vs quaude) PTY diff for F3
// is noted in CONVERTING.md as a harness extension, not implemented here.
//
// GATED behind CLODE_LIVE_RENDER=1 (spawns a real `clode build` against a
// real provider bundle, then drives the built quaude under a real PTY;
// touches the Keychain / may touch the network -- same boundary as
// e2e-tui-tjs.test.cjs and e2e-doctor-parity.test.cjs). Without the flag
// this file must SKIP cleanly (exit 0, no error) -- verified by running
// `node --test test/fidelity/stale-frames.pty.test.cjs` with no env set.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sandbox, REPO } = require('../e2e.cjs');
const { seedClaudeProfile, capture } = require('../e2e-pty.cjs');
const { resolveClaudeBin } = require('../../libexec/clode-resolve.cjs');
const { tjsPath } = require('../node-shim-helper.cjs');

const ENTRY = path.join(REPO, 'bin', 'clode');

function realProvider() {
  try { const p = resolveClaudeBin({ env: process.env }); if (p && fs.existsSync(p)) return p; } catch { /* */ }
  const home = path.join(os.homedir(), '.local', 'bin', 'claude');
  return fs.existsSync(home) ? home : null;
}

// "/doctor" then CR (open), typed as raw hex bytes at fixed delays -- same
// encoding e2e-doctor-parity.test.cjs uses. OPEN_HEX captures mid-report (to
// confirm the report actually opened); CLOSE_HEX adds a second CR later
// (close) and captures after the repaint that should follow it.
const OPEN_HEX = ['2f646f63746f72@4', '0d@6'];              // "/doctor", CR (open)
const CLOSE_HEX = [...OPEN_HEX, '0d@11'];                    // + CR (close)

// The report's own footer, straight from test/doctor-parity.cjs's
// REPORT_FOOTER -- the client-observable marker of "the /doctor frame is
// still (or again) on screen". (A generic "40+ dashes" rule marker was tried
// first and rejected: quaude's ordinary prompt box border is ALSO drawn with
// long dash lines, so a bare rule-regex false-positives on ordinary UI chrome
// that has nothing to do with a stale /doctor frame -- see task-6-report.md.)
const FOOTER = /Enter to close/;

let SKIP = null, REPORT_OK = false, OPEN_SCREEN = '', CLOSE_SCREEN = '', SBX = null, DIR = null;

before(() => {
  if (process.env.CLODE_LIVE_RENDER !== '1') {
    SKIP = 'live-render opt-in only (set CLODE_LIVE_RENDER=1; spawns a real bundle, touches Keychain)';
    return;
  }
  if (!tjsPath()) { SKIP = 'no tjs binary (CLODE_TJS or build/tjs/tjs)'; return; }
  const provider = realProvider();
  if (!provider) { SKIP = 'no resolvable Claude Code provider'; return; }
  SBX = sandbox();
  seedClaudeProfile(SBX.home, { cwd: REPO });
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fidelity-stale-frames-'));
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
  OPEN_SCREEN = capture(SBX, { seconds: 10, thenHex: OPEN_HEX, rows: 120, cols: 100, cmd: [quaude] });
  CLOSE_SCREEN = capture(SBX, { seconds: 15, thenHex: CLOSE_HEX, rows: 120, cols: 100, cmd: [quaude] });
  REPORT_OK = FOOTER.test(OPEN_SCREEN);
});
after(() => {
  if (SBX) { try { fs.rmSync(SBX.dir, { recursive: true, force: true }); } catch { /* */ } }
  if (DIR) { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } }
});

test('the capture actually reached a /doctor report (precondition)', (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  if (!REPORT_OK) {
    // Environmental gap, not the thing F3 is about: without a logged-in
    // provider profile, quaude's /doctor answers inline ("Not logged in ·
    // Please run /login") and never opens the full-screen report at all, so
    // there is nothing whose repaint-erasure F3 could even be tested against
    // here. Confirmed live 2026-07-23 on this box's cached provider. A rig
    // with a logged-in profile (e.g. the iTerm2 autonomous rig) is needed to
    // actually exercise F3 -- see CONVERTING.md.
    t.skip(`provider not logged in here; /doctor never opens the full report to test F3 against:\n${OPEN_SCREEN}`);
    return;
  }
  assert.match(OPEN_SCREEN, FOOTER, `never saw the /doctor report footer -- capture too short or /doctor didn't open:\n${OPEN_SCREEN}`);
});

// RECIPE F3: after the second Enter closes /doctor, the repaint must erase
// the report's frame -- not leave its footer lingering on screen. This is an
// OPEN ("?") row: if this assertion fails, that failure IS the captured
// divergence -- per systematic-debugging, it stays as the failing/skipped
// reference (see CONVERTING.md's rule: new divergence lands as a failing
// test FIRST, then the fix) and F3 stays a "?" in RECIPE.md rather than
// being forced green.
test('quaude erases a completed /doctor frame on repaint, like the rule requires', (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  if (!REPORT_OK) { t.skip('precondition test already explains why (provider not logged in here)'); return; }
  assert.doesNotMatch(CLOSE_SCREEN, FOOTER,
    `stale /doctor footer ("Enter to close") lingered after close -- repaint did not erase it (RECIPE F3):\n${CLOSE_SCREEN}`);
});
