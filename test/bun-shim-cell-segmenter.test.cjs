'use strict';
// Bun.ant.CellSegmenter, judged the only way it can be judged below the screen:
// by playing its ONE caller. Upstream 2.1.278's `class Mf` (chunk-rp2p2mxd.js in
// the darwin carve) is the whole consumer, and the contract in BACKLOG.md is
// derived from it. Every case here uses the caller's own arithmetic — its
// grow-and-retry, its width() sum, its runWords() run-index read, its B0()
// damage unpack, its SC regex — so a test passes only if the CALLER would get
// what it needs, not merely if our own encoding round-trips.
//
// What this file cannot do: compare against native. Native CellSegmenter exists
// only inside Anthropic's Bun, so the ground truth is the screen, and that is
// test/frame-oracle.cjs (measured 2026-09-24 on darwin-arm64: 0 differing
// cell-classes against native 2.1.278's initial frame, 3/3 runs, after 709 at
// baseline). This file pins the CONTRACT so a later edit cannot drift from what
// that measurement certified.
//
// Nothing is pinned as wrong any more. Phase 3's two pins (clustering, widths) and
// phase 4's (OSC-8 links, not interned) were each asserted as they were until the fix
// turned them red, and were re-taken on purpose: the last two tests assert native's
// answers. Clusters, widths, styles and links themselves are judged against native by
// test/fidelity/text-differential.test.cjs.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runLoader, skipUnlessTjs, REPO } = require('./node-shim-helper.cjs');

const SHIM = path.join(REPO, 'libexec/bun-shim.cjs');

