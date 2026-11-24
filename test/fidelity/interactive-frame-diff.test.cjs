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
// FOUR SCENES, four guards. `tui-initial-frame-cells` is the welcome screen as it
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
// `tui-reply-wraps` (Bun.wrapAnsi = native, 2026-09-26) is a turn answered with a markdown
// table whose two cells the TUI wraps through Bun.wrapAnsi: one holding literal tabs, one
// holding an italic run with bold inside it that crosses the wrap point. The TABLE is where
// the wrap helper sees what native and npm wrap-ansi disagree on, measured with a
// Bun.wrapAnsi-logging preload in native: a paragraph or list item reaches Bun.wrapAnsi as
// plain text and is styled after wrapping, so bold holding inline code across a wrap paints
// identically there; a table cell reaches it with its SGR inside. Native keeps a tab as
// near zero-width where npm expands it to tab stops, so the cells break at different words;
// and at the wrap native closes only the inner bold, so the outer italic runs on over the
// cell's padding and border. Bold holding inline code (a colour) inside a cell also crosses
// the wrap differently in the helper's output yet paints identically, so the scene holds
// italic around bold. The reference must paint the reply's last words. Measured: native vs
// native identical; the quaude of npm wrap-ansi differs on the table rows (glyph 85: the
// tab row; sgr 13: the italic run on the border and padding).
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
// EVERY FRAME IS A SETTLED ONE, NOT ONE READ AT A CLOCK TIME (2026-11-24). Each scene is a
// script (tui-screen.cjs --script, via frame-oracle's captureFrames): boot, waited out by the
// measured boot window, then the scene's keystrokes, each held until its answer is on screen
// and output has then settled; the frame compared is the last step's. It used to be the screen
// at a fixed 20 s, keys at 6 s, a guess a loaded box outruns: frame-diff.test.cjs took a BLANK
// frame that way in a full-suite run at 91e96b5 (test/fixed-window-captures.test.cjs). The boot
// window also outlasts the late "● high · /effort" status row, which at a fixed 12 s was
// sometimes absent from one side (measured 2026-09-22: 16 phantom glyph+sgr differences).
const FLOOR = 200;
const hex = (text) => Buffer.from(text, 'utf8').toString('hex');
// The typed scene, built from CODE POINTS (an editor normalises a typed `e U+0301` into
// the precomposed U+00E9, which is not a combining mark — that happened to the plan's own
// literal). Typed once boot has settled; its frame is held until the wide pair is on screen.
const TYPED_CPS = [0x4e2d, 0x6587, 0x20, 0x1f44d, 0x1f3fd, 0x20, 0x1f1fa, 0x1f1f8, 0x20, 0x65, 0x301, 0x20, 0x2764, 0xfe0f];
const TYPED = String.fromCodePoint(...TYPED_CPS);
const TYPED_SHOWN = String.fromCodePoint(0x4e2d, 0x6587);
const TYPED_SCENE = { script: [{ label: 'typed', send: hex(TYPED), until: TYPED_SHOWN }] };
// A turn: `hi` (held until it is in the prompt), then Enter, held until the reply's `shown`
// text is on screen and output has settled.
const turn = (shown) => [{ label: 'typed', send: hex('hi'), until: 'hi' }, { label: 'reply', send: '0d', until: shown }];
// The link scene: a turn answered by the mock with one markdown link and one bare URL.
const LINKS = ['https://example.com/docs', 'https://example.com/bare'];
const LINK_REPLY = `See [the docs](${LINKS[0]}) and ${LINKS[1]} now.`;
const LINK_SHOWN = `See the docs and ${LINKS[1]} now.`;
const LINK_SCENE = { mockText: LINK_REPLY, env: { FORCE_HYPERLINK: '1' }, settings: { showTurnDuration: false },
  script: turn(LINK_SHOWN) };
