'use strict';
// Frame-differential oracle for the screen model (Bun.ant.CellSegmenter).
//
// WHY THIS EXISTS. The pre-existing fidelity differential
// (test/fidelity/interactive-render-diff.test.cjs) compares ANSI-STRIPPED TEXT
// LINES. That instrument cannot see any of the four ways a cell segmenter goes
// wrong while the words on screen stay identical:
//
//   - one cell carries the wrong grapheme         (glyph)
//   - a wide grapheme's spacer sits in the wrong  (width)
//     column, so everything after it is off by one
//   - the same glyphs carry different SGR         (sgr)
//   - the same glyphs carry a different OSC-8 URI (link)
//
// So the segmenter cannot be judged by it: a segmenter can corrupt the screen in
// all four ways and still pass. This module compares FRAMES — every cell's
// glyph, emulator-assigned width, SGR attributes and hyperlink target — and
// says which of those four classes each difference belongs to.
//
// Frames come from `tui-screen.cjs --cells` (see test/e2e-pty.cjs captureFrame).
//
// HONESTY RULES, because in this repo the measuring device has been wrong more
// often than the product:
//   - a frame that could not observe hyperlinks (`links:false`) makes the
//     comparison REFUSE to report `link` equality: `diff()` returns
//     `linksJudged:false`, and `assertFramesEqual` fails rather than passing
//     quietly, unless the caller opts out.
//   - comparing frames of different geometry is a `geometry` difference, not
//     a crash and not a pass.
//   - `equal` is computed from the classified differences, so there is no way
//     for a difference to be counted and still report equal.

const CLASSES = ['glyph', 'width', 'sgr', 'link'];

function cellAt(frame, y, x) {
  const row = frame.cells[y];
  const c = row && row[x];
  return c || { c: '', w: 1, f: 'd:0', b: 'd:0', a: 0, l: null };
}

// Classify one cell pair. Returns the list of classes it differs in ([] = same).
// A cell can differ in more than one class at once; all are reported, so a
// summary can never hide a class behind another.
function classifyCell(a, b, opts) {
  const out = [];
  if (a.c !== b.c) out.push('glyph');
  if (a.w !== b.w) out.push('width');
  if (a.f !== b.f || a.b !== b.b || a.a !== b.a) out.push('sgr');
  if (opts.links && (a.l || null) !== (b.l || null)) out.push('link');
  return out;
}

// Compare two frames. opts.maxDetail caps the per-class detail list (default 8);
// counts are always complete. opts.ignoreBlankTail drops trailing all-default
// columns from consideration on both sides (off by default: a trailing-blank
// difference is a real difference to a segmenter).
function diff(a, b, opts = {}) {
  const maxDetail = opts.maxDetail == null ? 8 : opts.maxDetail;
  const linksJudged = !!(a.links && b.links);
  const counts = { geometry: 0, glyph: 0, width: 0, sgr: 0, link: 0 };
  const detail = [];

  if (a.cols !== b.cols || a.rows !== b.rows) {
    counts.geometry = 1;
    detail.push({ class: 'geometry', a: `${a.cols}x${a.rows}`, b: `${b.cols}x${b.rows}` });
  }

  const rows = Math.min(a.rows, b.rows);
  const cols = Math.min(a.cols, b.cols);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const ca = cellAt(a, y, x); const cb = cellAt(b, y, x);
      const classes = classifyCell(ca, cb, { links: linksJudged });
      if (classes.length === 0) continue;
      for (const k of classes) counts[k]++;
      if (detail.length < maxDetail) detail.push({ class: classes.join('+'), y, x, a: ca, b: cb });
    }
  }

  const total = CLASSES.reduce((n, k) => n + counts[k], 0) + counts.geometry;
  return { equal: total === 0, total, counts, detail, linksJudged, maxDetail };
}

// Plain text of a frame row, for human-readable diff output. Width-0 cells are
// the trailing half of a wide grapheme and carry no glyph, so they contribute
// nothing — which is exactly why a text comparison cannot see spacer placement.
function rowText(frame, y) {
  let s = '';
  for (let x = 0; x < frame.cols; x++) { const c = cellAt(frame, y, x); if (c.w !== 0) s += (c.c || ' '); }
  return s.replace(/\s+$/, '');
}

