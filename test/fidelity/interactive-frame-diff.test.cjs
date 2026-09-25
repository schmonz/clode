'use strict';
// Interactive/PTY fidelity AT CELL LEVEL — quaude's initial TUI frame must be
// the SAME SCREEN as native Claude Code's, cell for cell: glyph, width, SGR and
// OSC-8 target.
//
// WHY A SECOND FILE BESIDE interactive-render-diff. That one compares
// ANSI-stripped text lines, and test/frame-diff.test.cjs proves it is blind to
// three of the four ways a screen model corrupts a frame (a moved wide-glyph
// spacer, an SGR-only change, an OSC-8-only change). This is the instrument that
// judged Bun.ant.CellSegmenter (709 differing cell-classes -> 0 on 2.1.278), and
// until now it ran only when a human remembered to run test/frame-oracle.cjs.
// A ratchet that needs remembering is not a ratchet.
//
// EXACT EQUALITY, NO TOLERANCE. Measured 2026-09-24 on darwin-arm64 at 100x40:
// native-vs-native is identical apart from ONE unwritten-vs-space cell that the
// renderer's own frame diff flips run to run; frame-diff.cjs now treats those
// as the same visible cell (proven both ways in frame-diff.test.cjs), and with
// that native-vs-native, 2.1.251-vs-native and 2.1.278-vs-native are all 0.
//
// WHAT IT IS A GUARD OVER, and its floor. `examined` is the number of visibly
// non-blank cells in the REFERENCE frame. Native paints 353 at 100x40; the floor
// is 200, so a reference that painted nothing (or half a banner) is BROKEN, not
// OK — otherwise a blank native against a blank quaude would compare IDENTICAL,
// which is exactly how quaude-from-2.1.278 painted nothing for a day while the
// build smoke said PONG.
//
// THREE SCENES, three guards. `tui-initial-frame-cells` is the welcome screen as it
// boots. `tui-prompt-wide-glyphs` (CellSegmenter phase 3, 2026-09-25) types
// `U+4E2D U+6587 SP U+1F44D U+1F3FD SP U+1F1FA U+1F1F8 SP e U+0301 SP U+2764 U+FE0F`
// into the prompt, NO Enter, well after boot (typed at t=0 it races the TUI's
// startup), so both sides paint the prompt row with wide CJK, an emoji with a skin
// tone, a flag, a base + combining mark and an emoji with VS16 — the clusters and
// widths phase 3 exists for, which the welcome screen contains none of. Measured:
// native-vs-native identical; the pre-phase-3 quaude (per-code-point clusters, all
// width 1) differs from native on that row. The scene's reference must SHOW the
// typed glyphs, or the guard says so instead of comparing two frames without them.
// `tui-reply-hyperlinks` (CellSegmenter phase 4, 2026-09-25) types a turn and the canned
// mock answers it with a markdown link and a bare URL, which the TUI paints as OSC 8
// hyperlinks — the cells whose link a segmenter that interned none paints as plain text.
// Upstream paints hyperlinks only where it detects support, and under this harness
// (TERM=xterm-256color, TERM_PROGRAM removed) it detects none: measured, native then
// paints `the docs (https://example.com/docs)` as plain text. So both sides get
// FORCE_HYPERLINK=1, the switch upstream's own detection reads first (supports-hyperlinks),
// and showTurnDuration off, because the line it paints after a turn carries the wall-clock
// time ("done 10:37 AM"), which differs whenever the two captures straddle a minute. The
// reference must PAINT both links, or the guard says so instead of comparing two frames
// with none. Measured: native-vs-native identical; the pre-phase-4 quaude differs on the
// reply row (link 32, sgr 32: native underlines what it links).
//
// WHAT IT DOES NOT COVER, deliberately named: no resize, no scroll, no damage
// under partial repaint (phase 5 of the CellSegmenter work).
//
// THE REFERENCE IS A RUNNABLE NATIVE CLAUDE, NOT THE BUILD PROVIDER.
// CLODE_NATIVE_CLAUDE, else `claude` on PATH (what CI's `npm i -g` installs), and
// it must report the same --version as the quaude or the gate SKIPS naming both.
// The provider is the wrong reference and this file proved it on its first Linux
// run (2026-09-24, node:24.21.0-bookworm mirroring linux-x64-pty): CI hands the
// suite `provider-min`, a stripped repack for BUILDING that is not even
// executable, and the gate went BROKEN — "examined 33, floor is 200" — because
// the reference frame was the one line `execvp(3) failed.: Permission denied`.
// That is the floor doing its job: an OK there would have been a lie.
//
// Same gating as interactive-render-diff: spawns the real bundle, so darwin is
// opt-in (CLODE_LIVE_RENDER=1, Keychain); every other platform runs it by
// default. CI runs it in the linux-x64-pty job against the pinned provider.
const { before, test } = require('node:test');
const assert = require('node:assert');
const { liveFrameGate, quaudeBesideNative } = require('../live-frame-gate.cjs');
const { captureFrames } = require('../frame-oracle.cjs');
const { diff, describe, corrupt, cloneFrame, nonBlank, frameShows } = require('../frame-diff.cjs');
const { defineGuard, guardTests } = require('../guard.cjs');

