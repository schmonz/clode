'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { compareTextResults, runNative, runOurs, asciiJson, PROBE_SOURCE } = require('../scripts/lib/text-probe.cjs');
const { corpusCodePoints, corpusComposed, corpusEmojiTest, corpusGraphemeBreakTest } =
  require('../scripts/lib/text-corpus.cjs');

test('identical results compare clean, and examined counts every string', () => {
  const r = { segmenter: [[['a', 1, 0]]], stringWidth: [[1, 1]], intl: [['a']] };
  const d = compareTextResults(['a'], r, JSON.parse(JSON.stringify(r)));
  assert.deepStrictEqual(d.findings, []);
  assert.strictEqual(d.examined, 1);
});

test('a width difference, a split cluster and an Intl difference are each named', () => {
  const s = ['中'];
  const n = { segmenter: [[['中', 2, 0]]], stringWidth: [[2, 2]], intl: [['中']] };
  const o = { segmenter: [[['中', 1, 0]]], stringWidth: [[1, 1]], intl: [['中', '']] };
  const d = compareTextResults(s, n, o);
  // sliceAnsi is null: absent from native's answer, so not compared.
  assert.deepStrictEqual(d.counts, { segmenter: 1, stringWidth: 1, intl: 1, sliceAnsi: null });
  assert.match(d.findings[0], /^segmenter U\+4E2D: native/);
});

test('a sliceAnsi difference is counted and named like the other consumers', () => {
  const n = { sliceAnsi: [['a', '', '\x1b[1ma\x1b[22m']] };
  const d = compareTextResults(['a'], n, { sliceAnsi: [['a', 'a', '\x1b[1ma\x1b[22m']] });
  assert.deepStrictEqual(d.counts, { segmenter: null, stringWidth: null, intl: null, sliceAnsi: 1 });
  assert.match(d.findings[0], /^sliceAnsi U\+0061: native/);
  assert.deepStrictEqual(compareTextResults(['a'], n, JSON.parse(JSON.stringify(n))).counts.sliceAnsi, 0);
});

// The probe program itself, run against a Bun that lacks a member: that consumer answers
// null (so compareTextResults does not compare it), and the others still answer. Before
// task 8 only the segmenter was availability-checked, so a native without Bun.sliceAnsi
// threw out of the whole program and took the other three consumers with it.
test('PROBE_SOURCE answers null for a consumer the runtime lacks, and the rest still answer', () => {
  const run = new Function('input', 'Bun', PROBE_SOURCE);
  const bunWithout = { version: '0.0.0-test', stringWidth: (s) => s.length };
  const r = run({ strings: ['ab'], wants: { segmenter: true, stringWidth: true, sliceAnsi: true }, side: 'native' }, bunWithout);
  assert.strictEqual(r.sliceAnsi, null, 'no Bun.sliceAnsi -> not compared');
  assert.strictEqual(r.segmenter, null, 'no Bun.ant.CellSegmenter -> not compared');
  assert.deepStrictEqual(r.stringWidth, [[2, 2]], 'a consumer the runtime has still answers');
  const bunWith = { ...bunWithout, sliceAnsi: (s, a, b) => s.slice(a, b) };
  assert.strictEqual(run({ strings: ['ab'], wants: { sliceAnsi: true }, side: 'native' }, bunWith).sliceAnsi.length, 1);
});

// The segmenter row carries each cell's style the way the bundle's ansiCodes() reads it:
// run index 0 is no style, a key the bundle's SC regex refuses (a colon form here) is not
// painted and so not compared, and every kept code travels with its close code. A fake
// CellSegmenter, so this runs anywhere: three cells in three runs.
test('PROBE_SOURCE gives each segmenter cell the style the caller paints, SC-filtered, close codes kept', () => {
  const E = String.fromCharCode(27), NUL = String.fromCharCode(0);
  class Seg {
    constructor() {
      this.graphemes = ['a', 'b', 'c'];
      this.sgrKeys = ['', [E + '[1m', E + '[4:3m', E + '[31m'].join(NUL), E + '[5m'];
      this.sgrCloseKeys = ['', [E + '[22m', E + '[24m', E + '[39m'].join(NUL), E + '[25m'];
    }
    segment(s, cells, runs) {
      for (let i = 0; i < 3; i++) { cells[2 * i] = i; cells[2 * i + 1] = 1 | (i << 10); runs[2 * i] = i; runs[2 * i + 1] = 0; }
      return 3;
    }
  }
  const run = new Function('input', 'Bun', PROBE_SOURCE);
  const r = run({ strings: ['abc'], wants: { segmenter: true }, side: 'native' }, { version: 't', ant: { CellSegmenter: Seg } });
  assert.deepStrictEqual(r.segmenter, [[
    ['a', 1, 0, []],
    ['b', 1, 0, [[E + '[1m', E + '[22m'], [E + '[31m', E + '[39m']]],
    ['c', 1, 0, [[E + '[5m', E + '[25m']]],
  ]]);
});

