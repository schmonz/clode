'use strict';
// NATIVE REPAINTS EVERY SESSION IDENTICALLY, TWICE. The precondition of every phase-5
// session gate (native vs quaude, reset invisibility): each session in sessions.cjs is
// captured twice on native Claude Code -- fresh identically seeded HOME each time, the
// same canned mock, a frame per step taken when output settles -- and the two frame
// sequences must be identical cell for cell. If native cannot reproduce its own screen,
// a native-vs-quaude difference proves nothing about quaude; this guard runs first so a
// racy script fails HERE, as a racy script, never downstream as a quaude regression.
//
// NO TOLERANCE. A difference, or a step that never settled, is a finding that the SCRIPT
// must fix (a settle point after timing-sensitive UI, a time display off identically on
// both sides) or that names the step nondeterministic with evidence. Never a widened cap,
// never an allowed diff.
//
// WHAT THE FIRST SESSION TAUGHT (task 3, 2026-09-25, native 2.1.278 and 2.1.251,
// darwin-arm64): the welcome screen is not at rest when it first stops painting. The
// Clawd logo plays a random one of four entrance animations (60 ms frames, ~1 s, but
// 1314 ms between two frames with 18 boots running at once), and an effort notification
// ("high . /effort", timeoutMs 1e4) clears itself ~9.9 s after the first paint. Native
// also went more than 800 ms silent between its first bytes and its first paint in 3 of
// 8 concurrent runs. With an 800 ms boot window those 3 runs took a BLANK boot frame and
// differed from their twins in 759 cell-classes -- the banner-logo differences a loaded
// full-suite run had shown. So the boot frame waits out a 12 s window (tui-screen.cjs
// SCRIPT_DEFAULTS.bootSettleMs, where the numbers live), and a step's frame counts quiet
// only from output that step caused.
//
// WHAT IT IS A GUARD OVER, and its floor. `examined` is the visibly painted cells over
// every frame of every session's first run (type-edit: 6 frames, ~2030 cells). The floor
// is 1000: a native that painted nothing compares identical to itself, and that must read
// BROKEN, not OK.
//
// Gated like interactive-frame-diff (the session gates' own preconditions): live render
// (darwin opt-in, CLODE_LIVE_RENDER=1: it spawns the real bundle), the PTY harness, a
// build provider, and a native claude (CLODE_NATIVE_CLAUDE, else `claude` on PATH). No
// credentials, no tokens: the canned mock answers and the profile holds a mock API key.
const { before, test } = require('node:test');
const assert = require('node:assert');
const { liveRenderSkipReason } = require('../live-render-helper.cjs');
const { skipReason: providerSkipReason } = require('../provider-resolve.cjs');
const { captureSessions } = require('../frame-oracle.cjs');
const { diffSessions, describeSessions, nonBlank, frameShows, syntheticSession, corrupt } = require('../frame-diff.cjs');
const { defineGuard, guardTests } = require('../guard.cjs');
const { resolveNativeClaude, nativeVersion } = require('../../scripts/lib/native-oracle.cjs');
const { SCRIPT_DEFAULTS } = require('../tui-screen.cjs');
const { SESSIONS } = require('./sessions.cjs');

const FLOOR = 1000;

function harnessMissing() {
  const path = require('node:path');
  const REPO = path.resolve(__dirname, '..', '..');
  try {
    const { harnessDir } = require(path.join(REPO, 'scripts', 'platform-tag.cjs'));
    require.resolve(path.join(harnessDir(REPO), 'node_modules', 'node-pty'));
    return null;
  } catch { /* fall through to bare resolution */ }
  try { require.resolve('node-pty'); return null; } catch { /* */ }
  return 'PTY harness (node-pty/@xterm/headless) is not installed for this platform tag';
}

let SKIP = null, RUNS = null, WHAT = '';
before(async () => {
  SKIP = liveRenderSkipReason() || harnessMissing() || providerSkipReason(process.env) || null;
  if (SKIP) return;
  const native = resolveNativeClaude();
  if (!native) { SKIP = 'no native claude (set CLODE_NATIVE_CLAUDE, or put `claude` on PATH)'; return; }
  const names = Object.keys(SESSIONS);
  WHAT = `native ${native} (${nativeVersion(native)}) against itself, sessions ${names.join(', ')}, `
    + `settle defaults ${JSON.stringify(SCRIPT_DEFAULTS)}`;
  RUNS = {};
  for (const name of names) {
    // The whole entry, so anything a session states (script, scene, geometry, a limit of its
    // own) reaches the capture exactly as the session gates will pass it.
    const { ref, sub } = await captureSessions({ ...SESSIONS[name], ref: native, sub: native });
    RUNS[name] = { a: ref, b: sub, mustShow: SESSIONS[name].mustShow };
  }
});