const ROWS = 40, COLS = 100;
// Long enough for the late-arriving status line: at 12s the "● high · /effort"
// row was sometimes still absent from one side (measured 2026-09-22), which
// read as 16 phantom glyph+sgr differences.
const SECONDS = 20;
const FLOOR = 200;
// The typed scene, built from CODE POINTS (an editor normalises a typed `e U+0301` into
// the precomposed U+00E9, which is not a combining mark — that happened to the plan's own
// literal). Typed at 6 s: native and quaude both paint their prompt within ~2 s here.
const TYPED_CPS = [0x4e2d, 0x6587, 0x20, 0x1f44d, 0x1f3fd, 0x20, 0x1f1fa, 0x1f1f8, 0x20, 0x65, 0x301, 0x20, 0x2764, 0xfe0f];
const TYPED = String.fromCodePoint(...TYPED_CPS);
const TYPE_AT = 6;
// The link scene: a turn (`hi`, then Enter a moment later, as a person types), answered by
// the mock with one markdown link and one bare URL.
const LINKS = ['https://example.com/docs', 'https://example.com/bare'];
const LINK_REPLY = `See [the docs](${LINKS[0]}) and ${LINKS[1]} now.`;
const LINK_SHOWN = `See the docs and ${LINKS[1]} now.`;
const LINK_SCENE = { mockText: LINK_REPLY, env: { FORCE_HYPERLINK: '1' }, settings: { showTurnDuration: false },
  thenHex: [`${Buffer.from('hi', 'utf8').toString('hex')}@${TYPE_AT}`, `0d@${TYPE_AT + 1.2}`] };

let SKIP = null, FRAMES = null, TYPED_FRAMES = null, LINK_FRAMES = null, WHAT = '', TYPED_WHAT = '', LINK_WHAT = '';
before(async () => {
  const gate = liveFrameGate();
  if (gate.skip) { SKIP = gate.skip; return; }
  const ref = gate.native;
  // The quaude, only when it is the native's version (test/live-frame-gate.cjs).
  const q = quaudeBesideNative(ref);
  if (q.skip) { SKIP = q.skip; return; }
  const sub = q.quaude;
  WHAT = `native ${ref} (${q.version}) vs quaude ${sub}, ${COLS}x${ROWS}, ${SECONDS}s`;
  FRAMES = await captureFrames({ ref, sub, seconds: SECONDS, rows: ROWS, cols: COLS });
  // A capture that produced no frame is a harness failure, and it must SAY so
  // rather than skip quietly: the whole point is that this runs.
  if (!FRAMES.ref || !FRAMES.sub) {
    throw new Error(`frame capture failed (${WHAT}): ref=${!!FRAMES.ref} sub=${!!FRAMES.sub}; see stderr`);
  }
  TYPED_WHAT = `${WHAT}, prompt typed at ${TYPE_AT}s`;
  TYPED_FRAMES = await captureFrames({ ref, sub, seconds: SECONDS, rows: ROWS, cols: COLS,
    thenHex: [`${Buffer.from(TYPED, 'utf8').toString('hex')}@${TYPE_AT}`] });
  if (!TYPED_FRAMES.ref || !TYPED_FRAMES.sub) {
    throw new Error(`frame capture failed (${TYPED_WHAT}): ref=${!!TYPED_FRAMES.ref} sub=${!!TYPED_FRAMES.sub}; see stderr`);
  }
  LINK_WHAT = `${WHAT}, a turn typed at ${TYPE_AT}s answered with two links, FORCE_HYPERLINK=1`;
  LINK_FRAMES = await captureFrames({ ref, sub, seconds: SECONDS, rows: ROWS, cols: COLS, ...LINK_SCENE });
  if (!LINK_FRAMES.ref || !LINK_FRAMES.sub) {
    throw new Error(`frame capture failed (${LINK_WHAT}): ref=${!!LINK_FRAMES.ref} sub=${!!LINK_FRAMES.sub}; see stderr`);
  }
});

// Every guard judges the same way: exact equality, cell for cell, and no claim about
// hyperlinks from a capture that could not see them. `mustShow` (the typed and link scenes)
// is text the REFERENCE must paint on some row, and `mustLink` targets it must paint at
// least one cell linked to, or that scene compared two frames that never had what it exists
// for — reported as a finding, never as a pass.
function scanFrames({ ref, sub, what, mustShow, mustLink }) {
  const d = diff(ref, sub, { maxDetail: 30 });
  const findings = [];
  if (mustShow && !frameShows(ref, mustShow)) {
    findings.push(`the reference never painted the typed text ${JSON.stringify(mustShow)}, so this scene judged nothing wide`);
  }
  for (const uri of mustLink || []) {
    if (!ref.cells.some((row) => row.some((c) => c && c.l === uri))) {
      findings.push(`the reference painted no cell linked to ${uri}, so this scene judged no hyperlink`);
    }
  }
  // Refuse to claim link equality from a capture that could not see links.
  if (!d.linksJudged) findings.push('hyperlinks were NOT observable in one of the frames, so equality cannot be claimed');
  if (!d.equal) findings.push(describe(ref, sub, d));
  return { examined: nonBlank(ref), findings, note: what };
}