test('a consumer native lacks (segmenter null) is NOT compared and says so', () => {
  const d = compareTextResults(['a'], { segmenter: null, stringWidth: [[1, 1]], intl: [['a']] },
    { segmenter: [[['a', 1, 0]]], stringWidth: [[1, 1]], intl: [['a']] });
  assert.strictEqual(d.counts.segmenter, null);
});

test('the code point corpus is exactly 0x110000 strings, lone surrogates included', () => {
  const c = corpusCodePoints();
  assert.strictEqual(c.length, 0x110000);
  assert.strictEqual(c[0xd800], '\ud800');
  assert.strictEqual(c[0x1f600], '\u{1f600}');
});

test('the composed corpus holds the cases a single code point cannot', () => {
  const c = corpusComposed();
  // Built from code points: the precomposed U+00E9 / U+1E3F these once were (an editing
  // tool normalised the typed escapes) are single code points, not the sequences meant.
  assert.ok(c.includes(String.fromCodePoint(0x65, 0x301)), 'a base and its combining mark');
  assert.ok(c.includes('a\u202eb\u0301'), 'a bidi control inside a would-be cluster');
  assert.ok(c.includes('e\x1b[1m' + String.fromCodePoint(0x301)), 'an escape inside a would-be cluster');
  assert.ok(c.includes(String.fromCodePoint(0x1100, 0x1161, 0x11a8)), 'Hangul L V T as conjoining jamo');
});

// The refusal happens before any spawn (native or tjs), so this needs neither a real
// native binary nor a tjs engine — a nonsense bin path proves the empty check fires first.
test('runNative and runOurs refuse an empty corpus before spawning anything', () => {
  assert.throws(() => runNative('/no/such/claude', [], { segmenter: true }),
    /empty corpus: nothing to compare/);
  assert.throws(() => runOurs([], { segmenter: true }),
    /empty corpus: nothing to compare/);
});

test('GraphemeBreakTest and emoji-test parsers read the published formats', () => {
  const gbt = '÷ 0020 × 0308 ÷\t#  comment\n# header\n÷ 1F1E6 × 1F1E7 ÷ 1F1E8 ÷\t# RI\n';
  assert.deepStrictEqual(corpusGraphemeBreakTest(gbt), [' \u0308', '\u{1f1e6}\u{1f1e7}\u{1f1e8}']);
  const et = '# group: Smileys\n1F600                  ; fully-qualified     # 😀 E1.0 grinning face\n'
    + '2764 FE0F              ; fully-qualified     # ❤️ E0.6 red heart\n';
  assert.deepStrictEqual(corpusEmojiTest(et), ['\u{1f600}', '❤️']);
});

// The tjs side's input must survive node-shim's fs.readFileSync(f, 'utf8'), whose engine
// TextDecoder drops every U+FEFF (measured 2026-09-24); an all-ASCII file cannot lose one.
test('asciiJson writes pure ASCII that parses back to exactly the same strings', () => {
  const H = (...cps) => cps.map((c) => ((c >= 0xd800 && c <= 0xdfff) ? String.fromCharCode(c) : String.fromCodePoint(c))).join('');
  const v = { strings: [H(0x61, 0xfeff, 0x62), H(0xfeff), H(0xd83d), H(0x1f600), H(0x301), H(0x7f, 0x80), ''] };
  const j = asciiJson(v);
  assert.ok(!/[^\x00-\x7f]/.test(j), `not ASCII: ${j}`);
  assert.deepStrictEqual(JSON.parse(j), v);
});
