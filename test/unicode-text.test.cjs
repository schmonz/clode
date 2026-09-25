'use strict';
// UAX #29 conformance against Unicode's OWN GraphemeBreakTest.txt, at the version the
// generated data was built from. Pure: no native, no tjs. The native differential
// (test/fidelity/text-differential.test.cjs) is the other half.
//
// The corpus is a pinned UCD input, never vendored (scripts/lib/ucd.cjs). Offline with a
// cold cache (test/run.mjs is offline by default) this run cannot look, which is a
// missing precondition rather than a wrong clustering, so it SKIPS naming the file
// (ruling R17). Only that one condition skips: a sha256 mismatch or a missing pin is a
// broken input and fails.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { graphemeBoundaries, clusterWidth, codePointWidth, escapeLayer, forEachCell, textWidth, stringWidth, sliceAnsi, UNICODE_DATA } =
  require('../libexec/unicode-text.cjs');
const { clodeCacheDir } = require('../libexec/clode-paths.cjs');
const ucd = require('../scripts/lib/ucd.cjs');

async function breakTest(t) {
  const ver = UNICODE_DATA.header.unicode;
  // The tables and the corpus must be the same release's: a pin moved without a
  // regeneration would test the rules against a corpus the data never saw.
  assert.strictEqual(ucd.pins()[ver].GraphemeBreakTest.sha256, UNICODE_DATA.header.ucdSha256.GraphemeBreakTest,
    `scripts/unicode-inputs.json pins a different GraphemeBreakTest ${ver} than the generated header names`);
  try {
    return await ucd.fetchVerified(ver, 'GraphemeBreakTest', {
      cacheDir: path.join(clodeCacheDir(process.env), 'unicode'),
      offline: process.env.CLODE_OFFLINE === '1',
    });
  } catch (e) {
    if (!(e instanceof ucd.UcdOfflineMiss)) throw e;
    t.skip(`GraphemeBreakTest ${ver} not cached and this run is offline — ${e.message}`);
    return null;
  }
}

// `÷ 0020 × 0308 ÷ 0020 ÷` -> the string and the code-unit offset of every cluster END.
function parseLine(body) {
  let s = ''; const want = [];
  for (const tok of body.split(/\s+/)) {
    if (tok === '÷') { if (s.length) want.push(s.length); } else if (tok !== '×') s += String.fromCodePoint(parseInt(tok, 16));
  }
  return { s, want };
}

