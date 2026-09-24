#!/usr/bin/env node
'use strict';
// libexec/unicode-text.cjs's two profiles against the two native clusterers they stand for:
//   bun-cell  vs native Bun.ant.CellSegmenter — the cells it emits (cluster text read back
//             through its `graphemes` pool, and the advance), both ambiguousIsNarrow settings
//   uax29     vs native Intl.Segmenter — the segments; and on the GraphemeBreakTest corpus,
//             against Unicode's own answers (the ÷ marks)
// Ours runs under plain Node (the module is pure CommonJS); native runs through
// scripts/lib/native-oracle.cjs. Task 4b's instrument: every bun-cell delta was found and
// is re-proven here.
//
//   node scripts/cell-profile-diff.cjs --native BIN [--corpus NAME]...
//     NAME: gbt (GraphemeBreakTest at the width version), gbt-cell (at the cell version),
//           emoji-test, composed, probes, sweep; default all six
//
// Exit 0 when every compared pair is identical, 1 when any differs, 2 on harness failure
// (no native, a native refusal, a UCD input not cached while offline, a bad argument).
//
// COMPARING LIKE WITH LIKE, measured against 2.1.278 (Bun 1.4.3) on 2026-09-24:
// - CellSegmenter emits NO cell for a zero-width cluster, except TAB, whose cell has
//   advance 0 and flag bit 256; ours is shaped the same way.
// - Its cell advance is 8 bits and saturates at 255 (128 x U+1100 is 255 while
//   Bun.stringWidth says 256); ours is clamped the same way, clusterWidth itself is not.
// - Its cell text never holds a lone surrogate (LONE-SURROGATES-INVISIBLE); ours drops them.
// - ESC and the C1 introducers DCS, SOS, CSI, OSC, PM, APC start an escape sequence or
//   control string that CellSegmenter's escape layer consumes (`a ESC b c` -> [a] [c],
//   `a U+009F b c` -> [a]) before any clustering. That layer is the CellSegmenter shim's
//   (task 6), not the clusterer's, so a string holding one is not compared for bun-cell and
//   is counted as `escape-layer`.
const fs = require('node:fs');
const path = require('node:path');
const C = require('./lib/text-corpus.cjs');
const ucd = require('./lib/ucd.cjs');
const { runInNative, nativeVersion } = require('./lib/native-oracle.cjs');
const { clodeCacheDir } = require('../libexec/clode-paths.cjs');
const U = require('../libexec/unicode-text.cjs');

const ESCAPE_LAYER = new Set([0x1b, 0x90, 0x98, 0x9b, 0x9d, 0x9e, 0x9f]);
const CORPORA = ['gbt', 'gbt-cell', 'emoji-test', 'composed', 'probes', 'sweep'];
const SHOW = 10;

// One FNV-1a hash of a cell list, computed by the SAME source on both sides (sig.toString()
// goes into the native program): the sweep is 24M strings, too many to ship back as text.
// `cells` is [[text, advance | flags], ...].
function sig(cells) {
  let h = 0x811c9dc5;
  for (const [t, w] of cells) {
    for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    h ^= 0x10000 + w; h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}

const SEGMENTER = `
  const mk = (amb) => new Bun.ant.CellSegmenter({ ambiguousIsNarrow: amb, substitute: [],
    screen: { widthMask: 3, narrow: 0, wide: 1, spacerTail: 2, spacerHead: 3, emptyCharIndex: 0, spacerCharIndex: 1, emptyWord: 0, tabWidth: 8 } });
  const segs = { true: mk(true), false: mk(false) };
  let cells = new Int32Array(4096), runs = new Int32Array(4096);
  const cellsOf = (s, narrow) => {
    const n = segs[narrow];
    let c = n.segment(s, cells, runs, false);
    if (c < 0) { const f = Math.max(-c, cells.length); cells = new Int32Array(2 * f); runs = new Int32Array(2 * f); c = n.segment(s, cells, runs, false); }
    const row = [];
    for (let i = 0; i < c; i++) row.push([n.graphemes[cells[2 * i]], cells[2 * i + 1] & 511]);
    return row;
  };
`;

// Strings in, [narrow cells, wide cells, Intl segments] out, per string.
const CORPUS_PROBE = String.raw`${SEGMENTER}
  const seg = new Intl.Segmenter('en', { granularity: 'grapheme' });
  return input.map((s) => [cellsOf(s, true), cellsOf(s, false), Array.from(seg.segment(s), (x) => x.segment)]);
`;

// Code points lo..hi through every sweep template, one hash per (code point, template).
const SWEEP_PROBE = String.raw`${SEGMENTER}
  ${sig.toString()}
  const T = input.templates.map((t) => ({ pre: String.fromCodePoint(...t.pre), post: String.fromCodePoint(...t.post), narrow: t.narrow !== false }));
  const out = [];
  for (let cp = input.lo; cp <= input.hi; cp++) {
    const x = (cp >= 0xd800 && cp <= 0xdfff) ? String.fromCharCode(cp) : String.fromCodePoint(cp);
    for (const t of T) out.push(sig(cellsOf(t.pre + x + t.post, t.narrow)));
  }
  return out;
`;

function dropLoneSurrogates(t) {
  let o = '';
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < t.length) {
      const d = t.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) { o += t[i] + t[i + 1]; i++; continue; }
    }
    if (c >= 0xd800 && c <= 0xdfff) continue;
    o += t[i];
  }
  return o;
}