// The program runs under the engine (bun-shim needs the node-shim host) and
// reports JSON; the assertions run here.
const PROGRAM = String.raw`
const CS = Bun.ant.CellSegmenter;
// vs(), verbatim in shape: the only options the bundle ever passes.
const SCREEN = { widthMask: 3, narrow: 0, wide: 1, spacerTail: 2, spacerHead: 3,
  emptyCharIndex: 0, spacerCharIndex: 1, emptyWord: 0, tabWidth: 8 };
const BIDI = [[1564, 1564], [8234, 8238], [8294, 8297]];
const make = (sub) => new CS({ ambiguousIsNarrow: true, substitute: sub, screen: SCREEN });

// Mf.segment's grow-and-retry: ONE retry, never a loop.
function seg(n, text, size) {
  let cells = new Int32Array(size || 512), runs = new Int32Array(size || 512);
  let u = n.segment(text, cells, runs, false);
  const first = u;
  if (u < 0) {
    const f = Math.max(-u, cells.length);
    cells = new Int32Array(2 * f); runs = new Int32Array(2 * f);
    u = n.segment(text, cells, runs, false);
  }
  const c = [], r = [];
  for (let i = 0; i < u; i++) c.push([cells[2 * i], cells[2 * i + 1]]);
  const nRuns = u === 0 ? 0 : (cells[2 * u - 1] >>> 10) + 1;   // runWords()
  for (let j = 0; j < nRuns; j++) r.push([runs[2 * j], runs[2 * j + 1]]);
  return { first, count: u, cells: c, runs: r, cellsBuf: cells };
}
// Mf.width: sums advances; bit 8 is a tab resolved against the column.
function width(res, start) {
  let m = start;
  for (const [, w] of res.cells) m += (w & 256) !== 0 ? 8 - (m % 8) : w & 255;
  return m - start;
}
// B0()'s unpack, and F0()'s end column.
const unpack = (u) => ({ end: u % 1048576, x1: Math.floor(u / 1048576) % 65536,
  x2: Math.floor(u / 68719476736) });
const key = (n, id) => ({ open: n.sgrKeys[id].split('\x00'), close: n.sgrCloseKeys[id].split('\x00') });

const out = {};

{ const n = make(BIDI);
  const pools = [n.graphemes, n.sgrKeys, n.sgrCloseKeys, n.uris];
  out.fresh = { graphemes: n.graphemes.slice(), sgrKeys: n.sgrKeys.slice(),
    sgrCloseKeys: n.sgrCloseKeys.slice(), uris: n.uris.slice() };
  const a = seg(n, 'ab');
  const b = seg(n, 'ba');
  out.ascii = { count: a.count, cells: a.cells, runs: a.runs, graphemes: n.graphemes.slice(),
    reversed: b.cells.map(([g]) => g),
    sameObjects: pools.every((p, i) => p === [n.graphemes, n.sgrKeys, n.sgrCloseKeys, n.uris][i]) };
}

{ const n = make(BIDI);
  const r = seg(n, 'hello, world', 2);        // capacity ONE cell
  out.grow = { first: r.first, count: r.count, text: r.cells.map(([g]) => n.graphemes[g]).join('') };
  out.empty = seg(n, '').count;
}

{ const n = make(BIDI);
  const r = seg(n, '\x1b[1mA\x1b[22mB');
  out.sgrRuns = { count: r.count, runOf: r.cells.map(([, w]) => w >>> 10), runs: r.runs,
    styleA: key(n, r.runs[0][0]) };
}

{ const n = make(BIDI);
  const r = seg(n, '\x1b[1;38;5;208mX');
  out.compound = key(n, r.runs[0][0]);
}

{ const n = make(BIDI);
  const r = seg(n, '\x1b[1m\x1b[2mA\x1b[22mB');
  out.boldDim = { a: key(n, r.runs[0][0]), bStyle: r.runs[1][0] };
}

{ const n = make(BIDI);
  const r = seg(n, '\x1b[31m\x1b[1mA\x1b[32mB\x1b[31mC');
  out.reapply = { a: key(n, r.runs[0][0]), b: key(n, r.runs[1][0]), c: key(n, r.runs[2][0]) };
  const same = seg(n, '\x1b[31m\x1b[1mA\x1b[31mB');
  out.reapply.sameRuns = same.runs.length;
  out.reapply.sameIdAsA = same.runs[0][0] === r.runs[0][0];
}

{ const n = make(BIDI);
  const r = seg(n, '\x1b[4:3mU\x1b[99mV');
  out.kept = r.runs.map(([s]) => key(n, s));
}

{ const n = make(BIDI);
  const r = seg(n, '\x9b1;31mX\x9b4:3mY');
  out.c1 = r.runs.map(([s]) => key(n, s));
}

{ const n = make(BIDI);
  const r = seg(n, 'a\tb');
  out.tab = { count: r.count, tabBit: r.cells.map(([, w]) => (w & 256) !== 0), width: width(r, 0),
    widthFrom3: width(r, 3) };
}

{ const n = make(BIDI);
  const r = seg(n, 'x\u202ey\u061cz');
  out.substitute = r.cells.map(([g]) => n.graphemes[g]);
  const p = make([]);
  const q = seg(p, 'x\u202ey');
  out.noSubstitute = q.cells.map(([g]) => p.graphemes[g]);
}

{ const n = make(BIDI);
  const r = seg(n, 'a\x1b]8;;https://example.com\x07L\x1b]8;;\x1b\\b\x01\x7f');
  out.osc = { text: r.cells.map(([g]) => n.graphemes[g]).join(''), linkOfRuns: r.runs.map(([, l]) => l),
    uris: n.uris.slice() };
}

// CELL-LINK: each cell's grapheme and its run's uris index, and the pool after, one fresh
// segmenter per case unless the case is about what one segmenter carries across calls.
{ const cp = (...c) => String.fromCodePoint(...c);
  const links = (n, text) => { const r = seg(n, text); return r.cells.map(([g, w]) => [n.graphemes[g], r.runs[w >>> 10][1]]); };
  const one = (text) => { const n = make([]); return { cells: links(n, text), uris: n.uris.slice() }; };
  out.link = {
    mark: one('e\x1b]8;;u\x07' + cp(0x301) + 'x'),
    ids: one('\x1b]8;id=1;u\x07a\x1b]8;id=2;u\x9cb\x9d8;;v\x1b\\c'),
    readNoCell: one('a\x1b]8;;u\x07\x1b]8;;\x07b'),
    trailing: one('a\x1b]8;;u\x07'),
    nest: one('\x1b]8;;u\x07a\x1b]8;;v\x07b\x1b]8;;\x07c'),
    notLinks: one('\x1b]8;;u\x07a\x1b]8;v\x07b\x1b[0mc\x1bcd\x1b]8;;w\x1b[1me'),
    tabWide: one('\x1b]8;;u\x07\t' + cp(0x4e2d) + '\x1b]8;;\x07' + cp(0x200b) + 'z'),
  };
  const n = make([]);
  out.link.perCall = { first: links(n, '\x1b]8;;u\x07a'), second: links(n, 'b'), uris: n.uris.slice() };
}

// paint(): the caller hands it the screen, an x that may run past the width,
// and the FULL count; clipping is paint's job.
{ const n = make(BIDI);
  const r = seg(n, 'abc');
  const charIndices = new Int32Array(n.graphemes.length).map((_, i) => 100 + i);
  const words = Int32Array.of(7 << 17);
  const W = 5, screen = new Int32Array(W * 2 * 2).fill(-1);
  const u = n.paint(screen, W, 3, 1, r.cellsBuf, r.count, undefined, charIndices, words);
  out.paint = { ...unpack(u), row1: Array.from(screen.slice(W * 2)), row0: Array.from(screen.slice(0, W * 2)) };

  // A wide scratch cell, built by hand, so paint's half of the contract (wide +
  // spacerTail) is pinned apart from what segment() makes of any text.
  const wide = Int32Array.of(0, 2 | (0 << 10));
  const s2 = new Int32Array(W * 2).fill(-1);
  const u2 = n.paint(s2, W, 1, 0, wide, 1, undefined, charIndices, words);
  out.paintWide = { ...unpack(u2), row: Array.from(s2) };

  const tabbed = seg(n, 'a\tb');
  const s3 = new Int32Array(12 * 2).fill(-1);
  const u3 = n.paint(s3, 12, 0, 0, tabbed.cellsBuf, tabbed.count, undefined,
    new Int32Array(n.graphemes.length).map((_, i) => 100 + i), words);
  out.paintTab = { ...unpack(u3), chars: Array.from(s3).filter((_, i) => i % 2 === 0) };
}

// setCell: px()'s singleton is vs([]) and it only ever calls this.
{ const n = make([]);
  const W = 4, screen = new Int32Array(W * 2 * 2).fill(-1);
  const u = n.setCell(screen, W, 2, 1, 42, 99);
  const off = n.setCell(screen, W, 4, 1, 43, 98);
  out.setCell = { ...unpack(u), row1: Array.from(screen.slice(W * 2)), off: unpack(off),
    pools: [n.graphemes.length, n.sgrKeys.length, n.uris.length] };
}

// Clusters and widths, as native 2.1.278 gives them (phase 3; see the header).
{ const n = make(BIDI);
  const combining = seg(n, 'e\u0301');
  const cjk = seg(n, '中');
  const skin = seg(n, '\u{1f44d}\u{1f3fd}');
  out.pins = { combiningCells: combining.count, cjkWidth: width(cjk, 0),
    skinCells: skin.count, skinWidth: width(skin, 0),
    wholeCluster: skin.cells.length === 1 && n.graphemes[skin.cells[0][0]] === '\u{1f44d}\u{1f3fd}' };
}

console.log('JSON:' + JSON.stringify(out));
`;