// Pure: every session's two runs, judged. A finding names the session, the step and (via
// describeSessions) the row, column and class of the first differing cell.
function scanSessions({ runs, what }) {
  const findings = [];
  let examined = 0;
  for (const [name, r] of Object.entries(runs)) {
    if (!r.a || !r.b) {
      findings.push(`${name}: a capture produced no session (run 1: ${!!r.a}, run 2: ${!!r.b}); the reason is on stderr`);
      continue;
    }
    examined += r.a.frames.reduce((n, f) => n + nonBlank(f.frame), 0);
    for (const [run, s] of [['run 1', r.a], ['run 2', r.b]]) {
      if (s.exit) findings.push(`${name}: native exited during step "${s.exit.during}" on ${run} (code ${s.exit.code}, signal ${s.exit.signal})`);
      for (const f of s.frames) {
        if (!f.settled) {
          findings.push(`${name}: step "${f.label}" never settled on native within ${f.ms} ms (${run}) -- `
            + 'fix the script (a settle point after the timing-sensitive UI), never the cap');
        }
      }
    }
    const last = r.a.frames[r.a.frames.length - 1];
    if (r.mustShow && !frameShows(last.frame, r.mustShow)) {
      findings.push(`${name}: native never painted ${JSON.stringify(r.mustShow)} by its last step ("${last.label}"), `
        + 'so this session judged nothing it exists for');
    }
    const d = diffSessions(r.a, r.b, { maxDetail: 30 });
    if (!d.linksJudged) findings.push(`${name}: hyperlinks were NOT observable in a frame, so identity cannot be claimed`);
    if (!d.equal) findings.push(`${name}: native painted the session differently the second time: ${describeSessions(r.a, r.b, d)}`);
  }
  return { examined, findings, note: what };
}

guardTests(defineGuard({
  name: 'session-determinism',
  floor: FLOOR,
  read() {
    if (SKIP) return { skip: SKIP };
    return { runs: RUNS, what: WHAT };
  },
  scan: scanSessions,
  control() { return { runs: plantedRuns(), what: 'synthetic control' }; },
}));

// The control: one planted cell in one frame of one session -- the smallest way native
// could fail to repaint the same screen twice.
function plantedRuns() {
  const a = syntheticSession(4), b = syntheticSession(4);
  b.frames[2].frame = corrupt(b.frames[2].frame, 'glyph', { y: 1, x: 5 });
  return { 'type-edit': { a, b, mustShow: null } };
}

// The scan's other findings, without a capture: each is a way a session can look
// identical to itself while proving nothing.
test('an unsettled step, a native that exited, a capture that failed and an unpainted scene are each findings', () => {
  const a = syntheticSession(3), b = syntheticSession(3);
  b.frames[1].settled = false;
  b.frames[1].ms = 15020;
  b.exit = { during: 'step 2', code: 1, signal: null };
  const r = scanSessions({ runs: { s: { a, b, mustShow: 'never painted' }, gone: { a: null, b, mustShow: null } }, what: 'x' });
  assert.deepStrictEqual(r.findings, [
    's: native exited during step "step 2" on run 2 (code 1, signal null)',
    's: step "step 1" never settled on native within 15020 ms (run 2) -- fix the script (a settle point after the timing-sensitive UI), never the cap',
    's: native never painted "never painted" by its last step ("step 2"), so this session judged nothing it exists for',
    'gone: a capture produced no session (run 1: false, run 2: true); the reason is on stderr',
  ]);
  assert.strictEqual(r.examined, 3 * 300, 'examined counts run 1 of every session that captured');
});

test('the control\'s finding names the session, the step and the cell', () => {
  const [f] = scanSessions({ runs: plantedRuns(), what: 'x' }).findings;
  assert.match(f, /^type-edit: native painted the session differently the second time: first difference at step "step 2" \(frame 2 of 0-3\)/);
  assert.match(f, /row 1 {2}A: /);
  assert.match(f, /\[glyph\] col 5:/);
});
