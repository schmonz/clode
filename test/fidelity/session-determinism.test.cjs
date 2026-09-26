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
// every frame of every session's first run (type-edit: 6 frames, ~2035 cells; resize: 6
// frames, ~2675; scroll: 7 frames, ~13302; slash-menu: 7 frames, ~2968; all four 20980 on
// 2.1.278, 20971 on 2.1.251). The floor is 1000: a native that painted nothing compares
// identical to itself, and that must read BROKEN, not OK. A blank frame on either run is
// its own finding (ruling R8, in judgeSessions): two blank frames compare equal and judge
// nothing.
//
// Gated by test/live-frame-gate.cjs as a SESSION gate: live render (darwin opt-in,
// CLODE_LIVE_RENDER=1: it spawns the real bundle), not inside the concurrent full suite
// (it runs serially: CI's linux-x64-pty job, or `node --test` of this file), the PTY
// harness, a build provider, and a native claude (CLODE_NATIVE_CLAUDE, else `claude` on
// PATH). No credentials, no tokens: the canned mock answers and the profile holds a mock
// API key.
const { before, test } = require('node:test');
const assert = require('node:assert');
const { liveFrameGate } = require('../live-frame-gate.cjs');
const { captureSessions } = require('../frame-oracle.cjs');
const { judgeSessions, syntheticSession, corrupt } = require('../frame-diff.cjs');
const { defineGuard, guardTests } = require('../guard.cjs');
const { nativeVersion } = require('../../scripts/lib/native-oracle.cjs');
const { SCRIPT_DEFAULTS } = require('../tui-screen.cjs');
const { SESSIONS } = require('./sessions.cjs');

const FLOOR = 1000;

let SKIP = null, RUNS = null, WHAT = '';
before(async () => {
  const gate = liveFrameGate({ session: true });
  if (gate.skip) { SKIP = gate.skip; return; }
  const native = gate.native;
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

// Pure: every session's two runs, judged by judgeSessions (frame-diff.cjs), the one
// judgement every session gate shares. A finding names the session, the step and (via
// describeSessions) the row, column and class of the first differing cell.
const RUNS_AS = [{ who: 'native', run: 'run 1', native: true }, { who: 'native', run: 'run 2', native: true }];
function scanSessions({ runs, what }) {
  const findings = [];
  let examined = 0;
  for (const [name, r] of Object.entries(runs)) {
    const j = judgeSessions({ session: name, a: r.a, b: r.b, sides: RUNS_AS, mustShow: r.mustShow,
      differs: 'native painted the session differently the second time' });
    examined += j.examined;
    findings.push(...j.findings);
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

// Ruling R8: two blank boot frames compare equal and judge nothing -- the shape a loaded
// native produced in task 3 (boot frames taken before the first paint). Both runs blank at
// the same step: the diff is clean, and only this finding stands between it and a pass.
test('a blank native frame is a finding naming the session, the step and the run (ruling R8)', () => {
  const a = syntheticSession(3), b = syntheticSession(3);
  for (const s of [a, b]) for (const row of s.frames[0].frame.cells) for (const c of row) c.c = '';
  const r = scanSessions({ runs: { 'type-edit': { a, b, mustShow: null } }, what: 'x' });
  assert.deepStrictEqual(r.findings, [
    'type-edit: native painted a BLANK frame at step "boot" (run 1) -- two blank frames compare equal and judge nothing',
    'type-edit: native painted a BLANK frame at step "boot" (run 2) -- two blank frames compare equal and judge nothing',
  ]);
  assert.strictEqual(r.examined, 2 * 300, 'the blank frame adds nothing to examined');
});

test('the control\'s finding names the session, the step and the cell', () => {
  const [f] = scanSessions({ runs: plantedRuns(), what: 'x' }).findings;
  assert.match(f, /^type-edit: native painted the session differently the second time: first difference at step "step 2" \(frame 2 of 0-3\)/);
  assert.match(f, /row 1 {2}A: /);
  assert.match(f, /\[glyph\] col 5:/);
});