// A synthetic control that is a real-shaped frame: FLOOR+50 painted cells, so
// the control clears the floor and its finding is the diff, not the floor.
function controlFrame() {
  const cells = [];
  let painted = 0;
  for (let y = 0; y < ROWS; y++) {
    const row = [];
    for (let x = 0; x < COLS; x++) {
      const on = painted < FLOOR + 50 && x < 60;
      if (on) painted++;
      row.push({ c: on ? String.fromCharCode(0x41 + (x % 26)) : '', w: 1, f: '0:-1', b: '0:-1', a: 0, l: null });
    }
    cells.push(row);
  }
  return { format: 1, cols: COLS, rows: ROWS, links: true, cells };
}

guardTests(defineGuard({
  name: 'tui-initial-frame-cells',
  floor: FLOOR,
  read() {
    if (SKIP) return { skip: SKIP };
    return { ref: FRAMES.ref, sub: FRAMES.sub, what: WHAT };
  },
  scan: scanFrames,
  // The real regression, spelled as a frame: one glyph in the middle of painted
  // content differs. Using corrupt() — the same helper frame-diff.test.cjs
  // proves produces exactly one glyph difference against real pty captures.
  control() {
    const ref = controlFrame();
    return { ref, sub: corrupt(cloneFrame(ref), 'glyph', { y: 1, x: 10 }), what: 'synthetic control' };
  },
}));

// The typed scene: the prompt row carries wide CJK, emoji sequences, a flag and a
// combining mark (see the header). Same shape as the gate above; the reference must also
// show the typed text. The control is the phase-3 regression itself, spelled as a frame:
// the first CJK glyph painted narrow, its spacer column taken by the next glyph.
guardTests(defineGuard({
  name: 'tui-prompt-wide-glyphs',
  floor: FLOOR,
  read() {
    if (SKIP) return { skip: SKIP };
    return { ref: TYPED_FRAMES.ref, sub: TYPED_FRAMES.sub, what: TYPED_WHAT, mustShow: String.fromCodePoint(0x4e2d, 0x6587) };
  },
  scan: scanFrames,
  control() {
    const ref = controlFrame();
    ref.cells[2][0] = { c: String.fromCodePoint(0x4e2d), w: 2, f: '0:-1', b: '0:-1', a: 0, l: null };
    ref.cells[2][1] = { c: '', w: 0, f: '0:-1', b: '0:-1', a: 0, l: null };
    ref.cells[2][2] = { c: String.fromCodePoint(0x6587), w: 2, f: '0:-1', b: '0:-1', a: 0, l: null };
    ref.cells[2][3] = { c: '', w: 0, f: '0:-1', b: '0:-1', a: 0, l: null };
    const sub = cloneFrame(ref);
    sub.cells[2][0] = { ...sub.cells[2][0], w: 1 };
    sub.cells[2][1] = { ...sub.cells[2][2], w: 1 };
    return { ref, sub, what: 'synthetic control', mustShow: String.fromCodePoint(0x4e2d) };
  },
}));

// The link scene: a turn answered with a markdown link and a bare URL (see the header). The
// reference must show the reply and paint both links. The control is the phase-4 regression
// itself, spelled as a frame: the cells a link covers painted with no link.
guardTests(defineGuard({
  name: 'tui-reply-hyperlinks',
  floor: FLOOR,
  read() {
    if (SKIP) return { skip: SKIP };
    return { ref: LINK_FRAMES.ref, sub: LINK_FRAMES.sub, what: LINK_WHAT, mustShow: LINK_SHOWN, mustLink: LINKS };
  },
  scan: scanFrames,
  control() {
    const ref = controlFrame();
    for (let x = 0; x < 8; x++) ref.cells[3][x] = { ...ref.cells[3][x], l: LINKS[0] };
    const sub = cloneFrame(ref);
    for (let x = 0; x < 8; x++) sub.cells[3][x] = { ...sub.cells[3][x], l: null };
    return { ref, sub, what: 'synthetic control', mustLink: [LINKS[0]] };
  },
}));

// The scene's own precondition, without a capture: a reference that paints none of the links
// the scene exists for (upstream stopped honouring FORCE_HYPERLINK, say) is a finding, never
// two link-free frames compared equal.
test('a link scene whose reference paints no link is a finding, not a pass', () => {
  const ref = controlFrame();
  const r = scanFrames({ ref, sub: cloneFrame(ref), what: 'x', mustLink: LINKS });
  assert.deepStrictEqual(r.findings, LINKS.map((u) => `the reference painted no cell linked to ${u}, so this scene judged no hyperlink`));
  ref.cells[0][0] = { ...ref.cells[0][0], l: LINKS[0] };
  ref.cells[0][1] = { ...ref.cells[0][1], l: LINKS[1] };
  assert.deepStrictEqual(scanFrames({ ref, sub: cloneFrame(ref), what: 'x', mustLink: LINKS }).findings, []);
});
