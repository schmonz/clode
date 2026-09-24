'use strict';
// PROOF THAT THE ORACLE CAN FAIL.
//
// The frame-differential harness (test/frame-diff.cjs + `tui-screen.cjs
// --cells`) is the instrument that will judge an implementation of
// `Bun.ant.CellSegmenter`. An instrument that cannot tell a one-cell difference
// from a correct frame is worse than no instrument, so this file does not test
// the segmenter — it tests the instrument, two ways:
//
//   1. REAL BYTES. Pairs of payloads are pushed through a real pty and a real
//      VT emulator. Each pair differs in exactly one respect, and the differ
//      must name that respect. Two of those pairs (sgr-only, link-only) render
//      IDENTICAL TEXT, so they are precisely the cases the pre-existing
//      text-line differential is blind to — and that blindness is asserted here
//      as well, so the improvement is measured and not asserted by hand.
//
//   2. DELIBERATE CORRUPTION. A real captured frame is corrupted in each of the
//      four classes, one cell at a time, and the differ must report exactly
//      that class at exactly that cell.
//
// Everything here runs against /bin/sh printing bytes. It spawns no Claude Code
// build, needs no credentials and no network.
const { test, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sandbox, REPO } = require('./e2e.cjs');
const { captureFrame } = require('./e2e-pty.cjs');
const { diff, describe: describeDiff, corrupt, rowText } = require('./frame-diff.cjs');

// tui-screen.cjs loads node-pty/@xterm from the per-platform harness dir, which
// resolves through $TMPDIR (scripts/build-scratch.cjs). The e2e sandbox env is
// deliberately "nothing from process.env leaks in", so the DRIVER would lose its
// own node_modules. The driver is the instrument, not the subject, so its
// scratch locators are threaded back in by name — the fixture under the pty is
// /bin/sh either way, so no subject sees a wider environment than before.
const DRIVER_ENV = {};
for (const k of ['TMPDIR', 'CLODE_BUILD_SCRATCH']) if (process.env[k]) DRIVER_ENV[k] = process.env[k];

function harnessMissing() {
  try {
    const { harnessDir } = require(path.join(REPO, 'scripts', 'platform-tag.cjs'));
    require.resolve(path.join(harnessDir(REPO), 'node_modules', 'node-pty'));
    return null;
  } catch { /* fall through to bare resolution */ }
  try { require.resolve('node-pty'); return null; } catch { /* */ }
  return 'PTY harness (node-pty/@xterm/headless) is not installed for this platform tag';
}

const ESC = '\x1b';
const COLS = 40, ROWS = 6;

// Payloads. Each is written verbatim by /bin/sh, so the bytes on the wire are
// exactly these. `\r\n` because the pty is in cooked-ish mode for a raw write.
const HOME = `${ESC}[2J${ESC}[H`;
const P = {
  // base: plain text, a bold run, wide CJK, and an OSC-8 hyperlink
  base: `${HOME}AB CD\r\n日本 xy\r\n${ESC}]8;;https://example.com/a\x07LINK${ESC}]8;;\x07 tail\r\n`,
  // one glyph changed, nothing else
  glyph: `${HOME}ZB CD\r\n日本 xy\r\n${ESC}]8;;https://example.com/a\x07LINK${ESC}]8;;\x07 tail\r\n`,
  // same glyphs, "CD" now bold — a stripped-text comparison sees NOTHING
  sgr: `${HOME}AB ${ESC}[1mCD${ESC}[0m\r\n日本 xy\r\n${ESC}]8;;https://example.com/a\x07LINK${ESC}]8;;\x07 tail\r\n`,
  // same glyphs and attributes, different hyperlink target — also invisible to text
  link: `${HOME}AB CD\r\n日本 xy\r\n${ESC}]8;;https://example.com/b\x07LINK${ESC}]8;;\x07 tail\r\n`,
  // the wide run replaced by narrow glyphs: the spacer columns move
  spacer: `${HOME}AB CD\r\n日ab xy\r\n${ESC}]8;;https://example.com/a\x07LINK${ESC}]8;;\x07 tail\r\n`,
  // the space between AB and CD SKIPPED with cursor-forward instead of written:
  // the cell is unwritten (""), and on a terminal it looks exactly like base
  skipped: `${HOME}AB${ESC}[1CCD\r\n日本 xy\r\n${ESC}]8;;https://example.com/a\x07LINK${ESC}]8;;\x07 tail\r\n`,
  // that space written with a BLUE BACKGROUND: visibly different from skipped
  bgspace: `${HOME}AB${ESC}[44m ${ESC}[0mCD\r\n日本 xy\r\n${ESC}]8;;https://example.com/a\x07LINK${ESC}]8;;\x07 tail\r\n`,
};

