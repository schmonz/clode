'use strict';
// NATIVE AND QUAUDE PAINT EVERY SESSION THE SAME, FRAME BY FRAME (CellSegmenter phase 5).
// Each guarded session in sessions.cjs is captured on native Claude Code and on the built
// quaude -- one canned mock, the same env and settings, a fresh identically seeded HOME per
// side, a frame per scripted step taken when output settles (test/frame-oracle.cjs
// captureSessions) -- and the two frame sequences must be identical cell for cell (glyph,
// width, SGR, hyperlink), every step settled on both sides.
//
// WHY FRAMES, NOT A FRAME. The single-frame gates (interactive-frame-diff) see one screen.
// A defect that shows only after a later step -- a repaint over cells an earlier step
// filled, a reflow, a resize the TUI mishandles -- needs a frame per step. So each session
// repaints what an earlier step painted: type-edit erases and retypes wide and combining
// clusters in the prompt; resize reflows a wrapped reply narrower, wider and back; scroll
// pages and wheels a 320-column reply up and down under an overlay (and segments lines too
// long for the bundle's 256-cell scratch buffers); slash-menu opens and closes the menu.
//
// THE PRECONDITION is session-determinism.test.cjs: native repaints each session
// identically twice. A difference here is a quaude finding only because that holds.
//
// NO TOLERANCE. A difference is localized by its step label (the cause is often the
// PREVIOUS step's damage). A paint/setCell cause is reproduced at unit level first -- a
// scenario in scripts/lib/paint-corpus.cjs that the paint gate (paint-differential.test.cjs)
// fails on -- before bun-shim.cjs changes: the unit gate must catch a paint bug before the
// screen does. Never an allowed diff, never a widened settle window.
//
// WHAT THESE SCREENS DO NOT SHOW, measured (task 4, 2026-09-25): paint()/setCell() damage.
// Upstream's renderer clears the previous region of every dirty node before repainting it
// and adds each cleared region to the frame's damage, and a node whose layout moved damages
// the whole screen; so in these sessions every cell paint() writes already lies inside
// damage the renderer has, whatever paint() reports (2.1.278's renderNodeToOutput). Quaudes
// whose paint()/setCell() report damage one column short on the right, or none at all,
// paint both sessions identically to native. So do scroll and slash-menu (task 5): a
// scroll step rewrites the whole viewport, and a closing menu or overlay leaves a cleared
// region. Damage exactness is judged at unit level, by the paint gate; these guards judge
// the cells.
//
// MEASURED 2026-09-25 (darwin-arm64, fresh quaudes of this tree): identical on native
// 2.1.278 and on native 2.1.251 (CI's pin), every frame settled -- type-edit 6 frames,
// 2035 painted cells; resize 6 frames, 2675; scroll 8 frames, 15341 (15329 on 2.1.251);
// slash-menu 7 frames, 2968. The pre-phase-5 quaude (310471c, before task 2 made
// paint()/setCell() damage native) is identical too. Two quaudes are not: one whose tty
// never turns SIGWINCH into 'resize' first differs in resize at step "back 100x40" (94
// cell-classes, the reply laid out at a stale width); one whose segment() never asks to
// grow first differs in scroll at step "boot" (256 cell-classes: the prompt's 320-column
// rules end at column 256). And scroll run without CLODE_TTY_MOUSE=1 differs at step
// "wheel up": quaude drops the wheel report by design (RECIPE.md X1, mouse tracking off).
//
// WHAT IT IS A GUARD OVER, and its floor: `examined` is the native's painted cells over
// every frame of the session. The floor is 1000: two blank sessions compare identical,
// and that must read BROKEN, not OK. A blank native frame is its own finding (ruling R8,
// in judgeSessions).
//
// Gated by test/live-frame-gate.cjs as a SESSION gate (live render, not inside the
// concurrent full suite, the PTY harness, a provider, a native claude), then by a built
// quaude of the native's version (quaudeBesideNative: CLODE_QUAUDE, else a build of this
// tree). No credentials, no tokens: the canned mock answers.
const { before, test } = require('node:test');
const assert = require('node:assert');
const { liveFrameGate, quaudeBesideNative } = require('../live-frame-gate.cjs');
const { captureSessions } = require('../frame-oracle.cjs');
const { judgeSessions, syntheticSession, cloneFrame } = require('../frame-diff.cjs');
const { defineGuard, guardTests } = require('../guard.cjs');
const { SCRIPT_DEFAULTS } = require('../tui-screen.cjs');
const { SESSIONS } = require('./sessions.cjs');

const FLOOR = 1000;
const GUARDED = []; // the sessions sessionGuard() below gave a guard, in order
const SIDES = [{ who: 'native', native: true }, { who: 'quaude' }];