let cached;
function results(t) {
  if (skipUnlessTjs(t)) return null;
  if (cached) return cached;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bun-shim-cellseg-'));
  const f = path.join(dir, 'p.cjs');
  fs.writeFileSync(f, `require(${JSON.stringify(SHIM)});\n${PROGRAM}`);
  const r = runLoader(f);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.strictEqual(r.status, 0, r.stderr);
  const line = r.stdout.split('\n').find((l) => l.startsWith('JSON:'));
  assert.ok(line, `no JSON line in:\n${r.stdout}\n${r.stderr}`);
  cached = JSON.parse(line.slice(5));
  return cached;
}

// The caller's own acceptance regex for an SGR entry (`SC`). A spelling it
// rejects is silently DROPPED by ansiCodes(), i.e. an invisible loss of style.
const SC = /^\x1b\[(?:\d{1,3})(?:;5;\d{1,3}|;2;\d{1,3};\d{1,3};\d{1,3})?m$/;

test('pools start with index 0 reserved where the caller reserves it', (t) => {
  const o = results(t); if (!o) return;
  assert.deepStrictEqual(o.fresh, { graphemes: [], sgrKeys: [''], sgrCloseKeys: [''], uris: [''] },
    'ansiCodes(0) and styleId(0) treat sgr index 0 as "no style", and runWords treats uri 0 as '
    + '"no link"; graphemes reserves nothing');
});

test('ASCII: one narrow cell per character, one run, stable indices, same pool objects', (t) => {
  const o = results(t); if (!o) return;
  assert.strictEqual(o.ascii.count, 2);
  assert.deepStrictEqual(o.ascii.cells, [[0, 1], [1, 1]], 'advance 1, no tab bit, run 0');
  assert.deepStrictEqual(o.ascii.runs, [[0, 0]], 'no style, no link');
  assert.deepStrictEqual(o.ascii.graphemes, ['a', 'b']);
  assert.deepStrictEqual(o.ascii.reversed, [1, 0],
    'a grapheme keeps its index across calls: the caller memoises charIndices() by it');
  assert.ok(o.ascii.sameObjects,
    'the caller caches the pool ARRAYS in fields and re-reads them only in resetNative()');
});

test('a short buffer returns a negative the caller\'s single retry can satisfy', (t) => {
  const o = results(t); if (!o) return;
  assert.ok(o.grow.first < 0, `expected a negative first answer, got ${o.grow.first}`);
  assert.ok(-o.grow.first >= 12, `|${o.grow.first}| must cover all 12 cells or the retry corrupts`);
  assert.strictEqual(o.grow.count, 12, 'the retry must succeed: Mf.segment does not loop');
  assert.strictEqual(o.grow.text, 'hello, world');
  assert.strictEqual(o.empty, 0, 'xC() short-circuits on a zero count');
});

test('SGR splits runs, and open/close keys are the exact spellings the caller compares', (t) => {
  const o = results(t); if (!o) return;
  assert.strictEqual(o.sgrRuns.count, 2);
  assert.deepStrictEqual(o.sgrRuns.runOf, [0, 1]);
  assert.deepStrictEqual(o.sgrRuns.styleA, { open: ['\x1b[1m'], close: ['\x1b[22m'] });
  assert.deepStrictEqual(o.sgrRuns.runs[1], [0, 0], 'after 22m, B has no style at all');
});

test('a compound SGR is split into codes the caller\'s SC regex accepts', (t) => {
  const o = results(t); if (!o) return;
  assert.deepStrictEqual(o.compound, { open: ['\x1b[1m', '\x1b[38;5;208m'], close: ['\x1b[22m', '\x1b[39m'] });
  for (const c of o.compound.open) assert.match(c, SC);
});

test('bold and dim coexist, and 22m closes both', (t) => {
  const o = results(t); if (!o) return;
  assert.deepStrictEqual(o.boldDim.a, { open: ['\x1b[1m', '\x1b[2m'], close: ['\x1b[22m', '\x1b[22m'] });
  assert.strictEqual(o.boldDim.bStyle, 0);
});

// The next three are native 2.1.278's own keys (measured 2026-09-25 through the same caller
// arithmetic); the rules are unicode-text.cjs's SGR- and CELL-SGR, pinned one by one in
// test/unicode-text.test.cjs. They were once a CHOICE here (a replaced colour kept its
// place; colon forms and codes SC refuses were dropped), and the painted style differed
// from native's on 2,014 strings of the text gate's corpora until the gate compared it.
test('CELL-SGR: a replaced style goes to the END; an identical re-open stays where it is', (t) => {
  const o = results(t); if (!o) return;
  assert.deepStrictEqual(o.reapply.a, { open: ['\x1b[31m', '\x1b[1m'], close: ['\x1b[39m', '\x1b[22m'] });
  assert.deepStrictEqual(o.reapply.b, { open: ['\x1b[1m', '\x1b[32m'], close: ['\x1b[22m', '\x1b[39m'] });
  assert.deepStrictEqual(o.reapply.c, { open: ['\x1b[1m', '\x1b[31m'], close: ['\x1b[22m', '\x1b[39m'] },
    're-opening the outer colour after another is a NEW order, so a new style id, as in native');
  assert.strictEqual(o.reapply.sameRuns, 1, '31 1 A 31 B: re-opening 31 as it already is changes nothing');
  assert.ok(o.reapply.sameIdAsA, 'and it is the very same key as 31 1');
});

test('SGR-WHOLE and SGR-CLOSES: a colon form and a code SC refuses are KEPT, as native keeps them', (t) => {
  const o = results(t); if (!o) return;
  // The caller's ansiCodes() drops what its SC regex refuses; the key still holds the
  // attribute's place, so a colon form after `ESC[4m` stops the underline painting.
  assert.deepStrictEqual(o.kept, [
    { open: ['\x1b[4:3m'], close: ['\x1b[24m'] },
    { open: ['\x1b[4:3m', '\x1b[99m'], close: ['\x1b[24m', '\x1b[0m'] },
  ]);
  assert.doesNotMatch(o.kept[1].open[0], SC);
  assert.match(o.kept[1].open[1], SC);
});

test('CELL-SGR: a C1 CSI is keyed in the ESC spelling, a whole one with its parameters as written', (t) => {
  const o = results(t); if (!o) return;
  assert.deepStrictEqual(o.c1, [
    { open: ['\x1b[1m', '\x1b[31m'], close: ['\x1b[22m', '\x1b[39m'] },
    { open: ['\x1b[1m', '\x1b[31m', '\x1b[4:3m'], close: ['\x1b[22m', '\x1b[39m', '\x1b[24m'] },
  ]);
});

test('a TAB is one scratch cell with bit 8, resolved against the column', (t) => {
  const o = results(t); if (!o) return;
  assert.strictEqual(o.tab.count, 3);
  assert.deepStrictEqual(o.tab.tabBit, [false, true, false]);
  assert.strictEqual(o.tab.width, 9, 'a(1) + tab to col 8 (7) + b(1)');
  assert.strictEqual(o.tab.widthFrom3, 6, 'from col 3: a(1) + tab to col 8 (4) + b(1)');
});

test('substitute ranges become U+FFFD, and an empty list substitutes nothing', (t) => {
  const o = results(t); if (!o) return;
  assert.deepStrictEqual(o.substitute, ['x', '�', 'y', '�', 'z']);
  // With no ranges U+202E is itself, and zero-width, so it has no cell at all (native,
  // 2026-09-24: `a U+202E b` with substitute [] -> [a] [b]).
  assert.deepStrictEqual(o.noSubstitute, ['x', 'y']);
});

test('OSC sequences and C0 controls paint nothing', (t) => {
  const o = results(t); if (!o) return;
  assert.strictEqual(o.osc.text, 'aLb', 'OSC bytes (BEL- or ST-terminated) must not paint as glyphs');
});

test('paint clips at the width, writes both slots, and packs end|x1|x2', (t) => {
  const o = results(t); if (!o) return;
  const S = 7 << 17;
  assert.deepStrictEqual(o.paint.row1, [-1, -1, -1, -1, -1, -1, 100, S, 101, S],
    'cols 3-4 painted with charIndices[grapheme] and the run word | narrow(0); col 5 clipped');
  assert.ok(o.paint.row0.every((v) => v === -1), 'paint must stay on its own row');
  assert.deepStrictEqual({ end: o.paint.end, x1: o.paint.x1, x2: o.paint.x2 }, { end: 6, x1: 3, x2: 5 });
});

test('paint spells a wide grapheme as wide(1) then spacerTail(2) at spacerCharIndex', (t) => {
  const o = results(t); if (!o) return;
  const S = 7 << 17;
  assert.deepStrictEqual(o.paintWide.row, [-1, -1, 100, S | 1, 1, S | 2, -1, -1, -1, -1],
    'Yd()\'s blit fixups look for exactly 1 followed by 2');
  assert.deepStrictEqual({ end: o.paintWide.end, x1: o.paintWide.x1, x2: o.paintWide.x2 },
    { end: 3, x1: 1, x2: 3 });
});

test('paint expands a tab into emptyCharIndex blanks up to the next stop', (t) => {
  const o = results(t); if (!o) return;
  assert.strictEqual(o.paintTab.end, 9);
  assert.deepStrictEqual(o.paintTab.chars.slice(0, 10), [100, 0, 0, 0, 0, 0, 0, 0, 101, -1]);
});

test('setCell writes one cell, reports its damage, and touches no pool', (t) => {
  const o = results(t); if (!o) return;
  assert.deepStrictEqual(o.setCell.row1, [-1, -1, -1, -1, 42, 99, -1, -1]);
  assert.deepStrictEqual({ x1: o.setCell.x1, x2: o.setCell.x2 }, { x1: 2, x2: 3 });
  assert.ok(o.setCell.off.x1 >= o.setCell.off.x2, 'off-screen: B0() must see no damage');
  assert.deepStrictEqual(o.setCell.pools, [0, 1, 1]);
});

test('clusters and widths match native (2026-09-24 measurements)', (t) => {
  const o = results(t); if (!o) return;
  // native 2.1.278: [0065 0301]=1, [4E2D]=2, [1F44D 1F3FD]=2
  assert.strictEqual(o.pins.combiningCells, 1, '"e"+U+0301 is ONE cluster');
  assert.strictEqual(o.pins.cjkWidth, 2, 'U+4E2D is 2 columns wide');
  assert.strictEqual(o.pins.skinCells, 1, 'a skin-tone emoji is ONE cluster');
  assert.strictEqual(o.pins.skinWidth, 2, 'and 2 columns wide');
  assert.ok(o.pins.wholeCluster, 'its cell holds the whole sequence, both surrogate pairs intact');
});

// Phase 4's pin, re-taken: it asserted `uris` stayed [''] and every run's link 0 until
// CELL-LINK landed. Every literal below is native 2.1.278's CellSegmenter (2026-09-25).
test('CELL-LINK: a link is interned into uris and named by the runs of the cells it covers', (t) => {
  const o = results(t); if (!o) return;
  // native: `a` [link 0] `L` [link 1] `b` [link 0], uris ['', 'https://example.com']
  assert.deepStrictEqual(o.osc.uris, ['', 'https://example.com']);
  assert.deepStrictEqual(o.osc.linkOfRuns, [0, 1, 0], 'no link, the link, closed by ESC]8;; ESC \\');
  // no nesting: `u`, then `v`, then a close is no link, not `u`
  assert.deepStrictEqual(o.link.nest, { cells: [['a', 1], ['b', 2], ['c', 0]], uris: ['', 'u', 'v'] });
  // one `;`, SGR 0, RIS and an OSC 8 ended by an ESC that is not ST neither open nor close one
  assert.deepStrictEqual(o.link.notLinks, { cells: [['a', 1], ['b', 1], ['c', 1], ['d', 1], ['e', 1]], uris: ['', 'u'] });
  // a tab takes the link; a zero-width cluster has no cell to take one
  assert.deepStrictEqual(o.link.tabWide, { cells: [['\t', 1], [String.fromCodePoint(0x4e2d), 1], ['z', 0]], uris: ['', 'u'] });
});

test('CELL-LINK: a cell takes the link in force where its cluster starts, and each segment() starts with none', (t) => {
  const o = results(t); if (!o) return;
  // native `e`, an open of `u`, `U+0301 x`: the cluster `e U+0301` started before the open
  assert.deepStrictEqual(o.link.mark, { cells: [['e' + String.fromCodePoint(0x301), 0], ['x', 1]], uris: ['', 'u'] });
  // native: a link left open at the end of one segment() is not carried into the next
  assert.deepStrictEqual(o.link.perCall, { first: [['a', 1]], second: [['b', 0]], uris: ['', 'u'] });
});

test('CELL-LINK: uris holds the URI alone, interned as it is read', (t) => {
  const o = results(t); if (!o) return;
  // native: `id=1` and `id=2` on `u` are one entry; the C1 OSC's `v` is the next
  assert.deepStrictEqual(o.link.ids, { cells: [['a', 1], ['b', 1], ['c', 2]], uris: ['', 'u', 'v'] });
  // native interns `u` though no cell ever has it: closed before one, or after the last
  assert.deepStrictEqual(o.link.readNoCell, { cells: [['a', 0], ['b', 0]], uris: ['', 'u'] });
  assert.deepStrictEqual(o.link.trailing, { cells: [['a', 0]], uris: ['', 'u'] });
});