// Our cells for one string, shaped as CellSegmenter's (see COMPARING LIKE WITH LIKE).
function ourCells(s, narrow) {
  const row = [];
  let p = 0;
  for (const e of U.graphemeBoundaries(s, 0, s.length, 'bun-cell')) {
    const t = dropLoneSurrogates(s.slice(p, e));
    if (t === '\t') row.push([t, 256]);
    else {
      const w = U.clusterWidth(s, p, e, narrow, 'bun-cell');
      if (w > 0) row.push([t, Math.min(w, 255)]);
    }
    p = e;
  }
  return row;
}

function ourSegments(s) {
  const out = []; let p = 0;
  for (const e of U.graphemeBoundaries(s, 0, s.length, 'uax29')) { out.push(s.slice(p, e)); p = e; }
  return out;
}

function escapeLayer(s) {
  for (let i = 0; i < s.length; i++) if (ESCAPE_LAYER.has(s.charCodeAt(i))) return true;
  return false;
}

const hex = (s) => Array.from(s, (c) => c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')).join(' ');
const fmtCells = (row) => row.map(([t, w]) => `[${hex(t)}]=${w & 255}${w & 256 ? '/tab' : ''}`).join(' ') || '(no cells)';

function compareStrings(name, strings, native, cases) {
  const r = { name, examined: strings.length, escapeLayer: 0, bunCell: 0, uax29: 0, gbt: null, findings: [] };
  const note = (f) => { if (r.findings.length < SHOW) r.findings.push(f); };
  strings.forEach((s, i) => {
    const [nNarrow, nWide, nIntl] = native[i];
    const oIntl = ourSegments(s);
    if (JSON.stringify(nIntl) !== JSON.stringify(oIntl)) { r.uax29++; note(`uax29 ${hex(s)}: native Intl ${nIntl.map(hex).join(' | ')} ours ${oIntl.map(hex).join(' | ')}`); }
    if (escapeLayer(s)) { r.escapeLayer++; return; }
    for (const [narrow, n] of [[true, nNarrow], [false, nWide]]) {
      const o = ourCells(s, narrow);
      if (JSON.stringify(n) !== JSON.stringify(o)) {
        r.bunCell++;
        note(`bun-cell ${narrow ? 'narrow' : 'wide'} ${hex(s)}: native ${fmtCells(n)} ours ${fmtCells(o)}`);
        break;
      }
    }
  });
  if (cases) {
    r.gbt = { lines: cases.length, bad: 0 };
    for (const { s, ends } of cases) {
      const got = U.graphemeBoundaries(s, 0, s.length, 'uax29');
      if (JSON.stringify(got) !== JSON.stringify(ends)) { r.gbt.bad++; note(`gbt ${hex(s)}: want ${JSON.stringify(ends)} uax29 ${JSON.stringify(got)}`); }
    }
  }
  return r;
}

function sweep(bin) {
  const T = C.CELL_SWEEP_TEMPLATES;
  const TS = T.map((t) => ({ pre: String.fromCodePoint(...t.pre), post: String.fromCodePoint(...t.post), narrow: t.narrow !== false }));
  const r = { name: 'sweep', examined: 0, escapeLayer: 0, bunCell: 0, uax29: null, gbt: null, findings: [] };
  const CHUNK = 0x10000;
  for (let lo = 0; lo < 0x110000; lo += CHUNK) {
    const hi = lo + CHUNK - 1;
    const nat = runInNative(bin, SWEEP_PROBE, { input: { lo, hi, templates: T }, timeoutMs: 1200000 });
    if (!Array.isArray(nat) || nat.length !== CHUNK * T.length) {
      throw new Error(`native answered ${Array.isArray(nat) ? nat.length : 'nothing'} sweep hashes for plane ${lo >> 16}, expected ${CHUNK * T.length}`);
    }
    let k = 0;
    for (let cp = lo; cp <= hi; cp++) {
      const x = (cp >= 0xd800 && cp <= 0xdfff) ? String.fromCharCode(cp) : String.fromCodePoint(cp);
      for (const t of TS) {
        const s = t.pre + x + t.post;
        const h = nat[k++];
        r.examined++;
        if (escapeLayer(s)) { r.escapeLayer++; continue; }
        const o = ourCells(s, t.narrow);
        if (sig(o) !== h) {
          r.bunCell++;
          if (r.findings.length < SHOW) {
            const n = runInNative(bin, CORPUS_PROBE, { input: [s] })[0][t.narrow ? 0 : 1];
            r.findings.push(`bun-cell ${t.narrow ? 'narrow' : 'wide'} ${hex(s)}: native ${fmtCells(n)} ours ${fmtCells(o)}`);
          }
        }
      }
    }
  }
  return r;
}

async function main(argv, env = process.env) {
  const o = { corpora: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--native') o.native = argv[++i];
    else if (argv[i] === '--corpus') o.corpora.push(argv[++i]);
    else { process.stderr.write(`cell-profile-diff: unknown argument ${argv[i]}\n`); return 2; }
  }
  if (!o.native) { process.stderr.write('usage: cell-profile-diff.cjs --native BIN [--corpus NAME]...\n'); return 2; }
  const unknown = o.corpora.filter((c) => !CORPORA.includes(c));
  if (unknown.length) { process.stderr.write(`cell-profile-diff: unknown corpus ${unknown.join(', ')} (known: ${CORPORA.join(', ')})\n`); return 2; }
  const corpora = o.corpora.length ? o.corpora : CORPORA;
  const opts = { cacheDir: path.join(clodeCacheDir(env), 'unicode'), offline: env.CLODE_OFFLINE === '1' };
  const width = U.UNICODE_DATA.header.unicode; const cell = U.UNICODE_DATA.header.cell.unicode;
  const results = [];
  try {
    // The tables were generated from one native (ruling R11); another one is a different
    // oracle, so say which is which up front rather than let its differences read as ours.
    if (!fs.existsSync(o.native)) throw new Error(`native claude ${o.native} does not exist`);
    const v = nativeVersion(o.native);
    const from = U.UNICODE_DATA.header.nativeClaude;
    process.stdout.write(`native ${v}; libexec/unicode-text.cjs was generated from ${from}${v === from ? '' : ' -- A DIFFERENT NATIVE: differences below may be the version, not a bug'}\n`);
    for (const name of corpora) {
      if (name === 'sweep') { results.push(sweep(o.native)); continue; }
      let strings; let cases = null;
      if (name === 'gbt' || name === 'gbt-cell') {
        cases = C.graphemeBreakTestCases(await ucd.fetchVerified(name === 'gbt' ? width : cell, 'GraphemeBreakTest', opts));
        strings = cases.map((c) => c.s);
        if (name === 'gbt-cell') cases = null;   // Unicode's answers there are 16.0's, not uax29's
      } else if (name === 'emoji-test') strings = C.corpusEmojiTest(await ucd.fetchVerified(width, 'emoji-test', opts));
      else if (name === 'composed') strings = C.corpusComposed();
      else strings = C.corpusCellProbes();
      if (!strings.length) throw new Error(`corpus ${name} is empty`);
      results.push(compareStrings(name, strings, runInNative(o.native, CORPUS_PROBE, { input: strings, timeoutMs: 600000 }), cases));
    }
  } catch (e) {
    process.stderr.write(`cell-profile-diff: ${e && e.message ? e.message : e}\n`);
    return 2;
  }
  let differs = false;
  for (const r of results) {
    const parts = [`bun-cell=${r.bunCell}`];
    if (r.uax29 !== null) parts.push(`uax29-vs-Intl=${r.uax29}`);
    if (r.gbt) parts.push(`uax29-vs-GraphemeBreakTest ${r.gbt.lines - r.gbt.bad}/${r.gbt.lines}`);
    if (r.escapeLayer) parts.push(`escape-layer (not compared for bun-cell)=${r.escapeLayer}`);
    process.stdout.write(`${r.name}: examined ${r.examined}, ${parts.join(' ')}\n`);
    for (const f of r.findings) process.stdout.write(`  ${f}\n`);
    if (r.bunCell || r.uax29 || (r.gbt && r.gbt.bad)) differs = true;
  }
  return differs ? 1 : 0;
}

module.exports = { ourCells, dropLoneSurrogates, escapeLayer, main };

if (require.main === module) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { process.stderr.write(`cell-profile-diff: ${e && e.message ? e.message : e}\n`); process.exit(2); });
}
