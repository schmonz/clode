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
const { diff, describe: describeDiff, corrupt, rowText, cloneFrame } = require('./frame-diff.cjs');

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

// Whether `cell` is the SAME visible cell as `ref` in EVERY field: glyph,
// width, both colour slots, attribute bits, and hyperlink. Judges a
// ConPTY-materialized cursor-skipped cell against a MEASURED reference cell —
// never against a hard-coded encoding. A previous version compared against
// the literal 'd:0', which is test/frame-diff.cjs's cellAt() sentinel for a
// cell that doesn't exist in the frame at all — not the encoding a real
// capture uses for default colours. CI run 36084579962 measured
// {"f":"0:-1","b":"0:-1"} on windows-latest (commit 2b4b48d) and that
// predicate rejected it, failing the whole test.
function isSameCell(cell, ref) {
  return cell.c === ref.c && cell.w === ref.w && cell.f === ref.f
    && cell.b === ref.b && cell.a === ref.a && cell.l === ref.l;
}

test('isSameCell judges a default-attribute space against a MEASURED reference, not a hard-coded encoding', () => {
  const ref = { c: ' ', w: 1, f: '0:-1', b: '0:-1', a: 0, l: null }; // shape of the CI-measured cell
  // Accepted: identical to the reference in every field.
  assert.strictEqual(isSameCell({ c: ' ', w: 1, f: '0:-1', b: '0:-1', a: 0, l: null }, ref), true);
  // Rejected: a different background is a real difference.
  assert.strictEqual(isSameCell({ c: ' ', w: 1, f: '0:-1', b: '1:4', a: 0, l: null }, ref), false);
  // Rejected: a hyperlink is a real difference.
  assert.strictEqual(isSameCell({ c: ' ', w: 1, f: '0:-1', b: '0:-1', a: 0, l: 'https://example.com' }, ref), false);
  // Rejected: an UNWRITTEN cell ("") is a different question entirely (the
  // diff()-based equivalence handles that one, POSIX-only) — isSameCell must
  // never absorb it.
  assert.strictEqual(isSameCell({ c: '', w: 1, f: '0:-1', b: '0:-1', a: 0, l: null }, ref), false);

  // Proves the fix, not just the helper: the OLD predicate compared against
  // the hard-coded sentinel 'd:0' instead of a measured reference, so it
  // rejects the exact cell CI measured — that rejection is the bug this test
  // exists to keep fixed. RED against the old logic, GREEN against the new.
  const oldPredicate = (c) => c.c === ' ' && c.w === 1
    && c.f === 'd:0' && c.b === 'd:0' && c.a === 0;
  assert.strictEqual(oldPredicate(ref), false,
    'RED: the old hard-coded-encoding predicate rejects a real default-attribute space');
  assert.strictEqual(isSameCell(ref, ref), true,
    'GREEN: the new measured-reference predicate accepts the same cell');
});

test('an unwritten cell and a written plain space are the SAME visible cell', (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  // Precondition, or this test proves nothing: the capture really does record a
  // space at 0,2 in the base payload. Whether the SKIPPED payload's 0,2 is truly
  // unwritten depends on the pty layer, not on us — decide by the MEASURED cell,
  // never by process.platform.
  assert.strictEqual(FRAMES.base.cells[0][2].c, ' ', 'base writes a space at 0,2');
  const skipped = FRAMES.skipped.cells[0][2];
  if (skipped.c === '') {
    // POSIX (node-pty + xterm/headless, every leg observed so far): the cursor-
    // forward really does leave the cell unwritten. This is the real proof: a
    // capture-based comparison of the two payloads must report them equal.
    const d = diff(FRAMES.base, FRAMES.skipped);
    assert.ok(d.equal, `native flips exactly this at its banner; it must not count:\n${describeDiff(FRAMES.base, FRAMES.skipped, d)}`);
    return;
  }
  // ConPTY (windows-latest, CI run 36057766387 and 36084579962): it re-renders
  // the screen itself and MATERIALIZES the cursor-skipped cell as a written
  // space with default attributes before the emulator ever sees the frame, so
  // the capture cannot contain an unwritten cell here at all. Judged against
  // the base capture's REAL space at the same coordinate — a MEASURED
  // reference, not an assumed encoding — because the encoding real captures
  // use for default colours ("0:-1") is not the same string cellAt()'s
  // missing-cell sentinel ('d:0') uses.
  const ref = FRAMES.base.cells[0][2];
  const isDefaultSpace = isSameCell(skipped, ref);
  assert.ok(isDefaultSpace,
    `skipped cell 0,2 is neither unwritten nor the same as the base capture's real space at `
    + `0,2 (platform=${process.platform}) — something else happened: measured `
    + `${JSON.stringify(skipped)} vs reference ${JSON.stringify(ref)}`);
  t.skip(`ConPTY (platform=${process.platform}) materializes cursor-skipped cells as written `
    + 'spaces; the capture cannot contain an unwritten cell, so the capture-based proof is not '
    + 'possible here; the equivalence itself is proven by the synthetic test. This branch was '
    + `written assuming ConPTY-only — the platform named above is a deferred review note: if it `
    + 'is ever not "win32", a POSIX terminal started materializing skipped cells too, and that '
    + 'is worth a second look, not a silent skip.');
});