let SKIP = null, WHAT = '';
const CAPS = {};
before(async () => {
  const gate = liveFrameGate({ session: true });
  if (gate.skip) { SKIP = gate.skip; return; }
  const q = quaudeBesideNative(gate.native);
  if (q.skip) { SKIP = q.skip; return; }
  WHAT = `native ${gate.native} vs quaude ${q.quaude} (${q.version}), settle defaults ${JSON.stringify(SCRIPT_DEFAULTS)}`;
  // Every session in sessions.cjs, as session-determinism captures them; the test below
  // holds each to its guard. (Not GUARDED: node:test runs this hook before the guards
  // further down have registered.)
  for (const name of Object.keys(SESSIONS)) {
    // The whole entry, exactly as session-determinism passes it.
    CAPS[name] = await captureSessions({ ...SESSIONS[name], ref: gate.native, sub: q.quaude });
  }
});

// Pure: one session, native against quaude, by the judgement every session gate shares.
function scanSession({ name, ref, sub, mustShow, what }) {
  const j = judgeSessions({ session: name, a: ref, b: sub, sides: SIDES, mustShow,
    differs: 'quaude painted the session differently from native' });
  return { ...j, note: what };
}

// The control: a stale cell in frame N+1 only, the shape a repaint that missed a cell
// leaves behind.
function staleCellControl() {
  const ref = syntheticSession(4);
  const sub = cloneFrame(ref);
  sub.frames[2].frame.cells[1][5] = { ...sub.frames[2].frame.cells[1][5], c: 'Z' };
  return { name: 'control', ref, sub, mustShow: null, what: 'synthetic control' };
}

// One guard per session, each its own defineGuard call site: guards-population counts
// call sites against the registry (MIGRATED.length), so a loop over one site would read as
// a guard that leaked in. sessionGuard() records the session as guarded and returns the spec.
function sessionGuard(name) {
  GUARDED.push(name);
  return {
    name: `session-${name}`,
    floor: FLOOR,
    read() {
      if (SKIP) return { skip: SKIP };
      return { name, ref: CAPS[name].ref, sub: CAPS[name].sub, mustShow: SESSIONS[name].mustShow,
        what: `${WHAT}, session ${name}` };
    },
    scan: scanSession,
    control: staleCellControl,
  };
}
guardTests(defineGuard(sessionGuard('type-edit')));
guardTests(defineGuard(sessionGuard('resize')));
guardTests(defineGuard(sessionGuard('scroll')));
guardTests(defineGuard(sessionGuard('slash-menu')));

// A session added to sessions.cjs is captured above, and without its guard here it would be
// judged by nothing.
test('every session in sessions.cjs has its guard here', () => {
  assert.deepStrictEqual(GUARDED, Object.keys(SESSIONS));
});

test('the control\'s finding names the session, the step and the cell', () => {
  const r = scanSession(staleCellControl());
  assert.strictEqual(r.findings.length, 1);
  assert.match(r.findings[0], /^control: quaude painted the session differently from native: first difference at step "step 2" \(frame 2 of 0-3\)/);
  assert.match(r.findings[0], /\[glyph\] col 5: A="F" .* \| B="Z"/);
});

// The judgement's other findings, native against quaude, without a capture: each is a way a
// session pair can look identical while proving nothing, or fail without differing in a cell.
test('a quaude that exited or never settled, a blank native frame, a failed capture and an unpainted scene are each findings', () => {
  const a = syntheticSession(3), b = syntheticSession(3);
  b.frames[2].settled = false;
  b.frames[2].ms = 15020;
  b.exit = { during: 'step 2', code: null, signal: 'SIGSEGV' };
  const r = scanSession({ name: 'resize', ref: a, sub: b, mustShow: 'never painted', what: 'x' });
  assert.deepStrictEqual(r.findings, [
    'resize: quaude exited during step "step 2" (code null, signal SIGSEGV)',
    'resize: step "step 2" never settled on quaude within 15020 ms -- quaude kept painting past the cap: find why, never widen the cap',
    'resize: native never painted "never painted" by its last step ("step 2"), so this session judged nothing it exists for',
  ]);
  assert.strictEqual(r.examined, 3 * 300);

  // Ruling R8: native and quaude both blank at boot compare equal; the finding says so.
  const c = syntheticSession(3), d = syntheticSession(3);
  for (const s of [c, d]) for (const row of s.frames[0].frame.cells) for (const cell of row) cell.c = '';
  assert.deepStrictEqual(scanSession({ name: 'resize', ref: c, sub: d, mustShow: null, what: 'x' }).findings, [
    'resize: native painted a BLANK frame at step "boot" -- two blank frames compare equal and judge nothing',
  ]);

  assert.deepStrictEqual(scanSession({ name: 'type-edit', ref: a, sub: null, mustShow: null, what: 'x' }), {
    examined: 0, note: 'x',
    findings: ['type-edit: a capture produced no session (native: true, quaude: false); the reason is on stderr'],
  });
});