// WRAP SCENE: a reply the wrap helper breaks across lines, holding what native's
// Bun.wrapAnsi and npm wrap-ansi disagree on (recon 2026-09-26): literal tabs inside
// wrapped text, and an italic run holding bold that crosses a wrap point. Both in a table,
// the one place the helper sees the styles (see the header); each cell long enough to wrap
// at 100 columns, the tabbed row first so the reply ends on the italic row's intact words.
const WRAP_REPLY = [
  '| Name | Description |',
  '| --- | --- |',
  '| beta | a tab\tthen another tab\tand more words so that this cell wraps past its column edge here |',
  '| alpha | plain words that push the bold run toward the wrap: *italic holding **bold words that cross the wrap point of this cell** and more italic* done |',
].join('\n');
const WRAP_SHOWN = 'and more italic done';
const WRAP_SCENE = { mockText: WRAP_REPLY, settings: { showTurnDuration: false }, script: turn(WRAP_SHOWN) };

let SKIP = null, FRAMES = null, TYPED_FRAMES = null, LINK_FRAMES = null, WRAP_FRAMES = null;
let WHAT = '', TYPED_WHAT = '', LINK_WHAT = '', WRAP_WHAT = '';
before(async () => {
  const gate = liveFrameGate();
  if (gate.skip) { SKIP = gate.skip; return; }
  const ref = gate.native;
  // The quaude, only when it is the native's version (test/live-frame-gate.cjs).
  const q = quaudeBesideNative(ref);
  if (q.skip) { SKIP = q.skip; return; }
  const sub = q.quaude;
  WHAT = `native ${ref} (${q.version}) vs quaude ${sub}, ${COLS}x${ROWS}, each frame settled`;
  // A capture that produced no frame, or a frame taken at its step's cap rather than settled, is
  // a harness failure, and it must SAY so rather than skip quietly: the whole point is that this runs.
  const shoot = async (what, scene) => {
    const f = await captureFrames({ ref, sub, rows: ROWS, cols: COLS, ...scene });
    if (!f.ref || !f.sub) throw new Error(`frame capture failed (${what}): ref=${!!f.ref} sub=${!!f.sub}; see stderr`);
    if (!f.settled.ref || !f.settled.sub) {
      throw new Error(`a frame never settled (${what}): ref=${f.settled.ref} sub=${f.settled.sub}; it was taken at its step's cap`);
    }
    return f;
  };
  FRAMES = await shoot(WHAT, {});
  TYPED_WHAT = `${WHAT}, prompt typed once boot settled`;
  TYPED_FRAMES = await shoot(TYPED_WHAT, TYPED_SCENE);
  LINK_WHAT = `${WHAT}, a turn answered with two links, FORCE_HYPERLINK=1`;
  LINK_FRAMES = await shoot(LINK_WHAT, LINK_SCENE);
  WRAP_WHAT = `${WHAT}, a turn answered with a table the wrap helper breaks`;
  WRAP_FRAMES = await shoot(WRAP_WHAT, WRAP_SCENE);
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
    return { ref: TYPED_FRAMES.ref, sub: TYPED_FRAMES.sub, what: TYPED_WHAT, mustShow: TYPED_SHOWN };
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

// The wrap scene: a turn answered with a table whose cells the wrap helper breaks (see the
// header). The reference must show the reply's last words. The control is the wrap
// regression in miniature: one cell of the wrapped run painted in the wrong place.
guardTests(defineGuard({
  name: 'tui-reply-wraps',
  floor: FLOOR,
  read() {
    if (SKIP) return { skip: SKIP };
    return { ref: WRAP_FRAMES.ref, sub: WRAP_FRAMES.sub, what: WRAP_WHAT, mustShow: WRAP_SHOWN };
  },
  scan: scanFrames,
  control() {
    const ref = controlFrame(), sub = cloneFrame(ref);
    sub.cells[3][10] = { ...sub.cells[3][10], c: 'Z' };
    return { ref, sub, what: 'synthetic control', mustShow: null };
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