test('every GraphemeBreakTest line breaks exactly where Unicode says', async (t) => {
  const text = await breakTest(t);
  if (text === null) return;
  let n = 0; const bad = [];
  for (const line of text.split('\n')) {
    const body = line.split('#')[0].trim();
    if (!body) continue;
    const { s, want } = parseLine(body);
    n++;
    const got = graphemeBoundaries(s);
    if (JSON.stringify(got) !== JSON.stringify(want)) { bad.push(`${line.trim()}\n  -> got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); continue; }
    // The same line inside a longer string, bounded by start/end: start must act as sot
    // and end as eot (GB1/GB2), whatever surrounds them. LF on both sides, because GB4/GB5
    // break around it unconditionally, so the padding cannot join the line.
    const got2 = graphemeBoundaries(`\n${s}\n`, 1, 1 + s.length);
    const want2 = want.map((x) => x + 1);
    if (JSON.stringify(got2) !== JSON.stringify(want2)) bad.push(`${line.trim()}\n  -> at [1, ${1 + s.length}) got ${JSON.stringify(got2)} want ${JSON.stringify(want2)}`);
  }
  // The corpus states its own size, so a parse that drops lines cannot pass by testing
  // fewer. (A floor would not do: 17.0.0 has 766 lines where 15.1.0 had 1187.)
  const declared = text.match(/^# Lines: (\d+)$/m);
  assert.ok(declared, 'GraphemeBreakTest has no "# Lines: N" footer — the corpus is truncated');
  assert.strictEqual(n, Number(declared[1]), `parsed ${n} test lines but the corpus declares ${declared[1]}`);
  assert.deepStrictEqual(bad.slice(0, 20), [], `${bad.length} of ${n} lines break wrongly`);
});

test('start acts as sot and end as eot; a surrogate pair is one code point', () => {
  assert.deepStrictEqual(graphemeBoundaries(''), []);
  assert.deepStrictEqual(graphemeBoundaries('abc', 2, 2), [], 'an empty range has no clusters');
  assert.deepStrictEqual(graphemeBoundaries('e\u0301\u4e2d'), [2, 3]);
  assert.deepStrictEqual(graphemeBoundaries('ab\u{1f44d}\u{1f3fd}c'), [1, 2, 6, 7], 'a surrogate pair is one code point');
  assert.deepStrictEqual(graphemeBoundaries('\r\n\r\n'), [2, 4], 'GB3: CR LF is one cluster');
  // Four RIs are two flags; starting at the second RI the first is invisible, so the
  // pairing restarts there (GB12 counts from sot, and start IS sot).
  const flags = '\u{1f1fa}\u{1f1f8}\u{1f1fa}\u{1f1f8}';
  assert.deepStrictEqual(graphemeBoundaries(flags), [4, 8]);
  assert.deepStrictEqual(graphemeBoundaries(flags, 2), [6, 8]);
});

test('an end that splits a surrogate pair never reads past end', () => {
  // U+101FD is a supplementary GCB=Extend: whole, it joins the 'a' before it (GB9). Cut by
  // end, the high surrogate left in range is a lone code unit (GCB Other in the table) and
  // must not borrow the low surrogate the caller excluded.
  const s = 'a\u{101fd}b';
  assert.deepStrictEqual(graphemeBoundaries(s, 0, s.length), [3, 4]);
  assert.deepStrictEqual(graphemeBoundaries(s, 0, 2), [1, 2]);
  // clusterWidth reads the cluster's first code point and then the rest; cut each by end.
  // A lone surrogate's own width is the table's 0 (native gives it no cell).
  assert.strictEqual(codePointWidth(0xd83d), 0);
  assert.strictEqual(clusterWidth('\u{1f600}', 0, 2), 2);
  assert.strictEqual(clusterWidth('\u{1f600}', 0, 1), 0, 'half an emoji is not the emoji');
  assert.strictEqual(clusterWidth('a\u{1f3fb}', 0, 3), 2, 'a whole emoji modifier widens');
  assert.strictEqual(clusterWidth('a\u{1f3fb}', 0, 2), 1, 'half of one does not');
});

test('cluster widths native measured on 2026-09-24', () => {
  const w = (s) => clusterWidth(s, 0, s.length, true);
  assert.strictEqual(w('a'), 1);
  assert.strictEqual(w('e\u0301'), 1);
  assert.strictEqual(w('\u4e2d'), 2);
  assert.strictEqual(w('\u{1f44d}\u{1f3fd}'), 2);
  assert.strictEqual(w('\u{1f1fa}\u{1f1f8}'), 2);
  assert.strictEqual(w('\u2764\ufe0f'), 2);
  assert.strictEqual(w('\u00b7'), 1);
  assert.strictEqual(clusterWidth('\u00b7', 0, 1, false), 2, 'ambiguous is wide when asked');
  // A cluster in the middle of a string is measured by its own bounds, not the string's.
  assert.strictEqual(clusterWidth('a\u4e2db', 1, 2), 2);
});

test('code point widths come from the generated table', () => {
  assert.strictEqual(codePointWidth(0x61), 1, 'absent from the table = 1');
  assert.strictEqual(codePointWidth(0x4e2d), 2);
  assert.strictEqual(codePointWidth(0x301), 0, 'a lone combining mark produces no cell');
  // Measured 2026-09-24: native gives a Regional Indicator width 1 ALONE, U+20E3 width 2.
  assert.strictEqual(codePointWidth(0x1f1fa), 1);
  assert.strictEqual(codePointWidth(0x20e3), 2);
  assert.strictEqual(codePointWidth(0xb7), 1);
  assert.strictEqual(codePointWidth(0xb7, false), 2);
  assert.strictEqual(codePointWidth(0x4e2d, false), 2, 'wide is wide either way');
});

// ---------------------------------------------------------------------------------------
// The `bun-cell` profile: native Bun.ant.CellSegmenter's own clusterer, which is NOT UAX #29
// 17.0.0 (that is native Intl.Segmenter, the `uax29` profile above). Every literal below was
// measured against native 2.1.278 (Bun 1.4.3) on 2026-09-24 — CellSegmenter's cells read
// back through its `graphemes` pool — and each test pins ONE named delta
// (libexec/unicode-text.cjs names them; scripts/cell-profile-diff.cjs is the instrument).
const B = (s, profile) => graphemeBoundaries(s, 0, s.length, profile);
const W = (s, profile, narrow = true) => clusterWidth(s, 0, s.length, narrow, profile);

test('profiles: uax29 is the default, bun-cell is opt-in, an unknown profile throws', () => {
  assert.throws(() => graphemeBoundaries('ab', 0, 2, 'bun'), /unknown text profile "bun"/);
  assert.throws(() => clusterWidth('ab', 0, 1, true, 'Bun-Cell'), /unknown text profile "Bun-Cell"/);
  assert.throws(() => graphemeBoundaries('ab', 0, 2, 'toString'), /unknown text profile/, 'an inherited name is not a profile');
  const s = '\u1019\u1039\u1018';
  assert.deepStrictEqual(graphemeBoundaries(s), B(s, 'uax29'), 'uax29 is the default');
  assert.strictEqual(clusterWidth('\u1100\u1100', 0, 2), 2, 'uax29 keeps its 0|1|2 contract');
});

test('bun-cell CLUSTER-DATA-16 (InCB): the scripts Unicode 17.0 added to InCB get no GB9c join', () => {
  // native: [1019 1039] [1018] [102C 1037]; Unicode 17.0 (uax29): [1019 1039 1018] [102C 1037]
  assert.deepStrictEqual(B('\u1019\u1039\u1018\u102c\u1037', 'bun-cell'), [2, 3, 5]);
  assert.deepStrictEqual(B('\u1019\u1039\u1018\u102c\u1037', 'uax29'), [3, 5]);
  // native: [17A0 17D2] [17AB] [1791 17D0] [1799]
  assert.deepStrictEqual(B('\u17a0\u17d2\u17ab\u1791\u17d0\u1799', 'bun-cell'), [2, 3, 5, 6]);
  // Devanagari was InCB before 17.0, so it still joins: native [0915 094D 0937]=2.
  assert.deepStrictEqual(B('\u0915\u094d\u0937', 'bun-cell'), [3]);
});

test('bun-cell CLUSTER-DATA-16 (ExtPict): U+2701 is still pictographic, so 2701 ZWJ 2701 is one cluster', () => {
  // Unicode 17.0 dropped U+2701 from Extended_Pictographic; native: [2701 200D 2701]=2.
  assert.deepStrictEqual(B('\u2701\u200d\u2701', 'bun-cell'), [3]);
  assert.deepStrictEqual(B('\u2701\u200d\u2701', 'uax29'), [2, 3]);
});

test('bun-cell CLUSTER-DATA-16 (GCB): U+1ACF, Extend only since Unicode 17.0, does not join', () => {
  // native: 'a' U+1ACF 'b' -> [0061]=1 [0062]=1 (U+1ACF a zero-width cluster of its own).
  assert.deepStrictEqual(B('a\u1acfb', 'bun-cell'), [1, 2, 3]);
  assert.deepStrictEqual(B('a\u1acfb', 'uax29'), [2, 3]);
});

test('bun-cell MODIFIER-NEEDS-BASE: an emoji modifier joins only an Emoji_Modifier_Base or a Prepend', () => {
  // native: [0061]=1 [1F3FF]=2 [1F476]=2; uax29 (GB9, Extend): [0061 1F3FF] [1F476]
  assert.deepStrictEqual(B('a\u{1f3ff}\u{1f476}', 'bun-cell'), [1, 3, 5]);
  assert.deepStrictEqual(B('a\u{1f3ff}\u{1f476}', 'uax29'), [3, 5]);
  assert.deepStrictEqual(B('\u{1f476}\u{1f3ff}', 'bun-cell'), [4], 'native [1F476 1F3FF]=2');
  assert.deepStrictEqual(B('\u0600\u{1f3fb}', 'bun-cell'), [3], 'native [0600 1F3FB]=2: GB9b first');
  // The IMMEDIATELY preceding code point: native [1F476 0308]=2 [1F3FB]=2, [1F476 1F3FB]=2 [1F3FB]=2.
  assert.deepStrictEqual(B('\u{1f476}\u0308\u{1f3fb}', 'bun-cell'), [3, 5]);
  assert.deepStrictEqual(B('\u{1f476}\u{1f3fb}\u{1f3fb}', 'bun-cell'), [4, 6]);
});

test('bun-cell CLUSTER-STATE-RESTARTS: a break inside a GB9c or GB11 pattern starts both lookbehinds afresh', () => {
  // Only MODIFIER-NEEDS-BASE can break there. native: [0915 094D]=1 [1F3FB]=2 [0915]=1 —
  // the consonant after the lone modifier does not join through it (GB9c restarted).
  assert.deepStrictEqual(B(String.fromCodePoint(0x915, 0x94d, 0x1f3fb, 0x915), 'bun-cell'), [2, 4, 5]);
  // native: [0915 094D]=1 [1F3FB 094D]=2 [0915]=1
  assert.deepStrictEqual(B(String.fromCodePoint(0x915, 0x94d, 0x1f3fb, 0x94d, 0x915), 'bun-cell'), [2, 5, 6]);
  // native: [1F600]=2 [1F3FB 200D]=2 [1F600]=2 — the ZWJ is not after a pictograph of ITS cluster (GB11).
  assert.deepStrictEqual(B(String.fromCodePoint(0x1f600, 0x1f3fb, 0x200d, 0x1f600), 'bun-cell'), [2, 5, 7]);
});

test('bun-cell CC-CONTROLS-ONLY: GB4/GB5 hold for Cc; every other GCB=Control code point is Other', () => {
  // native: [200B 0308 0903]=1; uax29: [200B] [0308 0903]
  assert.deepStrictEqual(B('\u200b\u0308\u0903', 'bun-cell'), [3]);
  assert.deepStrictEqual(B('\u200b\u0308\u0903', 'uax29'), [1, 3]);
  // native: [0890 200B]=1 [2764 FE0F]=2 — Prepend x U+200B (GB9b), where uax29 breaks (GB5).
  assert.deepStrictEqual(B('\u0890\u200b\u2764\ufe0f', 'bun-cell'), [2, 4]);
  // A Cc is still a control: native [0061]=1 [0308 0903]=1.
  assert.deepStrictEqual(B('a\u0001\u0308\u0903', 'bun-cell'), [1, 2, 4]);
});

test('bun-cell WIDTH-SUM: a cluster is the UNCAPPED sum of its code points, so 3 and 4 happen', () => {
  assert.strictEqual(W('\u0915\u094d\u0937\u094d\u092e', 'bun-cell'), 3);
  assert.strictEqual(W('\u0915\u094d\u0937\u094d\u092e\u094d\u092f', 'bun-cell'), 4);
  assert.strictEqual(W('\u1100\u1100', 'bun-cell'), 4);
  assert.strictEqual(W('\u1100\u1100\u1161', 'bun-cell'), 4);
  assert.strictEqual(W('\u0915\u094d\u0937', 'bun-cell'), 2);
  assert.strictEqual(W('\u0600a', 'bun-cell'), 1, 'a zero-width lead takes the width that follows');
  assert.strictEqual(W('\u0308\u0903', 'bun-cell'), 1);
  assert.strictEqual(W('\u0890\u{1f476}\u{1f3fb}', 'bun-cell'), 5, 'a Prepend base is not an emoji base');
});

test('bun-cell WIDTH-RI: a cluster of two or more code points holding a Regional Indicator is 2', () => {
  assert.strictEqual(W('\u06dd\u{1f1e6}', 'bun-cell'), 2);
  assert.strictEqual(W('\u{1f1e6}\u0308', 'bun-cell'), 2);
  assert.strictEqual(W('\u{1f1e6}\u200d', 'bun-cell'), 2);
  assert.strictEqual(W('\u{1f1e6}', 'bun-cell'), 1, 'alone it is 1');
});

test('bun-cell WIDTH-KEYCAP: a cluster holding U+20E3 is 2', () => {
  assert.strictEqual(W('#\u20e3', 'bun-cell'), 2);
  assert.strictEqual(W('a\u20e3', 'bun-cell'), 2);
  assert.strictEqual(W('\u1100\u1100\u20e3', 'bun-cell'), 2, 'even over a sum of 6');
});

test('bun-cell WIDTH-EMOJI-BASE: an emoji base with a ZWJ or a modifier is 2, measured exceptions are not', () => {
  assert.strictEqual(W('\u2764\u200d\u{1f525}', 'bun-cell'), 2, 'sum 3');
  assert.strictEqual(W('\u{1f600}\u200d\u{1f600}', 'bun-cell'), 2, 'sum 4');
  assert.strictEqual(W('\u261d\u{1f3fb}', 'bun-cell'), 2, 'sum 3');
  assert.strictEqual(W('\u2122\u200d', 'bun-cell'), 2, 'sum 1');
  // The generator's measured override emoji-not-width-base: Emoji native does not treat
  // as a width base, so the plain sum stands.
  assert.strictEqual(W('\u00a9\u200d\u{1f600}', 'bun-cell'), 3);
  assert.strictEqual(W('\u00a9\u200d', 'bun-cell'), 1);
  assert.strictEqual(W('\u3030\u200d\u{1f600}', 'bun-cell'), 4);
});

test('bun-cell WIDTH-VS16: U+FE0F widens an Emoji Extended_Pictographic base to 2, nothing else', () => {
  assert.strictEqual(W('\u2764\ufe0f', 'bun-cell'), 2);
  assert.strictEqual(W('\u00a9\ufe0f', 'bun-cell'), 2);
  assert.strictEqual(W('a\ufe0f', 'bun-cell'), 1);
  assert.strictEqual(W('#\ufe0f', 'bun-cell'), 1);
});

test('bun-cell WIDTH-VS16: it widens the BASE to 2, and the rest of the cluster still counts', () => {
  // Found by fuzzing escape-heavy strings against native (task 6, 2026-09-24): a spacing mark
  // in the cluster keeps its column. native: 1F600 0903 FE0F = 3, 2764 0903 FE0F = 3,
  // 2764 0903 0903 FE0F = 4, 2764 FE0F 0903 = 3, 00A9 0903 FE0F = 3, 0600 2764 0903 FE0F = 3.
  const w = (...cps) => W(String.fromCodePoint(...cps), 'bun-cell');
  assert.strictEqual(w(0x1f600, 0x903, 0xfe0f), 3);
  assert.strictEqual(w(0x2764, 0x903, 0xfe0f), 3);
  assert.strictEqual(w(0x2764, 0x903, 0x903, 0xfe0f), 4);
  assert.strictEqual(w(0x2764, 0xfe0f, 0x903), 3);
  assert.strictEqual(w(0xa9, 0x903, 0xfe0f), 3);
  assert.strictEqual(w(0x600, 0x2764, 0x903, 0xfe0f), 3);
  // Not an Emoji Extended_Pictographic base: the plain sum. native: 0023 0903 FE0F = 2.
  assert.strictEqual(w(0x23, 0x903, 0xfe0f), 2);
  // The exactly-2 rules still win. native: 1F1E6 0903 FE0F = 2, 1F600 0903 20E3 = 2.
  assert.strictEqual(w(0x1f1e6, 0x903, 0xfe0f), 2);
  assert.strictEqual(w(0x1f600, 0x903, 0x20e3), 2);
});

test('bun-cell WIDTH-BASE-IS-FIRST-VISIBLE: the base is the first code point of nonzero width', () => {
  assert.strictEqual(W('\u0600\u2764\u200d\u{1f600}', 'bun-cell'), 2, 'U+0600 is zero-width, so U+2764 is the base');
  assert.strictEqual(W('\u0890\u2764\u200d\u{1f600}', 'bun-cell'), 4, 'U+0890 is 1 wide, so it is the base');
  assert.strictEqual(W('\u0600\u2764\ufe0f', 'bun-cell'), 2);
});

test('bun-cell LONE-SURROGATES-INVISIBLE: a lone surrogate neither breaks nor counts', () => {
  // native: [0061 0308]=1 (the surrogate is gone from the cell's text; the mark joins 'a').
  assert.deepStrictEqual(B('a\udc00\u0308', 'bun-cell'), [3]);
  assert.deepStrictEqual(B('a\udc00\u0308', 'uax29'), [1, 3]);
  assert.strictEqual(W('a\udc00\u0308', 'bun-cell'), 1);
  // native: [1F1E6]=1 — the surrogate does not make the RI a two-code-point cluster.
  assert.strictEqual(W('\u{1f1e6}\udc00', 'bun-cell'), 1);
  // native: [2764 FE0F]=2 — nor is it the cluster's base.
  assert.deepStrictEqual(B('\udc00\u2764\ufe0f', 'bun-cell'), [3]);
  assert.strictEqual(W('\udc00\u2764\ufe0f', 'bun-cell'), 2);
  // Only the surrogate is invisible: native [0061]=1 [0062]=1 for 'a' U+DC00 'b'.
  assert.deepStrictEqual(B('a\udc00b', 'bun-cell'), [2, 3]);
});

// ---------------------------------------------------------------------------------------
// The layers native runs AROUND the bun-cell clusterer: the escape layer CellSegmenter and
// Bun.stringWidth share, and the cell shaping CellSegmenter adds. Every literal below was
// measured against native 2.1.278 (Bun 1.4.3) on 2026-09-24 (CellSegmenter's cells read back
// through its pool; Bun.stringWidth), and each test pins ONE rule libexec/unicode-text.cjs
// names. Strings are built from code points, never typed as escapes (an editing tool turned
// typed escapes into the literal characters; see test/source-invisible-chars.test.cjs).
// test/fidelity/text-differential.test.cjs walks every parser state against native.
const H = (...cps) => cps.map((c) => ((c >= 0xd800 && c <= 0xdfff) ? String.fromCharCode(c) : String.fromCodePoint(c))).join('');
const CPS = (s) => Array.from(s, (c) => c.codePointAt(0));
const ESC = 0x1b;
const T = (...cps) => escapeLayer(H(...cps)).text;
// The SGR parameter strings a string applies: CSIs that END at `m` without being ignored.
const SGR = (...cps) => escapeLayer(H(...cps)).sequences
  .filter((q) => q.kind === 'csi' && q.final === 'm' && !q.ignored).map((q) => q.params);
const BIDI = [[0x61c, 0x61c], [0x202a, 0x202e], [0x2066, 0x2069]];   // the bundle's substitute ranges
function cellsOf(s, { narrow = true, substitute = [] } = {}) {
  const out = [];
  forEachCell(escapeLayer(s).text, narrow, substitute, (g, adv, tab) => out.push([CPS(g), tab ? 'tab' : adv]));
  return out;
}

test('ESCAPE-LAYER: after ESC a final ends it, intermediates take any ONE character, a second ESC restarts', () => {
  // native `a ESC 7 b` -> [a] [b]; `a ESC ( B b` -> [a] [b]
  assert.strictEqual(T(0x61, ESC, 0x37, 0x62), 'ab');
  assert.strictEqual(T(0x61, ESC, 0x28, 0x42, 0x62), 'ab');
  // native `a ESC SP TAB b c` -> [a] [b] [c] (no tab cell); `a ESC SP U+0301 b c` -> [a] [b] [c]
  assert.strictEqual(T(0x61, ESC, 0x20, 0x09, 0x62, 0x63), 'abc');
  assert.strictEqual(T(0x61, ESC, 0x20, 0x301, 0x62, 0x63), 'abc');
  // ONE intermediate: native `a ESC SP SP b c` -> [a] [b] [c], the second SP ended it
  assert.strictEqual(T(0x61, ESC, 0x20, 0x20, 0x62, 0x63), 'abc');
  // native `a ESC ESC b c` -> [a] [c]; `a ESC` -> [a]
  assert.strictEqual(T(0x61, ESC, ESC, 0x62, 0x63), 'ac');
  assert.strictEqual(T(0x61, ESC), 'a');
});

test('ESCAPE-LAYER: an ESC nothing valid follows is dropped ALONE and the next character read again', () => {
  // native `a ESC TAB b c` -> [a] [TAB] [b] [c]; `a ESC U+0301 b` -> [a U+0301] [b]; `a ESC U+4E2D b` -> [a] [4E2D]=2 [b]
  assert.strictEqual(T(0x61, ESC, 0x09, 0x62, 0x63), H(0x61, 0x09, 0x62, 0x63));
  assert.strictEqual(T(0x61, ESC, 0x301, 0x62), H(0x61, 0x301, 0x62));
  assert.strictEqual(T(0x61, ESC, 0x4e2d, 0x62), H(0x61, 0x4e2d, 0x62));
  // native `a ESC U+009B 1 m b` -> [a] [b], b bold: the C1 CSI takes over
  assert.strictEqual(T(0x61, ESC, 0x9b, 0x31, 0x6d, 0x62), 'ab');
  assert.deepStrictEqual(SGR(0x61, ESC, 0x9b, 0x31, 0x6d, 0x62), ['1']);
  // native `a ESC D83D [ 1 m b` -> [a] [5B] [31] [6D] [b]: a lone surrogate is "anything else" too
  assert.strictEqual(T(0x61, ESC, 0xd83d, 0x5b, 0x31, 0x6d, 0x62), 'a[1mb');
});

test('ESCAPE-LAYER: CSI runs to a final byte; a byte it cannot hold makes it IGNORED, not shorter', () => {
  // native `a ESC[1m b c` -> [a] [b] [c], b and c bold; `a U+009B 1 m b c` the same
  assert.strictEqual(T(0x61, ESC, 0x5b, 0x31, 0x6d, 0x62, 0x63), 'abc');
  assert.deepStrictEqual(SGR(0x61, ESC, 0x5b, 0x31, 0x6d, 0x62), ['1']);
  assert.deepStrictEqual(SGR(0x61, 0x9b, 0x31, 0x6d, 0x62, 0x63), ['1']);
  // native `a ESC[1 U+0301 m b` -> [a] [b], NOT bold; `a ESC[1 U+1E3F b` -> [a]: `b` was the final
  assert.strictEqual(T(0x61, ESC, 0x5b, 0x31, 0x301, 0x6d, 0x62), 'ab');
  assert.deepStrictEqual(SGR(0x61, ESC, 0x5b, 0x31, 0x301, 0x6d, 0x62), []);
  assert.strictEqual(T(0x61, ESC, 0x5b, 0x31, 0x1e3f, 0x62), 'a');
  // native `a ESC[1 TAB m b` -> [a] [b]: no tab cell, not bold
  assert.strictEqual(T(0x61, ESC, 0x5b, 0x31, 0x09, 0x6d, 0x62), 'ab');
  assert.deepStrictEqual(SGR(0x61, ESC, 0x5b, 0x31, 0x09, 0x6d, 0x62), []);
  // native `a ESC[1 ESC[2m b` -> [a] [b] dim: ESC abandons the first; `a U+009B 1 U+009C b` -> [a] [b]
  assert.deepStrictEqual(SGR(0x61, ESC, 0x5b, 0x31, ESC, 0x5b, 0x32, 0x6d, 0x62), ['2']);
  assert.strictEqual(T(0x61, 0x9b, 0x31, 0x9c, 0x62), 'ab');
  // native `a ESC[?1m b` -> [a] [b] not bold (the key is only ever `1` for a plain SGR)
  assert.deepStrictEqual(SGR(0x61, ESC, 0x5b, 0x3f, 0x31, 0x6d, 0x62), ['?1']);
  // native `a ESC[1` -> [a]: a sequence the string ends inside is removed to the end
  assert.strictEqual(T(0x61, ESC, 0x5b, 0x31), 'a');
});

test('ESCAPE-LAYER: OSC ends at BEL, U+009C or an ESC; DCS SOS PM APC do not end at BEL', () => {
  // native `a ESC]8;;x U+009C b` -> [a] [b]; `a U+009D 8;;x BEL b c` -> [a] [b] [c]
  assert.strictEqual(T(0x61, ESC, 0x5d, 0x38, 0x3b, 0x3b, 0x78, 0x9c, 0x62), 'ab');
  assert.strictEqual(T(0x61, 0x9d, 0x38, 0x3b, 0x3b, 0x78, 0x07, 0x62, 0x63), 'abc');
  // native `a ESC]0;t ESC[1m b` -> [a] [b] bold: the ESC ends the OSC and starts a CSI
  assert.deepStrictEqual(SGR(0x61, ESC, 0x5d, 0x30, 0x3b, 0x74, ESC, 0x5b, 0x31, 0x6d, 0x62), ['1']);
  // native `a U+009D x ESC b c` -> [a] [c]: that ESC and `b` are the next sequence
  assert.strictEqual(T(0x61, 0x9d, 0x78, ESC, 0x62, 0x63), 'ac');
  // native `a ESC P q ESC \ b` -> [a] [b]; `a U+009F x BEL b` -> [a]; `a ESC P q BEL b` -> [a]
  assert.strictEqual(T(0x61, ESC, 0x50, 0x71, ESC, 0x5c, 0x62), 'ab');
  assert.strictEqual(T(0x61, 0x9f, 0x78, 0x07, 0x62), 'a');
  assert.strictEqual(T(0x61, ESC, 0x50, 0x71, 0x07, 0x62), 'a');
  // Exactly ESC and the six C1 introducers start a sequence; every other control is text
  // (a cluster with no cell). native `a X b`: [a] [b] for each of the second list.
  for (const c of [0x1b, 0x90, 0x98, 0x9b, 0x9d, 0x9e, 0x9f]) assert.notStrictEqual(T(0x61, c, 0x62), H(0x61, c, 0x62), c.toString(16));
  for (const c of [0x07, 0x08, 0x0d, 0x7f, 0x85, 0x9a, 0x9c]) assert.strictEqual(T(0x61, c, 0x62), H(0x61, c, 0x62), c.toString(16));
});

test('ESCAPE-LAYER: lone surrogates leave the text too, judged on the string as given', () => {
  // native `D83D ESC[1m DE00 b` -> [b] bold: the halves a sequence separated do not pair up
  assert.strictEqual(T(0xd83d, ESC, 0x5b, 0x31, 0x6d, 0xde00, 0x62), 'b');
  // native `a DC00 U+0308` -> [a U+0308]
  assert.strictEqual(T(0x61, 0xdc00, 0x308), H(0x61, 0x308));
});

test('ESCAPE-SPANNED-CLUSTERS: a cluster runs straight across an escape sequence', () => {
  // native `e ESC[1m U+0301` -> [e U+0301]=1; `e ESC]8;;h BEL U+0301` -> [e U+0301]=1
  assert.deepStrictEqual(cellsOf(H(0x65, ESC, 0x5b, 0x31, 0x6d, 0x301)), [[[0x65, 0x301], 1]]);
  assert.deepStrictEqual(cellsOf(H(0x65, ESC, 0x5d, 0x38, 0x3b, 0x3b, 0x68, 0x07, 0x301)), [[[0x65, 0x301], 1]]);
  // native `1F600 200D ESC[1m 1F600` -> [1F600 200D 1F600]=2 and Bun.stringWidth 2 (not 4)
  const zwj = H(0x1f600, 0x200d, ESC, 0x5b, 0x31, 0x6d, 0x1f600);
  assert.deepStrictEqual(cellsOf(zwj), [[[0x1f600, 0x200d, 0x1f600], 2]]);
  assert.strictEqual(textWidth(escapeLayer(zwj).text), 2);
  // native `1F1E6 ESC[1m 1F1E7` -> one flag, [1F1E6 1F1E7]=2
  assert.deepStrictEqual(cellsOf(H(0x1f1e6, ESC, 0x5b, 0x31, 0x6d, 0x1f1e7)), [[[0x1f1e6, 0x1f1e7], 2]]);
  // A control is not an escape: native `e BEL U+0301` -> [e]
  assert.deepStrictEqual(cellsOf(H(0x65, 0x07, 0x301)), [[[0x65], 1]]);
});

test('CELL-TAB and CELL-ZERO-WIDTH: a tab is a cell of its own, any other zero-width cluster is none', () => {
  // native `a TAB b` -> [a]=1 [TAB]=0/tab [b]=1; `TAB U+0301` -> [TAB]; `a U+0085 b` -> [a] [b]
  assert.deepStrictEqual(cellsOf(H(0x61, 0x09, 0x62)), [[[0x61], 1], [[0x09], 'tab'], [[0x62], 1]]);
  assert.deepStrictEqual(cellsOf(H(0x09, 0x301)), [[[0x09], 'tab']]);
  assert.deepStrictEqual(cellsOf(H(0x61, 0x85, 0x62)), [[[0x61], 1], [[0x62], 1]]);
  // native U+0301 alone, U+200D alone -> no cells
  assert.deepStrictEqual(cellsOf(H(0x301)), []);
  assert.deepStrictEqual(cellsOf(H(0x200d)), []);
});

test('CELL-SATURATES: a cell advance is 8 bits and stops at 255; the width does not', () => {
  // native: 128 x U+1100 is ONE cell of 255 while Bun.stringWidth says 256; 200 x U+1100 also 255
  const s = H(...new Array(128).fill(0x1100));
  assert.deepStrictEqual(cellsOf(s).map(([, w]) => w), [255]);
  assert.strictEqual(textWidth(s), 256);
  assert.deepStrictEqual(cellsOf(H(...new Array(200).fill(0x1100))).map(([, w]) => w), [255]);
});

test('CELL-SUBSTITUTE: a substituted code point stands alone, as U+FFFD at U+FFFD\'s own width', () => {
  const FFFD = 0xfffd;
  const sub = (...cps) => cellsOf(H(...cps), { substitute: BIDI });
  // native, with the bundle's bidi ranges:
  assert.deepStrictEqual(sub(0x61, 0x202e, 0x903), [[[0x61], 1], [[FFFD], 1], [[0x903], 1]], 'a mark after it is not joined');
  assert.deepStrictEqual(sub(0x890, 0x202e), [[[0x890], 1], [[FFFD], 1]], 'a Prepend before it does not take it');
  assert.deepStrictEqual(sub(0x202e, 0x301), [[[FFFD], 1]]);
  assert.deepStrictEqual(sub(0x600, 0x202e), [[[FFFD], 1]]);
  assert.deepStrictEqual(sub(0x61, 0x202e, 0x62, 0x301), [[[0x61], 1], [[FFFD], 1], [[0x62, 0x301], 1]]);
  assert.deepStrictEqual(sub(0x2066, 0x78, 0x2069), [[[FFFD], 1], [[0x78], 1], [[FFFD], 1]]);
  // native with ambiguousIsNarrow false: U+202E -> [FFFD]=2 (U+FFFD is East Asian Ambiguous)
  assert.deepStrictEqual(cellsOf(H(0x202e), { narrow: false, substitute: BIDI }), [[[FFFD], 2]]);
  // No ranges, no substitution: U+202E is a zero-width cluster (native `a 202E b` with [] -> [a] [b]).
  assert.deepStrictEqual(cellsOf(H(0x61, 0x202e, 0x62)), [[[0x61], 1], [[0x62], 1]]);
});

test('BUN-STRINGWIDTH: the uncapped sum of bun-cell cluster widths over the escape layer\'s text', () => {
  const sw = (...cps) => textWidth(escapeLayer(H(...cps)).text);
  // native Bun.stringWidth: `a ESC[1 U+1E3F b` 1; `a ESC TAB b c` 3 (a tab is 0); `0600 202E` 0 (no substitution)
  assert.strictEqual(sw(0x61, ESC, 0x5b, 0x31, 0x1e3f, 0x62), 1);
  assert.strictEqual(sw(0x61, ESC, 0x09, 0x62, 0x63), 3);
  assert.strictEqual(sw(0x600, 0x202e), 0);
  // countAnsiEscapeCodes: the string as given (ESC is 0 wide): native `a ESC[1m b c` -> 6
  assert.strictEqual(textWidth(H(0x61, ESC, 0x5b, 0x31, 0x6d, 0x62, 0x63)), 6);
  assert.strictEqual(textWidth(H(0x00a1), false), 2, 'ambiguous is wide when asked');
});

test('BUN-STRINGWIDTH: stringWidth takes its arguments as native Bun.stringWidth does', () => {
  // native: () 0, (undefined) 0, (null) 4 ("null"), (123) 3, ({}) 15, ([1, 2]) 3; a Symbol throws
  assert.strictEqual(stringWidth(), 0);
  assert.strictEqual(stringWidth(undefined), 0);
  assert.strictEqual(stringWidth(null), 4);
  assert.strictEqual(stringWidth(123), 3);
  assert.strictEqual(stringWidth({}), 15);
  assert.strictEqual(stringWidth([1, 2]), 3);
  assert.throws(() => stringWidth(Symbol.iterator), TypeError);
  // native: `a U+00A1` is 2 by default, with {} and with ambiguousIsNarrow undefined; 3 with 0
  const amb = H(0x61, 0xa1);
  assert.strictEqual(stringWidth(amb), 2);
  assert.strictEqual(stringWidth(amb, {}), 2);
  assert.strictEqual(stringWidth(amb, { ambiguousIsNarrow: undefined }), 2);
  assert.strictEqual(stringWidth(amb, { ambiguousIsNarrow: 0 }), 3);
  assert.strictEqual(stringWidth(amb, null), 2);
  // native: `ESC[1m a` is 1, and 4 with countAnsiEscapeCodes: 1
  assert.strictEqual(stringWidth(H(ESC, 0x5b, 0x31, 0x6d, 0x61)), 1);
  assert.strictEqual(stringWidth(H(ESC, 0x5b, 0x31, 0x6d, 0x61), { countAnsiEscapeCodes: 1 }), 4);
});

test('ESCAPE-LAYER CANCEL: U+009C, CAN and SUB end any sequence they interrupt, and go with it', () => {
  // native `a U+009B CAN b c` -> [a] [b] [c]; `a U+0090 SUB b c` -> [a] [b] [c]; `a ESC] SUB b c` -> [a] [b] [c]
  assert.strictEqual(T(0x61, 0x9b, 0x18, 0x62, 0x63), 'abc');
  assert.strictEqual(T(0x61, 0x90, 0x1a, 0x62, 0x63), 'abc');
  assert.strictEqual(T(0x61, ESC, 0x5d, 0x1a, 0x62, 0x63), 'abc');
  // After a bare ESC they are consumed with it, so a mark still joins what came before:
  // native `a ESC CAN U+0301 b c` -> [a U+0301] [b] [c]; `a ESC U+009C U+0903` -> [a U+0903]=2
  assert.deepStrictEqual(cellsOf(H(0x61, ESC, 0x18, 0x301, 0x62, 0x63)), [[[0x61, 0x301], 1], [[0x62], 1], [[0x63], 1]]);
  assert.deepStrictEqual(cellsOf(H(0x61, ESC, 0x9c, 0x903)), [[[0x61, 0x903], 2]]);
  // Outside a sequence CAN is an ordinary control and breaks: native `a CAN U+0301` -> [a]
  assert.deepStrictEqual(cellsOf(H(0x61, 0x18, 0x301)), [[[0x61], 1]]);
});

// ---- Bun.sliceAnsi (the SLICE-* rules and the bun-slice profile's two deltas) ------------
// Every expected value below is native 2.1.278's own answer (Bun 1.4.3, measured 2026-09-25:
// each call was made in native and in ours, and the two agreed), written with ASCII escapes
// and code points so no editing tool can normalise it. The differential over whole corpora
// is test/fidelity/text-differential.test.cjs's text-diff-sliceansi.

test('bun-slice: bun-cell clusters, except that a Cc other than CR LF and a lone surrogate are Other', () => {
  // Measured through sliceAnsi below (SLICE-CONTROLS-JOIN, SLICE-SURROGATES-VISIBLE).
  assert.deepStrictEqual(B(H(0x890, 0x7, 0x78), 'bun-slice'), [2, 3]);
  assert.deepStrictEqual(B(H(0x890, 0x7, 0x78), 'bun-cell'), [1, 2, 3]);
  assert.deepStrictEqual(B(H(0x890, 0xd, 0x78), 'bun-slice'), [1, 2, 3]);
  assert.deepStrictEqual(B(H(0x2764, 0xdc00, 0xfe0f), 'bun-slice'), [1, 3]);
  assert.deepStrictEqual(B(H(0x2764, 0xdc00, 0xfe0f), 'bun-cell'), [3]);
  assert.deepStrictEqual(B(H(0x1f476, 0x1f3fb, 0x1f3fb), 'bun-slice'), B(H(0x1f476, 0x1f3fb, 0x1f3fb), 'bun-cell'));
});

test('SLICE-ARGUMENTS: an ellipsis with a width is refused, not answered differently from native', () => {
  // Native truncates with it ('uni.', 'un..'); the bundle never passes one, so it is not
  // implemented here.
  assert.throws(() => sliceAnsi('unicorn', 0, 4, '.'), /ellipsis option is not implemented/);
  assert.throws(() => sliceAnsi('unicorn', 0, 4, { ellipsis: '..' }), /ellipsis option is not implemented/);
  // Zero-width ellipses are no ellipsis at all, in native too: 'unicorn' (0, 4, '') is 'unic'.
  assert.strictEqual(sliceAnsi('unicorn', 0, 4, ''), 'unic');
});

test('SLICE-ARGUMENTS: columns count back from the total width when negative; indices are integers', () => {
  assert.strictEqual(sliceAnsi('hello', -2), 'lo');
  assert.strictEqual(sliceAnsi('hello', 1, -1), 'ell');
  assert.strictEqual(sliceAnsi('hello', -2, -1), 'l');
  assert.strictEqual(sliceAnsi(H(0x4e2d, 0x6587) + 'x', -3), H(0x6587) + 'x');
  assert.strictEqual(sliceAnsi(H(0x4e2d, 0x6587) + 'x', 0, -3), H(0x4e2d));
  assert.strictEqual(sliceAnsi('hello', 1.9), 'ello');
  assert.strictEqual(sliceAnsi('hello', -1.9), 'o');
  assert.strictEqual(sliceAnsi('hello', 'x'), 'hello');
  assert.strictEqual(sliceAnsi('hello', null, 2), 'he');
  assert.strictEqual(sliceAnsi('hello', 1, null), '');
  assert.strictEqual(sliceAnsi('hello', '1', '3'), 'el');
  assert.strictEqual(sliceAnsi('hello', -Infinity), 'hello');
  assert.strictEqual(sliceAnsi('hello', 0, -Infinity), '');
  assert.strictEqual(sliceAnsi('hello', Infinity), '');
});

test('SLICE-ARGUMENTS: the input is converted as a template literal converts it, and read before the indices', () => {
  assert.strictEqual(sliceAnsi(), 'undefined');
  assert.strictEqual(sliceAnsi(undefined), 'undefined');
  assert.strictEqual(sliceAnsi(null), 'null');
  assert.strictEqual(sliceAnsi(123, 1), '23');
  assert.strictEqual(sliceAnsi(true, 1, 3), 'ru');
  assert.strictEqual(sliceAnsi(['a', 'b'], 1), ',b');
  assert.throws(() => sliceAnsi(Symbol.iterator), TypeError);
  assert.throws(() => sliceAnsi('hello', Symbol.iterator), TypeError);
  assert.throws(() => sliceAnsi('hello', 1n), TypeError);
  assert.strictEqual(sliceAnsi('', Symbol.iterator), '');
});

test('SLICE-ARGUMENTS: ambiguousIsNarrow is true unless a boolean or an options object says otherwise', () => {
  assert.strictEqual(sliceAnsi(H(0xa1, 0xa1) + 'x', 0, 2), H(0xa1, 0xa1));
  assert.strictEqual(sliceAnsi(H(0xa1, 0xa1) + 'x', 0, 2, false), H(0xa1));
  assert.strictEqual(sliceAnsi(H(0xa1, 0xa1) + 'x', 0, 2, true), H(0xa1, 0xa1));
  assert.strictEqual(sliceAnsi(H(0xa1, 0xa1) + 'x', 0, 2, undefined, false), H(0xa1));
  assert.strictEqual(sliceAnsi(H(0xa1, 0xa1) + 'x', 0, 2, '', false), H(0xa1));
  assert.strictEqual(sliceAnsi(H(0xa1, 0xa1) + 'x', 0, 2, {ambiguousIsNarrow: false}), H(0xa1));
  assert.strictEqual(sliceAnsi(H(0xa1, 0xa1) + 'x', 0, 2, {ambiguousIsNarrow: 0}), H(0xa1));
  assert.strictEqual(sliceAnsi(H(0xa1, 0xa1) + 'x', 0, 2, {}), H(0xa1, 0xa1));
  assert.strictEqual(sliceAnsi(H(0xa1, 0xa1) + 'x', 0, 2, null, false), H(0xa1, 0xa1));
});

test('SLICE-IDENTITY: start 0 to the end returns the input as given; any other end normalises it', () => {
  assert.strictEqual(sliceAnsi('\x1b[1;31mab'), '\x1b[1;31mab');
  assert.strictEqual(sliceAnsi('\x1b[1;31mab', 0), '\x1b[1;31mab');
  assert.strictEqual(sliceAnsi('\x1b[1;31mab', 0, Infinity), '\x1b[1;31mab');
  assert.strictEqual(sliceAnsi('\x1b[1;31mab', 0, 100), '\x1b[1m\x1b[31mab\x1b[39m\x1b[22m');
  assert.strictEqual(sliceAnsi('\x1b[1;31mab', -2), '\x1b[1m\x1b[31mab\x1b[39m\x1b[22m');
  assert.strictEqual(sliceAnsi('a\x1b[2Kb', 0), 'a\x1b[2Kb');
  assert.strictEqual(sliceAnsi('a\x1b[2Kb', 0, 9), 'a\x1b[2Kb');
});

test('SLICE-COLUMNS: a cluster is in when the column it starts at is in [start, end)', () => {
  assert.strictEqual(sliceAnsi(H(0x4e2d, 0x6587) + 'x', 0, 1), H(0x4e2d));
  assert.strictEqual(sliceAnsi(H(0x4e2d, 0x6587) + 'x', 0, 3), H(0x4e2d, 0x6587));
  assert.strictEqual(sliceAnsi(H(0x4e2d, 0x6587) + 'x', 1, 3), H(0x6587));
  assert.strictEqual(sliceAnsi(H(0x4e2d, 0x6587) + 'x', 1), H(0x6587) + 'x');
  assert.strictEqual(sliceAnsi('a' + H(0x200b), 0, 1), 'a');
  assert.strictEqual(sliceAnsi('a' + H(0x200b), 1), H(0x200b));
  assert.strictEqual(sliceAnsi(H(0x200b) + 'a', 1), '');
  assert.strictEqual(sliceAnsi(H(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467) + 'ab', 0, 1), H(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467));
  assert.strictEqual(sliceAnsi(H(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467) + 'ab', 1), 'ab');
  assert.strictEqual(sliceAnsi(H(0x1100, 0x1100) + 'x', 3), 'x');
  assert.strictEqual(sliceAnsi(H(0x915, 0x94d, 0x937, 0x94d, 0x92e) + 'x', 3), 'x');
  assert.strictEqual(sliceAnsi('a' + H(0x1f3ff, 0x1f476), 1), H(0x1f3ff, 0x1f476));
  assert.strictEqual(sliceAnsi(H(0x1019, 0x1039, 0x1018) + 'x', 1), H(0x1018) + 'x');
  assert.strictEqual(sliceAnsi('e\x1b[1m' + H(0x301) + 'x', 0, 1), 'e\x1b[1m' + H(0x301) + '\x1b[22m');
  assert.strictEqual(sliceAnsi('e\x1b[1m' + H(0x301) + 'x', 1), '\x1b[1mx\x1b[22m');
  assert.strictEqual(sliceAnsi(H(0x1f600, 0x903, 0xfe0f) + 'x', 3), 'x');
});

test('bun-slice SLICE-CONTROLS-JOIN: only CR and LF break around themselves; a Prepend takes any other Cc', () => {
  assert.strictEqual(sliceAnsi(H(0x890) + '\x07x', 1), 'x');
  assert.strictEqual(sliceAnsi(H(0x890) + '\x09x', 1), 'x');
  assert.strictEqual(sliceAnsi(H(0x890) + '\x00x', 1), 'x');
  assert.strictEqual(sliceAnsi(H(0x890) + '\x85x', 1), 'x');
  assert.strictEqual(sliceAnsi(H(0x890) + '\x7fx', 1), 'x');
  assert.strictEqual(sliceAnsi(H(0x890) + '\x0dx', 1), '\x0dx');
  assert.strictEqual(sliceAnsi(H(0x890) + '\x0ax', 1), '\x0ax');
  assert.strictEqual(sliceAnsi('a\x07' + H(0x301) + 'b', 1), '\x07' + H(0x301) + 'b');
  assert.strictEqual(sliceAnsi('a\x07' + H(0x301) + 'b', 0, 2), 'a\x07' + H(0x301) + 'b');
});

test('bun-slice SLICE-SURROGATES-VISIBLE: a lone surrogate is a 0-wide code point of its own', () => {
  assert.strictEqual(sliceAnsi(H(0x2764, 0xdc00, 0xfe0f) + 'x', 1), H(0xdc00, 0xfe0f) + 'x');
  assert.strictEqual(sliceAnsi(H(0x890, 0xd800) + 'x', 1), 'x');
  assert.strictEqual(sliceAnsi('a' + H(0xd83d), 1), H(0xd83d));
  assert.strictEqual(sliceAnsi(H(0xd83d) + 'a', 0, 1), H(0xd83d) + 'a');
  assert.strictEqual(sliceAnsi(H(0xd83d) + 'a', 1), '');
  assert.strictEqual(sliceAnsi('a' + H(0xdc00, 0x308) + 'b', 1), H(0xdc00, 0x308) + 'b');
  assert.strictEqual(sliceAnsi(H(0xd83d) + '\x1b[1m' + H(0xde00) + 'b', 1), '');
});

test('SLICE-STYLES: SGRs before the slice are replayed one parameter and one attribute at a time', () => {
  assert.strictEqual(sliceAnsi('\x1b[1;31mab', 1), '\x1b[1m\x1b[31mb\x1b[39m\x1b[22m');
  assert.strictEqual(sliceAnsi('\x1b[31m\x1b[1m\x1b[32mab', 1), '\x1b[1m\x1b[32mb\x1b[39m\x1b[22m');
  assert.strictEqual(sliceAnsi('\x1b[1m\x1b[2mab', 1), '\x1b[1m\x1b[2mb\x1b[22m');
  assert.strictEqual(sliceAnsi('\x1b[2m\x1b[1mab', 1), '\x1b[2m\x1b[1mb\x1b[22m');
  assert.strictEqual(sliceAnsi('\x1b[1;2mab', 1), '\x1b[1m\x1b[2mb\x1b[22m');
  assert.strictEqual(sliceAnsi('\x1b[99mab', 1), '\x1b[99mb\x1b[0m');
  assert.strictEqual(sliceAnsi('\x1b[10m\x1b[11mab', 1), '\x1b[11mb\x1b[0m');
  assert.strictEqual(sliceAnsi('\x1b[38;5mab', 1), '\x1b[38m\x1b[5mb\x1b[25m\x1b[39m');
  assert.strictEqual(sliceAnsi('\x1b[38;5;208mab', 1), '\x1b[38;5;208mb\x1b[39m');
  assert.strictEqual(sliceAnsi('\x1b[38;2;1;2;3mab', 1), '\x1b[38;2;1;2;3mb\x1b[39m');
  assert.strictEqual(sliceAnsi('\x1b[4:3mab', 1), '\x1b[4:3mb\x1b[24m');
  assert.strictEqual(sliceAnsi('\x1b[38:5:208mab', 1), '\x1b[38:5:208mb\x1b[39m');
  assert.strictEqual(sliceAnsi('\x1b[1m\x1b[0;4mab', 1), '\x1b[4mb\x1b[24m');
  assert.strictEqual(sliceAnsi('\x1b[1m\x1b[mab', 1), 'b');
  assert.strictEqual(sliceAnsi('\x1b[1234567mab', 1), '\x1b[123456mb\x1b[0m');
  assert.strictEqual(sliceAnsi('a\x9b31;1mbc', 1, 2), '\x9b31m\x9b1mb\x1b[22m\x1b[39m');
  assert.strictEqual(sliceAnsi('\x1b[4m\x1b[21mab', 1), '\x1b[4m\x1b[21mb\x1b[24m');
});

test('SLICE-LINKS: an OSC 8 link open before the slice is replayed, and closed at the cut as it was opened', () => {
  assert.strictEqual(sliceAnsi('\x1b]8;;http://x\x07ab\x1b]8;;\x07cd', 1), '\x1b]8;;http://x\x07b\x1b]8;;\x07cd');
  assert.strictEqual(sliceAnsi('\x1b]8;;http://x\x07ab\x1b]8;;\x07cd', 0, 1), '\x1b]8;;http://x\x07a\x1b]8;;\x07');
  assert.strictEqual(sliceAnsi('\x1b]8;;http://x\x07ab\x1b]8;;\x07cd', 0, 2), '\x1b]8;;http://x\x07ab\x1b]8;;\x07');
  assert.strictEqual(sliceAnsi('\x1b]8;id=1;u\x1b\\ab', 1), '\x1b]8;id=1;u\x1b\\b\x1b]8;;\x1b\\');
  assert.strictEqual(sliceAnsi('\x9d8;;u\x9cab\x9d8;;\x9ccd', 1, 2), '\x9d8;;u\x9cb\x9d8;;\x9c');
  assert.strictEqual(sliceAnsi('x\x1b]8;;u\x07ab', 0, 2), 'x\x1b]8;;u\x07a\x1b]8;;\x07');
  assert.strictEqual(sliceAnsi('\x1b]8;;u\x1bab', 1), '');
});

test('SLICE-AFTER-END: at the cut only what closes something open is kept; at the end of the text, all of it', () => {
  assert.strictEqual(sliceAnsi('ab\x1b[1m', 0, 2), 'ab');
  assert.strictEqual(sliceAnsi('ab\x1b[1m', 0, 3), 'ab\x1b[1m\x1b[22m');
  assert.strictEqual(sliceAnsi('ab\x1b[1m', -2), 'ab\x1b[1m\x1b[22m');
  assert.strictEqual(sliceAnsi('ab\x1b[22m', -2), 'ab\x1b[22m');
  assert.strictEqual(sliceAnsi('\x1b[1mab\x1b[22mcd', 0, 2), '\x1b[1mab\x1b[22m');
  assert.strictEqual(sliceAnsi('\x1b[1mab\x1b[22;4mcd', 0, 2), '\x1b[1mab\x1b[22m');
  assert.strictEqual(sliceAnsi('\x1b[1mab\x1b[0mcd', 0, 2), '\x1b[1mab\x1b[0m');
  assert.strictEqual(sliceAnsi('\x1b[1mab\x1b[39mcd', 0, 2), '\x1b[1mab\x1b[22m');
  assert.strictEqual(sliceAnsi('ab\x1b[0mcd', 0, 2), 'ab');
  assert.strictEqual(sliceAnsi('\x1b[4mab\x1b[4:0mcd', 0, 2), '\x1b[4mab\x1b[24m');
  assert.strictEqual(sliceAnsi('a\x1b[2Kb', 0, 1), 'a');
  assert.strictEqual(sliceAnsi('a\x1b[2Kb', 0, 2), 'a\x1b[2Kb');
});

test('SLICE-ESCAPES: an unterminated string is visible text; U+009C alone is a sequence', () => {
  assert.strictEqual(sliceAnsi('a\x1b]0;title', 0, 3), 'a\x1b]0');
  assert.strictEqual(sliceAnsi('a\x1b]0;title', 3), ';title');
  assert.strictEqual(sliceAnsi('a\x9d0;title', 0, 3), 'a\x9d0;');
  assert.strictEqual(sliceAnsi('a\x1bP1\x07b', 1), '\x1bP1\x07b');
  assert.strictEqual(sliceAnsi('a\x1b]0;t\x07b', 1), 'b');
  assert.strictEqual(sliceAnsi('a\x1b]0;t\x1b[1mb', 1), '\x1b[1mb\x1b[22m');
  assert.strictEqual(sliceAnsi('a\x1b]0;t\x1b', 1), '');
  assert.strictEqual(sliceAnsi('a\x9c' + H(0x903) + 'b', 0, 1), 'a\x9c' + H(0x903));
  assert.strictEqual(sliceAnsi('a\x9cb', 1), 'b');
  assert.strictEqual(sliceAnsi('a\x18' + H(0x903) + 'b', 1), '\x18' + H(0x903) + 'b');
});

test('SLICE-ESCAPES: ESC forms, and an ESC that starts none is a visible 0-wide character', () => {
  assert.strictEqual(sliceAnsi('a\x1b\x18b', 1), '\x1b\x18b');
  assert.strictEqual(sliceAnsi('a\x1b' + H(0x301) + 'b', 1), '\x1b' + H(0x301) + 'b');
  assert.strictEqual(sliceAnsi('a\x1b' + H(0x301) + 'b', 0, 1), 'a');
  assert.strictEqual(sliceAnsi('a\x1b ' + H(0x1f600) + 'b', 1), H(0xde00) + 'b');
  assert.strictEqual(sliceAnsi('a\x1b\x1b[1mb', 1), '\x1b[1mb\x1b[22m');
  assert.strictEqual(sliceAnsi('a\x1b\x1bb', 1), '');
  assert.strictEqual(sliceAnsi('a\x1b', 1), '');
  assert.strictEqual(sliceAnsi('\x1ba', 0, 1), '');
  assert.strictEqual(sliceAnsi('a\x1b7b', 1), 'b');
  assert.strictEqual(sliceAnsi('a\x1b[?25lb', 0, 2), 'a\x1b[?25lb');
  assert.strictEqual(sliceAnsi('\x1b[?1mab', 1), 'b');
  assert.strictEqual(sliceAnsi('\x1b[1 mab', 1), 'b');
});

test('SLICE-ASCII-RUNS: two or more printable ASCII leading a run end the cluster before them', () => {
  assert.strictEqual(sliceAnsi(H(0x890) + '\x1b[1mab', 1), '\x1b[1mab\x1b[22m');
  assert.strictEqual(sliceAnsi(H(0x890) + '\x1b[1ma', 1), '');
  assert.strictEqual(sliceAnsi(H(0x890) + '\x1b[1ma' + H(0x301) + 'b', 1), '\x1b[1mb\x1b[22m');
  assert.strictEqual(sliceAnsi(H(0x890) + 'ab', 1), 'b');
  assert.strictEqual(sliceAnsi(H(0x600) + '\x1b[1mab', 0, 1), H(0x600) + '\x1b[1ma\x1b[22m');
  assert.strictEqual(sliceAnsi(H(0x301, 0x301, 0x301, 0x301, 0x890) + 'ab', 0, 1), H(0x301, 0x301, 0x301, 0x301, 0x890) + 'a');
  assert.strictEqual(sliceAnsi(H(0x301, 0x301, 0x301, 0x301, 0x301, 0x890) + 'ab', 0, 1), H(0x301, 0x301, 0x301, 0x301, 0x301, 0x890));
  assert.strictEqual(sliceAnsi(H(0x301, 0x301, 0x301, 0x301, 0x301, 0x301, 0x890) + 'ab', 0, 1), H(0x301, 0x301, 0x301, 0x301, 0x301, 0x301, 0x890) + 'a');
  assert.strictEqual(sliceAnsi('x' + H(0x301, 0x301, 0x301, 0x301, 0x301, 0x890) + 'abc', 1, 2), H(0x890));
});