test('SYNTHETIC: the equivalence holds without a pty, on every platform', () => {
  // No `before()` capture, no SKIP gate: this proves the same equivalence the
  // test above proves from a real capture on POSIX, but from a frame literal in
  // the frame-diff format, so it runs even where no pty harness is installed
  // (and on ConPTY, where the capture itself can never show the unwritten side).
  const base = {
    format: 'clode-frame-v1', cols: 3, rows: 1, links: true,
    cells: [[
      { c: 'A', w: 1, f: 'd:0', b: 'd:0', a: 0, l: null },
      { c: '', w: 1, f: 'd:0', b: 'd:0', a: 0, l: null },
      { c: 'B', w: 1, f: 'd:0', b: 'd:0', a: 0, l: null },
    ]],
  };
  const unwritten = cloneFrame(base);
  const written = cloneFrame(base);
  written.cells[0][1].c = ' ';
  const d = diff(unwritten, written);
  assert.ok(d.equal, `unwritten "" and a written " " with identical attributes must compare equal:\n${describeDiff(unwritten, written, d)}`);
  assert.strictEqual(d.counts.glyph, 0);
  assert.strictEqual(d.total, 0);

  // Negative: a coloured space is NOT absorbed by the equivalence — it is an sgr
  // difference, same as the real-capture "does not absorb" test below proves.
  const coloured = cloneFrame(unwritten);
  coloured.cells[0][1] = { c: ' ', w: 1, f: 'd:0', b: '2:12', a: 0, l: null };
  const bg = diff(unwritten, coloured);
  assert.strictEqual(bg.equal, false);
  assert.strictEqual(bg.counts.sgr, 1);
  assert.strictEqual(bg.counts.glyph, 0);
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

// TYPED INPUT IS BYTES. tui-screen's --send-hex/--then-hex carry the bytes a scene types, and
// the child must receive exactly those: the wide-glyph scene in
// test/fidelity/interactive-frame-diff.test.cjs types UTF-8. Until 2026-09-25 they were
// decoded as latin1 and the pty write re-encoded that string as UTF-8, so every byte >= 0x80
// arrived as two (E4 -> C3 A4) — invisible to every ASCII fixture, mojibake for the first
// non-ASCII one. Pure: what node-pty puts on the wire for a string is its UTF-8 encoding.
test('typed hex reaches the pty as exactly its bytes, UTF-8 or not', () => {
  const { hexPayload } = require('./tui-screen.cjs');
  const onWire = (p) => (Buffer.isBuffer(p) ? p : Buffer.from(p, 'utf8'));
  const wide = Buffer.from(String.fromCodePoint(0x4e2d, 0x6587, 0x20, 0x1f44d, 0x1f3fd, 0x20, 0xe9), 'utf8').toString('hex');
  for (const hex of ['0d', '2f646f63746f72', wide, 'e4', '9b316d', 'ff00']) {
    assert.strictEqual(onWire(hexPayload(hex)).toString('hex'), hex, `payload ${hex}`);
  }
  assert.strictEqual(typeof hexPayload('0d'), 'string', 'an ASCII fixture is written as the string it always was');
});

// ---- sessions: a frame per scripted step (CellSegmenter phase 5) ------------------
// Pure, synthetic, every platform. The session gates compare two frame SEQUENCES step by
// step, so these prove the sequence comparison can fail in each way a sequence can differ:
// a cell in one step, a step missing, a step that ran a different script, a step that never
// settled.
const { diffSessions, describeSessions, nonBlank, frameShows, syntheticSession } = require('./frame-diff.cjs');

test('syntheticSession: n settled, labelled frames of a painted screen, independent copies', () => {
  const s = syntheticSession(4);
  assert.strictEqual(s.format, 'clode-frames-v1');
  assert.deepStrictEqual(s.frames.map((f) => [f.label, f.settled]), [['boot', true], ['step 1', true], ['step 2', true], ['step 3', true]]);
  for (const f of s.frames) assert.ok(nonBlank(f.frame) >= 250, `a synthetic frame is painted (${nonBlank(f.frame)})`);
  s.frames[2].frame.cells[0][0].c = 'Q';
  assert.notStrictEqual(s.frames[1].frame.cells[0][0].c, 'Q', 'planting in one frame must not touch another');
});

test('nonBlank counts visible glyphs only; frameShows finds text on any row, spacers skipped', () => {
  const s = syntheticSession(1);
  const f = s.frames[0].frame;
  const blank = cloneFrame(f);
  for (const row of blank.cells) for (const c of row) c.c = ' ';
  assert.strictEqual(nonBlank(blank), 0, 'written spaces are not painted content');
  blank.cells[3][0] = { ...blank.cells[3][0], c: String.fromCodePoint(0x4e2d), w: 2 };
  blank.cells[3][1] = { ...blank.cells[3][1], c: '', w: 0 };
  blank.cells[3][2] = { ...blank.cells[3][2], c: 'e' + String.fromCodePoint(0x301) };
  assert.strictEqual(nonBlank(blank), 2, 'a wide glyph is one cell of content; its spacer is none');
  assert.strictEqual(frameShows(blank, String.fromCodePoint(0x4e2d) + 'e' + String.fromCodePoint(0x301)), true);
  assert.strictEqual(frameShows(blank, 'nowhere'), false);
});

test('diffSessions: two identical sequences are equal, every step judged', () => {
  const a = syntheticSession(4), b = syntheticSession(4);
  const d = diffSessions(a, b);
  assert.strictEqual(d.equal, true);
  assert.strictEqual(d.firstDiff, null);
  assert.deepStrictEqual(d.steps.map((s) => [s.label, s.d.equal]), [['boot', true], ['step 1', true], ['step 2', true], ['step 3', true]]);
  assert.deepStrictEqual(d.unsettled, []);
  assert.strictEqual(d.linksJudged, true);
});

test('diffSessions: one planted cell in frame 2 is the first difference, named by its step', () => {
  const a = syntheticSession(4), b = syntheticSession(4);
  b.frames[2].frame = corrupt(b.frames[2].frame, 'glyph', { y: 1, x: 5 });
  const d = diffSessions(a, b);
  assert.strictEqual(d.equal, false);
  assert.strictEqual(d.firstDiff.label, 'step 2');
  assert.strictEqual(d.firstDiff.d.counts.glyph, 1);
  assert.deepStrictEqual([d.firstDiff.d.detail[0].y, d.firstDiff.d.detail[0].x], [1, 5]);
  assert.deepStrictEqual(d.steps.map((s) => s.d.equal), [true, true, false, true], 'the frames around it still compare equal');
  const text = describeSessions(a, b, d);
  assert.match(text, /first difference at step "step 2" \(frame 2 of 0-3\)/);
  assert.match(text, /\[glyph\] col 5/);
});

test('diffSessions: a missing frame is a difference, and so is a step that ran something else', () => {
  const a = syntheticSession(4), b = syntheticSession(3);
  const d = diffSessions(a, b);
  assert.strictEqual(d.equal, false);
  assert.strictEqual(d.firstDiff.label, 'step 3');
  assert.strictEqual(d.firstDiff.missing, 'B');
  assert.match(describeSessions(a, b, d), /step "step 3" \(frame 3 of 0-3\): B has no frame \(A has 4 frames, B has 3\)/);
  const c = syntheticSession(4);
  c.frames[1].label = 'typed something else';
  const e = diffSessions(a, c);
  assert.strictEqual(e.equal, false, 'identical screens under different step labels are two different scripts');
  assert.strictEqual(e.firstDiff.label, 'step 1');
  assert.match(describeSessions(a, c, e), /A ran "step 1", B ran "typed something else"/);
});

test('diffSessions: unsettled steps are listed, on either side, without deciding equality', () => {
  const a = syntheticSession(4), b = syntheticSession(4);
  a.frames[1].settled = false;
  b.frames[3].settled = false;
  const d = diffSessions(a, b);
  assert.deepStrictEqual(d.unsettled, ['step 1', 'step 3']);
  assert.strictEqual(d.equal, true, 'settledness is the caller\'s finding; the frames themselves are the same');
});

test('diffSessions: a frame that could not observe links makes the sequence refuse link claims', () => {
  const a = syntheticSession(2), b = syntheticSession(2);
  b.frames[1].frame.links = false;
  assert.strictEqual(diffSessions(a, b).linksJudged, false);
});
