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
const { graphemeBoundaries, clusterWidth, codePointWidth, UNICODE_DATA } = require('../libexec/unicode-text.cjs');
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
