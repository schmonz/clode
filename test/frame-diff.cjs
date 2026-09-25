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

// THE ONE EQUIVALENCE: an UNWRITTEN narrow cell ("") and a written SPACE (" ")
// are the same glyph. Measured 2026-09-24, not assumed: native Claude Code
// against ITSELF (2.1.251 and 2.1.278, darwin-arm64) sometimes writes the space
// at row 1 col 8 of its banner and sometimes skips it — the renderer's
// frame-to-frame diff decides, not the content — so without this an exact-equality
// gate flakes on native-vs-native, and a gate that flakes is a gate that lies.
// The two render identically on any terminal. What the equivalence does NOT
// absorb, each proven in frame-diff.test.cjs: a space whose colours or
// attributes differ from the unwritten cell (still `sgr`), a width-0 spacer
// (the second half of a wide glyph, `c:""` with `w:0`, never touched here), and
// any other glyph.
function visibleGlyph(c) { return (c.c === '' && c.w === 1) ? ' ' : c.c; }

// Classify one cell pair. Returns the list of classes it differs in ([] = same).
// A cell can differ in more than one class at once; all are reported, so a
// summary can never hide a class behind another.
function classifyCell(a, b, opts) {
  const out = [];
  if (visibleGlyph(a) !== visibleGlyph(b)) out.push('glyph');
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

// ---- sessions: a frame per scripted step (CellSegmenter phase 5) ------------------
// A session is tui-screen.cjs --script's output: { format: 'clode-frames-v1', exit,
// frames: [{ label, settled, ms, frame }] }, frame 0 labelled 'boot'.

// Visibly painted cells: not unwritten, not a written space, not a wide glyph's spacer.
// A gate's `examined` is counted in these, so a blank screen can never clear a floor.
function nonBlank(frame) {
  let n = 0;
  for (const row of frame.cells) for (const c of row) if (c && c.c !== '' && c.c !== ' ') n++;
  return n;
}

// Whether `text` appears on some row of the frame (rowText: spacers dropped, unwritten
// cells read as spaces). How a gate proves its reference painted what the scene exists for.
function frameShows(frame, text) {
  for (let y = 0; y < frame.rows; y++) if (rowText(frame, y).includes(text)) return true;
  return false;
}

// A synthetic session for a guard's control: n settled, labelled copies of a painted
// rows x cols frame ('boot', 'step 1', ...), each an independent deep copy so a control can
// plant a difference in one frame only. `painted` cells per frame (default 300, so four
// frames clear a 1000-cell floor and a control's finding is its planted cell, not the floor).
function syntheticSession(n, { rows = 40, cols = 100, painted = 300 } = {}) {
  const cells = [];
  let k = 0;
  for (let y = 0; y < rows; y++) {
    const row = [];
    for (let x = 0; x < cols; x++) {
      const on = k < painted && x < 60;
      if (on) k++;
      row.push({ c: on ? String.fromCharCode(0x41 + (x % 26)) : '', w: 1, f: '0:-1', b: '0:-1', a: 0, l: null });
    }
    cells.push(row);
  }
  const frame = { format: 'clode-frame-v1', cols, rows, links: true, cells };
  const frames = [];
  for (let i = 0; i < n; i++) frames.push({ label: i === 0 ? 'boot' : `step ${i}`, settled: true, ms: 0, frame: cloneFrame(frame) });
  return { format: 'clode-frames-v1', exit: null, frames };
}

// Compare two sessions step by step with diff(). Different frame counts, or the same
// position carrying different step labels, are differences (the two ran different scripts,
// or one stopped early): such a step has d:null and says which side is `missing` or that
// the `labels` disagree. `firstDiff` is the earliest differing step, since a stale cell's
// cause is usually the step BEFORE the frame that shows it. `unsettled` lists the labels
// whose frame did not settle on either side; it does not decide `equal` (a gate reports it
// as its own finding). `linksJudged` is false if any compared frame could not see links.
function diffSessions(a, b, opts = {}) {
  const fa = a.frames, fb = b.frames;
  const steps = [];
  let firstDiff = null, linksJudged = true;
  const unsettled = [];
  for (let i = 0; i < Math.max(fa.length, fb.length); i++) {
    const x = fa[i], y = fb[i];
    const label = (x || y).label;
    let step;
    if (!x || !y) step = { label, d: null, missing: x ? 'B' : 'A' };
    else if (x.label !== y.label) step = { label, d: null, labels: [x.label, y.label] };
    else {
      step = { label, d: diff(x.frame, y.frame, opts) };
      if (!step.d.linksJudged) linksJudged = false;
    }
    steps.push(step);
    if ((x && x.settled === false) || (y && y.settled === false)) unsettled.push(label);
    if (!firstDiff && (!step.d || !step.d.equal)) firstDiff = { ...step, index: i };
  }
  return { equal: firstDiff === null, steps, firstDiff, unsettled, linksJudged };
}

// The human-readable first difference of a session diff: which step, which frame of how
// many, and then describe()'s cell detail -- or why there was no pair of frames to compare.
function describeSessions(a, b, ds) {
  if (ds.equal) return `sessions IDENTICAL over ${ds.steps.length} frames`;
  const f = ds.firstDiff;
  const where = `first difference at step "${f.label}" (frame ${f.index} of 0-${Math.max(a.frames.length, b.frames.length) - 1})`;
  if (f.missing) return `${where}: ${f.missing} has no frame (A has ${a.frames.length} frames, B has ${b.frames.length})`;
  if (f.labels) return `${where}: A ran "${f.labels[0]}", B ran "${f.labels[1]}" -- not the same script`;
  return `${where}:\n${describe(a.frames[f.index].frame, b.frames[f.index].frame, f.d)}`;
}

// THE JUDGEMENT OF A PAIR OF CAPTURED SESSIONS, stated once for every session gate: native
// against itself (session-determinism), native against quaude (interactive-session-diff),
// and each later one. Pure: { examined, findings }, every finding naming the session.
//
//   sides     how a finding names each capture, and whether it is native:
//             [{ who: 'native', run: 'run 1', native: true }, { who: 'quaude' }]
//   mustShow  text side A (the reference) must paint in its last frame
//   differs   the sentence a difference is reported with
//
// `examined` is side A's painted cells over every frame. Each of these is a finding: a
// capture that produced nothing, a side that exited, a step that never settled, a NATIVE
// frame with no painted cell, a reference that never showed `mustShow`, hyperlinks no
// frame could observe, and the first difference (describeSessions).
//
// A BLANK NATIVE FRAME (ruling R8, phase 5 task 4). Two blank frames compare equal and
// judge nothing, so a native that had not painted yet -- measured in task 3: 3 of 8 loaded
// boots were blank after an 800 ms window -- would read as a pass against a quaude that had
// not painted either, and a slow quaude boot would be misread. The finding names the step
// and the run.
function judgeSessions({ session, a, b, sides, mustShow, differs }) {
  const name = (s) => s.run || s.who;
  if (!a || !b) {
    return { examined: 0, findings: [`${session}: a capture produced no session (${name(sides[0])}: ${!!a}, `
      + `${name(sides[1])}: ${!!b}); the reason is on stderr`] };
  }
  const findings = [];
  for (const [side, s] of [[sides[0], a], [sides[1], b]]) {
    const on = side.run ? ` on ${side.run}` : '';
    const inRun = side.run ? ` (${side.run})` : '';
    if (s.exit) findings.push(`${session}: ${side.who} exited during step "${s.exit.during}"${on} (code ${s.exit.code}, signal ${s.exit.signal})`);
    for (const f of s.frames) {
      if (!f.settled) {
        findings.push(`${session}: step "${f.label}" never settled on ${side.who} within ${f.ms} ms${inRun} -- `
          + (side.native ? 'fix the script (a settle point after the timing-sensitive UI), never the cap'
            : `${side.who} kept painting past the cap: find why, never widen the cap`));
      }
    }
    if (side.native) {
      for (const f of s.frames) {
        if (nonBlank(f.frame) === 0) {
          findings.push(`${session}: ${side.who} painted a BLANK frame at step "${f.label}"${inRun} -- two blank `
            + 'frames compare equal and judge nothing');
        }
      }
    }
  }
  const last = a.frames[a.frames.length - 1];
  if (mustShow && !frameShows(last.frame, mustShow)) {
    findings.push(`${session}: ${sides[0].who} never painted ${JSON.stringify(mustShow)} by its last step `
      + `("${last.label}"), so this session judged nothing it exists for`);
  }
  const d = diffSessions(a, b, { maxDetail: 30 });
  if (!d.linksJudged) findings.push(`${session}: hyperlinks were NOT observable in a frame, so identity cannot be claimed`);
  if (!d.equal) findings.push(`${session}: ${differs}: ${describeSessions(a, b, d)}`);
  return { examined: a.frames.reduce((n, f) => n + nonBlank(f.frame), 0), findings };
}

module.exports = { diff, describe, assertFramesEqual, rowText, corrupt, cloneFrame, classifyCell, CLASSES,
  nonBlank, frameShows, syntheticSession, diffSessions, describeSessions, judgeSessions };

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