let SBX = null; let DIR = null; let SKIP = null; const FRAMES = {};
before(() => {
  SKIP = harnessMissing();
  if (SKIP) return;
  SBX = sandbox();
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-diff-'));
  const shoot = (name, payload) => {
    // The printer is NODE, not /bin/sh: windows-latest has no /bin/sh, and there
    // ConPTY's CreateProcess fails inside the driver itself (no frame at all, ci
    // run 35727111476), where POSIX node-pty would fork and paint a blank one.
    // The 20s timer outlives the capture window so the driver always ends on its
    // own timer with the full payload rendered, never on an early child exit.
    const script = path.join(DIR, `${name}.cjs`);
    fs.writeFileSync(script, `process.stdout.write(${JSON.stringify(payload)});\nsetTimeout(() => {}, 20000);\n`);
    FRAMES[name] = captureFrame(SBX, { seconds: 1.2, rows: ROWS, cols: COLS, cmd: [process.execPath, script], env: DRIVER_ENV });
  };
  for (const [name, payload] of Object.entries(P)) shoot(name, payload);
  // A second capture of the SAME payload, to show identity is reproducible and
  // not an artifact of comparing an object with itself.
  shoot('base2', P.base);
});

test('the capture observes what a text screen cannot: widths, attributes, links', (t) => {
    if (SKIP) { t.skip(SKIP); return; }
  const f = FRAMES.base;
  assert.strictEqual(f.cols, COLS);
  assert.strictEqual(f.rows, ROWS);
  assert.strictEqual(f.links, true, 'OSC-8 must be observable, or no link claim is trustworthy');
  // row 1 is the wide CJK run: cell 0 is the wide half, cell 1 its spacer.
  assert.strictEqual(f.cells[1][0].c, '日');
  assert.strictEqual(f.cells[1][0].w, 2, 'a wide grapheme must occupy a width-2 cell');
  assert.strictEqual(f.cells[1][1].w, 0, 'its trailing spacer must be a width-0 cell');
  // row 2 carries the hyperlink on exactly the four LINK glyphs.
  assert.strictEqual(f.cells[2][0].l, 'https://example.com/a');
  assert.strictEqual(f.cells[2][3].l, 'https://example.com/a');
  assert.strictEqual(f.cells[2][4].l, null, 'the space after the link must not be linked');
});

test('identical frames compare identical', (t) => {
    if (SKIP) { t.skip(SKIP); return; }
  const d = diff(FRAMES.base, FRAMES.base2);
  assert.ok(d.equal, `two captures of the same payload differ:\n${describeDiff(FRAMES.base, FRAMES.base2, d)}`);
  assert.strictEqual(d.total, 0);
  assert.strictEqual(d.linksJudged, true);
});

test('a frame that differs by one cell is reported as one glyph difference', (t) => {
    if (SKIP) { t.skip(SKIP); return; }
  const d = diff(FRAMES.base, FRAMES.glyph);
  assert.strictEqual(d.equal, false);
  assert.strictEqual(d.counts.glyph, 1, describeDiff(FRAMES.base, FRAMES.glyph, d));
  assert.strictEqual(d.counts.width, 0);
  assert.strictEqual(d.counts.sgr, 0);
  assert.strictEqual(d.counts.link, 0);
  assert.strictEqual(d.detail[0].y, 0);
  assert.strictEqual(d.detail[0].x, 0);
});

test('a frame that differs only in SGR is caught — and the text view is blind to it', (t) => {
    if (SKIP) { t.skip(SKIP); return; }
  const d = diff(FRAMES.base, FRAMES.sgr);
  assert.strictEqual(d.equal, false);
  assert.strictEqual(d.counts.sgr, 2, describeDiff(FRAMES.base, FRAMES.sgr, d));  // C and D
  assert.strictEqual(d.counts.glyph, 0, 'the glyphs are the same; only the styling moved');
  assert.strictEqual(d.counts.link, 0);
  // the instrument this replaces: identical text on every row.
  for (let y = 0; y < ROWS; y++) assert.strictEqual(rowText(FRAMES.base, y), rowText(FRAMES.sgr, y));
});

test('a frame that differs only in an OSC-8 hyperlink is caught — text view blind', (t) => {
    if (SKIP) { t.skip(SKIP); return; }
  const d = diff(FRAMES.base, FRAMES.link);
  assert.strictEqual(d.equal, false);
  assert.strictEqual(d.counts.link, 4, describeDiff(FRAMES.base, FRAMES.link, d));  // L,I,N,K
  assert.strictEqual(d.counts.glyph, 0);
  assert.strictEqual(d.counts.sgr, 0);
  for (let y = 0; y < ROWS; y++) assert.strictEqual(rowText(FRAMES.base, y), rowText(FRAMES.link, y));
});