function describe(a, b, d) {
  const lines = [];
  lines.push(`frames ${d.equal ? 'IDENTICAL' : 'DIFFER'}: ${d.total} differing cell-classes`
    + ` (glyph=${d.counts.glyph} width=${d.counts.width} sgr=${d.counts.sgr} link=${d.counts.link}`
    + `${d.counts.geometry ? ' geometry=1' : ''})`);
  if (!d.linksJudged) lines.push('  NOTE: hyperlinks NOT judged — a frame did not observe OSC-8 (links:false)');
  let shownRow = null;
  for (const e of d.detail) {
    if (e.class === 'geometry') { lines.push(`  geometry: ${e.a} vs ${e.b}`); continue; }
    // The two rows are the operator's orientation, so print them once per row
    // rather than once per cell — a whole-line divergence is otherwise 60 copies
    // of the same two strings and the actual cell detail scrolls away.
    if (a && b && shownRow !== e.y) {
      shownRow = e.y;
      lines.push(`  row ${e.y}  A: ${JSON.stringify(rowText(a, e.y))}`);
      lines.push(`  row ${e.y}  B: ${JSON.stringify(rowText(b, e.y))}`);
    }
    lines.push(`    [${e.class}] col ${e.x}:`
      + ` A=${JSON.stringify(e.a.c)} w${e.a.w} f${e.a.f} b${e.a.b} a${e.a.a} l${JSON.stringify(e.a.l)}`
      + ` | B=${JSON.stringify(e.b.c)} w${e.b.w} f${e.b.f} b${e.b.b} a${e.b.a} l${JSON.stringify(e.b.l)}`);
  }
  if (d.total > d.detail.length) lines.push(`  ... ${d.total - d.detail.length} more`);
  return lines.join('\n');
}

// Throwing form for tests. `opts.requireLinks:false` allows a comparison on a
// build whose emulator cannot observe OSC-8 — it must be passed deliberately.
function assertFramesEqual(a, b, message, opts = {}) {
  const d = diff(a, b, opts);
  const requireLinks = opts.requireLinks !== false;
  if (requireLinks && !d.linksJudged) {
    throw new Error(`${message || 'frames'}: hyperlinks could not be observed, so equality cannot be claimed`);
  }
  if (!d.equal) throw new Error(`${message || 'frames'}:\n${describe(a, b, d)}`);
  return d;
}

// ---- deliberate corruption, used to prove the oracle can fail -------------
// Each of these produces exactly one of the four wrongness classes, so a test
// can show the differ names it. They mutate a copy; the input is untouched.
function cloneFrame(f) { return JSON.parse(JSON.stringify(f)); }

function corrupt(frame, kind, at = {}) {
  const f = cloneFrame(frame);
  const y = at.y == null ? 0 : at.y;
  const x = at.x == null ? 0 : at.x;
  const cell = f.cells[y] && f.cells[y][x];
  if (!cell) throw new Error(`corrupt: no cell at ${y},${x}`);
  if (kind === 'glyph') cell.c = cell.c === 'X' ? 'Y' : 'X';
  else if (kind === 'width') cell.w = cell.w === 2 ? 1 : 2;
  else if (kind === 'sgr') cell.a ^= 1;              // flip bold
  else if (kind === 'link') cell.l = (cell.l || '') + '#corrupted';
  else throw new Error(`corrupt: unknown kind ${kind}`);
  return f;
}

module.exports = { diff, describe, assertFramesEqual, rowText, corrupt, cloneFrame, classifyCell, CLASSES };

// CLI: frame-diff.cjs A.json B.json — exits 0 when identical, 1 when they differ.
if (require.main === module) {
  const fs = require('node:fs');
  const [pa, pb] = process.argv.slice(2);
  if (!pa || !pb) { process.stderr.write('usage: frame-diff.cjs A.json B.json\n'); process.exit(2); }
  const a = JSON.parse(fs.readFileSync(pa, 'utf8'));
  const b = JSON.parse(fs.readFileSync(pb, 'utf8'));
  const d = diff(a, b, { maxDetail: 20 });
  process.stdout.write(describe(a, b, d) + '\n');
  process.exit(d.equal ? 0 : 1);
}