test('a wide grapheme whose spacer moves is reported in the width class', (t) => {
    if (SKIP) { t.skip(SKIP); return; }
  const d = diff(FRAMES.base, FRAMES.spacer);
  assert.strictEqual(d.equal, false);
  assert.ok(d.counts.width >= 2, `spacer move not seen in the width class:\n${describeDiff(FRAMES.base, FRAMES.spacer, d)}`);
  // col 3 is the second wide char's spacer on one side and a real glyph on the
  // other: exactly the "a spacer landed in the wrong column" corruption class.
  assert.strictEqual(FRAMES.base.cells[1][2].w, 2);
  assert.strictEqual(FRAMES.base.cells[1][3].w, 0);
  assert.strictEqual(FRAMES.spacer.cells[1][2].w, 1);
  assert.strictEqual(FRAMES.spacer.cells[1][3].w, 1);
});

// ---- deliberate corruption of a REAL captured frame -----------------------
// One cell, one class, at a column chosen to make the class meaningful.
const CORRUPTIONS = [
  { kind: 'glyph', at: { y: 0, x: 0 }, textBlind: false },
  { kind: 'width', at: { y: 1, x: 0 }, textBlind: true },
  { kind: 'sgr', at: { y: 0, x: 3 }, textBlind: true },
  { kind: 'link', at: { y: 2, x: 1 }, textBlind: true },
];
for (const { kind, at, textBlind } of CORRUPTIONS) {
  test(`a deliberately corrupted frame is reported as exactly one ${kind} difference`, (t) => {
    if (SKIP) { t.skip(SKIP); return; }
    const bad = corrupt(FRAMES.base, kind, at);
    const d = diff(FRAMES.base, bad);
    assert.strictEqual(d.equal, false, `corrupting ${kind} at ${at.y},${at.x} was not noticed at all`);
    assert.strictEqual(d.total, 1, describeDiff(FRAMES.base, bad, d));
    assert.strictEqual(d.counts[kind], 1, `wrong class reported:\n${describeDiff(FRAMES.base, bad, d)}`);
    assert.strictEqual(d.detail[0].class, kind);
    assert.strictEqual(d.detail[0].y, at.y);
    assert.strictEqual(d.detail[0].x, at.x);
    // The classes the old text-line instrument cannot see: prove it cannot.
    const textSame = rowText(FRAMES.base, at.y) === rowText(bad, at.y);
    assert.strictEqual(textSame, textBlind,
      `expected the text view to be ${textBlind ? 'blind to' : 'able to see'} a ${kind} corruption`);
  });
}

test('a frame that could not observe hyperlinks refuses to judge them', (t) => {
    if (SKIP) { t.skip(SKIP); return; }
  const blind = JSON.parse(JSON.stringify(FRAMES.base));
  blind.links = false;
  const changed = corrupt(FRAMES.link, 'glyph', { y: 0, x: 0 });
  changed.links = false;
  const d = diff(blind, changed);
  assert.strictEqual(d.linksJudged, false);
  assert.strictEqual(d.counts.link, 0, 'a blind frame must report zero links, not a false match');
  assert.match(describeDiff(blind, changed, d), /hyperlinks NOT judged/);
  const { assertFramesEqual } = require('./frame-diff.cjs');
  assert.throws(() => assertFramesEqual(blind, blind, 'blind'), /hyperlinks could not be observed/);
});

test('an unwritten cell and a written plain space are the SAME visible cell', (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  // Precondition, or this test proves nothing: the capture really does record the
  // two differently. If the emulator ever reports the skipped cell as " ", the
  // equivalence below is untested and this must say so rather than pass.
  assert.strictEqual(FRAMES.base.cells[0][2].c, ' ', 'base writes a space at 0,2');
  assert.strictEqual(FRAMES.skipped.cells[0][2].c, '', 'skipped leaves 0,2 unwritten');
  const d = diff(FRAMES.base, FRAMES.skipped);
  assert.ok(d.equal, `native flips exactly this at its banner; it must not count:\n${describeDiff(FRAMES.base, FRAMES.skipped, d)}`);
});

test('the equivalence does not absorb a COLOURED space, a spacer, or another glyph', (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  const bg = diff(FRAMES.skipped, FRAMES.bgspace);
  assert.strictEqual(bg.total, 1, describeDiff(FRAMES.skipped, FRAMES.bgspace, bg));
  assert.strictEqual(bg.counts.sgr, 1, 'a blue-background space is visibly not an unwritten cell');
  assert.strictEqual(bg.counts.glyph, 0);
  // A width-0 spacer is "" too, and must NOT read as a space (row 1 holds 日本).
  const sp = FRAMES.base.cells[1].findIndex((c) => c.w === 0);
  assert.ok(sp > 0, 'the capture has a width-0 spacer cell to test against');
  const asSpace = corrupt(FRAMES.base, 'glyph', { y: 1, x: sp });
  asSpace.cells[1][sp].c = ' ';
  assert.strictEqual(diff(FRAMES.base, asSpace).counts.glyph, 1, 'a spacer is not a space');
  const other = corrupt(FRAMES.skipped, 'glyph', { y: 0, x: 2 });
  assert.strictEqual(diff(FRAMES.skipped, other).counts.glyph, 1, 'an unwritten cell is not an X');
});
