'use strict';
// forced-win32: spawn-injected: no test here spawns; gen-unicode-data and native-intl are required only for their pure chooseIntl/rulesThrough/intlVerdict, never nativeIntl or a native run
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
const { graphemeBoundaries, clusterWidth, codePointWidth, escapeLayer, forEachCell, cellSgr, oscLink, textWidth, stringWidth, sliceAnsi,
  wrapAnsi, joinsSpace, UNICODE_DATA } = require('../libexec/unicode-text.cjs');
const { ucdInput } = require('./ucd-input.cjs');
const { census, rngBias, assertCensus, firstSighting, intRng } = require('./shape-census.cjs');
const { defineGuard, guardTests } = require('./guard.cjs');
const ucd = require('../scripts/lib/ucd.cjs');

async function breakTest(t) {
  const ver = UNICODE_DATA.header.intl.unicode;   // uax29's version (graphemeBoundaries' default profile)
  // The tables and the corpus must be the same release's: a pin moved without a
  // regeneration would test the rules against a corpus the data never saw.
  assert.strictEqual(ucd.pins()[ver].GraphemeBreakTest.sha256, UNICODE_DATA.header.intl.ucdSha256.GraphemeBreakTest,
    `scripts/unicode-inputs.json pins a different GraphemeBreakTest ${ver} than the generated header names`);
  try {
    return await ucdInput(ver, 'GraphemeBreakTest');
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
  // clusterWidth reads the cluster's code points up to end, never past it.
  // A lone surrogate's own width is the table's 0 (native gives it no cell).
  assert.strictEqual(codePointWidth(0xd83d), 0);
  assert.strictEqual(clusterWidth('\u{1f600}', 0, 2), 2);
  assert.strictEqual(clusterWidth('\u{1f600}', 0, 1), 0, 'half an emoji is not the emoji');
  assert.strictEqual(clusterWidth('\u261d\u{1f3fb}', 0, 3), 2, 'a whole emoji modifier on its base: WIDTH-EMOJI-BASE');
  assert.strictEqual(clusterWidth('\u261d\u{1f3fb}', 0, 2), 1, 'half of one does not');
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
const W = (s, narrow = true) => clusterWidth(s, 0, s.length, narrow);

test('profiles: uax29 is the default, bun-cell is opt-in, an unknown profile throws', () => {
  assert.throws(() => graphemeBoundaries('ab', 0, 2, 'bun'), /unknown text profile "bun"/);
  assert.throws(() => graphemeBoundaries('ab', 0, 2, 'Bun-Cell'), /unknown text profile "Bun-Cell"/);
  assert.throws(() => graphemeBoundaries('ab', 0, 2, 'toString'), /unknown text profile/, 'an inherited name is not a profile');
  const s = '\u1019\u1039\u1018';
  assert.deepStrictEqual(graphemeBoundaries(s), B(s, 'uax29'), 'uax29 is the default');
  // Widths are bun-cell's only (native's Intl.Segmenter measures nothing): no 0|1|2 cap.
  assert.strictEqual(clusterWidth('\u1100\u1100', 0, 2), 4, 'WIDTH-SUM, as native CellSegmenter');
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

test('GB9c has two forms: uax29 (UAX #29 rev 49, Unicode 18.0) joins a Consonant after any Linker Extend*, bun-cell still wants a Consonant first', () => {
  // Measured 2026-11-21, 2.1.330 through the BUN_OPTIONS preload: linux native Intl.Segmenter
  // (ICU 79.1, Unicode 18.0) and native CellSegmenter, on both platforms; and GraphemeBreakTest
  // 18.0.0's [9.3] lines. Darwin native's Intl (macOS ICU 78.1, Unicode 17.0) still splits
  // these — a different oracle (INTL-FOLLOWS-BUNDLED-ICU, scripts/lib/native-intl.cjs).
  const cp = (...a) => String.fromCodePoint(...a);
  const uax = [
    [cp(0x94d, 0x915), [2]],                 // CI 44980741750: native `094D 0915`, ours had `094D | 0915`
    [cp(0x94d, 0x308, 0x915), [3]],          // an InCB Extend between Linker and Consonant
    [cp(0x61, 0x94d, 0x924), [3]],
    [cp(0x3f, 0x94d, 0x924), [3]],
    [cp(0x94d, 0x94d, 0x915), [3]],
    [cp(0xa, 0x94d, 0x915), [1, 3]],         // GB4 still breaks after LF; GB9c joins after it
    [cp(0x915, 0x61, 0x94d, 0x924), [1, 4]],
    [cp(0x94d, 0x61), [1, 2]],               // only a Consonant joins
    [cp(0x1cf5, 0x915), [2]],                // a Linker that is not a virama (GraphemeBreakTest 18.0.0)
    [cp(0x94d, 0x903, 0x915), [2, 3]],       // a SpacingMark is no InCB Extend
  ];
  for (const [s, want] of uax) assert.deepStrictEqual(B(s, 'uax29'), want, `uax29 ${Array.from(s, (c) => c.codePointAt(0).toString(16)).join(' ')}`);
  assert.deepStrictEqual(B(cp(0x94d, 0x915), 'bun-cell'), [1, 2], 'native CellSegmenter: [094D] [0915]');
  assert.deepStrictEqual(B(cp(0x94d, 0x308, 0x915), 'bun-cell'), [2, 3]);
  assert.deepStrictEqual(B(cp(0x915, 0x94d, 0x915), 'bun-cell'), [3], 'the old form still joins after a Consonant');
});

test('the uax29 tables are the version linux native\'s Intl reports, and the rules have been read through it', () => {
  const h = UNICODE_DATA.header;
  assert.strictEqual(h.intl.platform, require('../scripts/lib/native-intl.cjs').INTL_PLATFORM);
  assert.ok(ucd.pins()[h.intl.unicode], `scripts/unicode-inputs.json pins Unicode ${h.intl.unicode}`);
  for (const [name, sha] of Object.entries(h.intl.ucdSha256)) assert.strictEqual(ucd.pins()[h.intl.unicode][name].sha256, sha, `${h.intl.unicode}/${name}`);
  const { chooseIntl, rulesThrough } = require('../scripts/gen-unicode-data.cjs');
  const src = require('node:fs').readFileSync(require.resolve('../libexec/unicode-text.cjs'), 'utf8');
  const through = rulesThrough(src);
  assert.ok(require('../scripts/lib/native-intl.cjs').compareVersions(h.intl.unicode, through) <= 0, `tables at ${h.intl.unicode}, rules through ${through}`);
  // THE TABLE-VERSION CHECK: the next Unicode a linux native's Intl reports is refused until pinned,
  // then until its rules are read; a darwin native keeps the header's version; nothing else moves it.
  const pins = { ...ucd.pins(), '19.0.0': {} };
  assert.throws(() => chooseIntl({ unicode: '19.0', icu: '80.1', platform: 'linux' }, h, ucd.pins(), through), /does not pin: add it and run --pin 19\.0\.0/);
  assert.throws(() => chooseIntl({ unicode: '19.0', icu: '80.1', platform: 'linux' }, h, pins, through), /past UAX29_RULES_THROUGH 18\.0\.0/);
  assert.deepStrictEqual(chooseIntl({ unicode: h.intl.unicode.replace(/\.0$/, ''), icu: h.intl.icu, platform: 'linux' }, h, pins, through),
    { unicode: h.intl.unicode, icu: h.intl.icu, platform: 'linux' });
  assert.strictEqual(chooseIntl({ unicode: '17.0', icu: '78.1', platform: 'darwin' }, h, pins, through).unicode, h.intl.unicode);
  assert.throws(() => chooseIntl({ unicode: '17.0', icu: '78.1', platform: 'darwin' }, {}, pins, through), /generate once with a linux native/);
  assert.throws(() => rulesThrough('const x = 1;\n'), /declares no UAX29_RULES_THROUGH/);
});

test('intlVerdict: same platform and version judges; same platform, new version is STALE; another platform is a different oracle', () => {
  const { intlVerdict } = require('../scripts/lib/native-intl.cjs');
  const h = { unicode: '18.0.0', icu: '79.1', platform: 'linux' };
  assert.deepStrictEqual(intlVerdict({ unicode: '18.0', icu: '79.1', platform: 'linux' }, h), { judge: true });
  assert.match(intlVerdict({ unicode: '19.0', icu: '80.1', platform: 'linux' }, h).stale, /now reports ICU 80\.1, Unicode 19\.0.*regenerate/);
  assert.match(intlVerdict({ unicode: '18.0', icu: '79.2', platform: 'linux' }, h).stale, /ICU 79\.2/);
  assert.match(intlVerdict({ unicode: '17.0', icu: '78.1', platform: 'darwin' }, h).other, /darwin's ICU 78\.1.*different oracle/);
  assert.match(intlVerdict({ unicode: '18.0', icu: '79.1', platform: 'linux' }, undefined).stale, /names no intl version/);
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
  assert.strictEqual(W('\u0915\u094d\u0937\u094d\u092e'), 3);
  assert.strictEqual(W('\u0915\u094d\u0937\u094d\u092e\u094d\u092f'), 4);
  assert.strictEqual(W('\u1100\u1100'), 4);
  assert.strictEqual(W('\u1100\u1100\u1161'), 4);
  assert.strictEqual(W('\u0915\u094d\u0937'), 2);
  assert.strictEqual(W('\u0600a'), 1, 'a zero-width lead takes the width that follows');
  assert.strictEqual(W('\u0308\u0903'), 1);
  assert.strictEqual(W('\u0890\u{1f476}\u{1f3fb}'), 5, 'a Prepend base is not an emoji base');
});

test('bun-cell WIDTH-RI: a cluster of two or more code points holding a Regional Indicator is 2', () => {
  assert.strictEqual(W('\u06dd\u{1f1e6}'), 2);
  assert.strictEqual(W('\u{1f1e6}\u0308'), 2);
  assert.strictEqual(W('\u{1f1e6}\u200d'), 2);
  assert.strictEqual(W('\u{1f1e6}'), 1, 'alone it is 1');
});

test('bun-cell WIDTH-KEYCAP: a cluster holding U+20E3 is 2', () => {
  assert.strictEqual(W('#\u20e3'), 2);
  assert.strictEqual(W('a\u20e3'), 2);
  assert.strictEqual(W('\u1100\u1100\u20e3'), 2, 'even over a sum of 6');
});

test('bun-cell WIDTH-EMOJI-BASE: an emoji base with a ZWJ or a modifier is 2, measured exceptions are not', () => {
  assert.strictEqual(W('\u2764\u200d\u{1f525}'), 2, 'sum 3');
  assert.strictEqual(W('\u{1f600}\u200d\u{1f600}'), 2, 'sum 4');
  assert.strictEqual(W('\u261d\u{1f3fb}'), 2, 'sum 3');
  assert.strictEqual(W('\u2122\u200d'), 2, 'sum 1');
  // The generator's measured override emoji-not-width-base: Emoji native does not treat
  // as a width base, so the plain sum stands.
  assert.strictEqual(W('\u00a9\u200d\u{1f600}'), 3);
  assert.strictEqual(W('\u00a9\u200d'), 1);
  assert.strictEqual(W('\u3030\u200d\u{1f600}'), 4);
});

test('bun-cell WIDTH-VS16: U+FE0F widens an Emoji Extended_Pictographic base to 2, nothing else', () => {
  assert.strictEqual(W('\u2764\ufe0f'), 2);
  assert.strictEqual(W('\u00a9\ufe0f'), 2);
  assert.strictEqual(W('a\ufe0f'), 1);
  assert.strictEqual(W('#\ufe0f'), 1);
});

test('bun-cell WIDTH-VS16: it widens the BASE to 2, and the rest of the cluster still counts', () => {
  // Found by fuzzing escape-heavy strings against native (task 6, 2026-09-24): a spacing mark
  // in the cluster keeps its column. native: 1F600 0903 FE0F = 3, 2764 0903 FE0F = 3,
  // 2764 0903 0903 FE0F = 4, 2764 FE0F 0903 = 3, 00A9 0903 FE0F = 3, 0600 2764 0903 FE0F = 3.
  const w = (...cps) => W(String.fromCodePoint(...cps));
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
  assert.strictEqual(W('\u0600\u2764\u200d\u{1f600}'), 2, 'U+0600 is zero-width, so U+2764 is the base');
  assert.strictEqual(W('\u0890\u2764\u200d\u{1f600}'), 4, 'U+0890 is 1 wide, so it is the base');
  assert.strictEqual(W('\u0600\u2764\ufe0f'), 2);
});

test('bun-cell LONE-SURROGATES-INVISIBLE: a lone surrogate neither breaks nor counts', () => {
  // native: [0061 0308]=1 (the surrogate is gone from the cell's text; the mark joins 'a').
  assert.deepStrictEqual(B('a\udc00\u0308', 'bun-cell'), [3]);
  assert.deepStrictEqual(B('a\udc00\u0308', 'uax29'), [1, 3]);
  assert.strictEqual(W('a\udc00\u0308'), 1);
  // native: [1F1E6]=1 — the surrogate does not make the RI a two-code-point cluster.
  assert.strictEqual(W('\u{1f1e6}\udc00'), 1);
  // native: [2764 FE0F]=2 — nor is it the cluster's base.
  assert.deepStrictEqual(B('\udc00\u2764\ufe0f', 'bun-cell'), [3]);
  assert.strictEqual(W('\udc00\u2764\ufe0f'), 2);
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
  // ...and so is a NON-EMPTY zero-width one (task 8, R32: measured before deciding whether
  // `ellipsis !== ''` should refuse it). Native 2.1.278, 2026-09-25: 448 cases (U+200B,
  // U+0301, U+200D, U+FE0F, ESC[1m, ESC[0m and an OSC 8 open, as a string and as
  // { ellipsis }, over four inputs and eight cuts, truncating and not) each equal the same
  // slice with no ellipsis at all. So the refusal is for a WIDTH, as native's behaviour is.
  assert.strictEqual(sliceAnsi('unicorn', 0, 4, H(0x200b)), 'unic');
  assert.strictEqual(sliceAnsi('unicorn', 2, 4, { ellipsis: '\x1b[1m' }), 'ic');
  assert.strictEqual(sliceAnsi('\x1b[31municorn\x1b[39m', 1, 3, H(0x301)), '\x1b[31mni\x1b[39m');
  assert.strictEqual(sliceAnsi(H(0x61, 0x4e2d, 0x62, 0x63), 0, 2, { ellipsis: H(0x200b) }), H(0x61, 0x4e2d));
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
  // a style opened again goes to the end even when it is the same (CELL-SGR keeps it in place)
  assert.strictEqual(sliceAnsi('x\x1b[31m\x1b[1m\x1b[31my', 1, 2), '\x1b[1m\x1b[31my\x1b[39m\x1b[22m');
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

// ---- SGR (sliceAnsi's and CellSegmenter's) and CELL-SGR -----------------------------------
// Every expectation is native 2.1.278's CellSegmenter, measured 2026-09-25: the sgrKeys and
// sgrCloseKeys entry of the cell `x` after the SGRs given (`ESC[<body>m ... x`). cellSgr is
// what bun-shim keys each run by; test/fidelity/text-differential.test.cjs judges the whole
// against native, the style included.
const K = (...codes) => codes.map((c) => '\x1b[' + c + 'm');
const R = (n, v) => new Array(n).fill(v).join(';');
// The styles in force after each SGR body in turn: [opens, closes].
function cellStyles(...bodies) {
  const st = [];
  for (const b of bodies) cellSgr(st, b);
  return [st.map((e) => e.open), st.map((e) => e.close)];
}

test('SGR-PARAMETERS: digits, `;` and `:` alone make an SGR; an empty parameter is 0; leading zeros are nothing', () => {
  assert.deepStrictEqual(cellStyles('1', '?0'), [K(1), K(22)]);
  assert.deepStrictEqual(cellStyles('1', '0 '), [K(1), K(22)]);
  assert.deepStrictEqual(cellStyles('1', '>0'), [K(1), K(22)]);
  assert.deepStrictEqual(cellStyles('1', '0;?'), [K(1), K(22)]);
  assert.deepStrictEqual(cellStyles(';1'), [K(1), K(22)]);
  assert.deepStrictEqual(cellStyles('1;'), [[], []]);
  assert.deepStrictEqual(cellStyles('1', ''), [[], []]);
  assert.deepStrictEqual(cellStyles('1', ';'), [[], []]);
  assert.deepStrictEqual(cellStyles('01'), [K(1), K(22)]);
  assert.deepStrictEqual(cellStyles('0031'), [K(31), K(39)]);
  assert.deepStrictEqual(cellStyles('00000000000000000001'), [K(1), K(22)]);
  assert.deepStrictEqual(cellStyles('38;5;0208'), [K('38;5;208'), K(39)]);
  // sliceAnsi reads them the same way (native, same day)
  assert.strictEqual(sliceAnsi('\x1b[0031mab', 1), '\x1b[31mb\x1b[39m');
  assert.strictEqual(sliceAnsi('\x1b[1m\x1b[?0mab', 1), '\x1b[1mb\x1b[22m');
  assert.strictEqual(sliceAnsi('\x1b[1m\x1b[0 mab', 1), '\x1b[1mb\x1b[22m');
});

test('SGR-CLOSES: each code 0-130 on its own opens what native opens, closed as native closes it', () => {
  // native, `ESC[<n>m x` for every n: the close of each code that opens a style; 0 and the
  // close codes open nothing; every other code opens a style closed by ESC[0m.
  const closes = {
    22: [1, 2], 23: [3, 20], 24: [4, 21], 25: [5, 6], 27: [7], 28: [8], 29: [9],
    39: [30, 31, 32, 33, 34, 35, 36, 37, 38, 90, 91, 92, 93, 94, 95, 96, 97],
    49: [40, 41, 42, 43, 44, 45, 46, 47, 48, 100, 101, 102, 103, 104, 105, 106, 107],
    54: [51, 52], 55: [53], 59: [58], 75: [73, 74],
  };
  const none = [0, 22, 23, 24, 25, 27, 28, 29, 39, 49, 54, 55, 59, 75];
  for (let n = 0; n <= 130; n++) {
    const c = Object.keys(closes).find((k) => closes[k].includes(n));
    const want = none.includes(n) ? [[], []] : [K(n), K(c === undefined ? 0 : c)];
    assert.deepStrictEqual(cellStyles(String(n)), want, `ESC[${n}m`);
  }
});

test('SGR-ATTRIBUTES: one style per attribute, a new one at the end; bold/dim, 3/20, 4/21, 51/52 apart', () => {
  assert.deepStrictEqual(cellStyles('1', '2'), [K(1, 2), K(22, 22)]);
  assert.deepStrictEqual(cellStyles('2', '1'), [K(2, 1), K(22, 22)]);
  assert.deepStrictEqual(cellStyles('3', '20'), [K(3, 20), K(23, 23)]);
  assert.deepStrictEqual(cellStyles('21', '4'), [K(21, 4), K(24, 24)]);
  assert.deepStrictEqual(cellStyles('51', '52'), [K(51, 52), K(54, 54)]);
  assert.deepStrictEqual(cellStyles('5', '6'), [K(6), K(25)]);
  assert.deepStrictEqual(cellStyles('73', '74'), [K(74), K(75)]);
  assert.deepStrictEqual(cellStyles('10', '11'), [K(11), K(0)]);
  assert.deepStrictEqual(cellStyles('10', '1', '99'), [K(1, 99), K(22, 0)]);
  assert.deepStrictEqual(cellStyles('31', '38'), [K(38), K(39)]);
  assert.deepStrictEqual(cellStyles('41', '48'), [K(48), K(49)]);
  assert.deepStrictEqual(cellStyles('31', '1', '32'), [K(1, 32), K(22, 39)]);
  assert.deepStrictEqual(cellStyles('38;5;1', '1', '38;5;2'), [K(1, '38;5;2'), K(22, 39)]);
  assert.deepStrictEqual(cellStyles('5', '1', '6'), [K(1, 6), K(22, 25)]);
});

test('SGR-APPLY: in order; 0 clears, a close code removes what it closes, 38/48/58 take 5;n or 2;r;g;b or stand bare', () => {
  assert.deepStrictEqual(cellStyles('1;31;4'), [K(1, 31, 4), K(22, 39, 24)]);
  assert.deepStrictEqual(cellStyles('31;1'), [K(31, 1), K(39, 22)]);
  assert.deepStrictEqual(cellStyles('1;0;31'), [K(31), K(39)]);
  assert.deepStrictEqual(cellStyles('10', '0'), [[], []]);
  assert.deepStrictEqual(cellStyles('1', '2', '22'), [[], []]);
  assert.deepStrictEqual(cellStyles('1', '10', '22'), [K(10), K(0)]);
  assert.deepStrictEqual(cellStyles('10', '1;22'), [K(10), K(0)]);
  assert.deepStrictEqual(cellStyles('5', '25'), [[], []]);
  assert.deepStrictEqual(cellStyles('58', '59'), [[], []]);
  assert.deepStrictEqual(cellStyles('51', '54'), [[], []]);
  assert.deepStrictEqual(cellStyles('38;5;208'), [K('38;5;208'), K(39)]);
  assert.deepStrictEqual(cellStyles('38;2;1;2;3'), [K('38;2;1;2;3'), K(39)]);
  assert.deepStrictEqual(cellStyles('58;5;3'), [K('58;5;3'), K(59)]);
  assert.deepStrictEqual(cellStyles('58;2;1;2;3'), [K('58;2;1;2;3'), K(59)]);
  assert.deepStrictEqual(cellStyles('58'), [K(58), K(59)]);
  assert.deepStrictEqual(cellStyles('38;5'), [K(38, 5), K(39, 25)]);
  assert.deepStrictEqual(cellStyles('38;2;1;2'), [K(38, 2, 1), K(39, 22, 22)]);
  assert.deepStrictEqual(cellStyles('38;7'), [K(38, 7), K(39, 27)]);
  assert.deepStrictEqual(cellStyles('38;;5'), [K(5), K(25)]);
  assert.deepStrictEqual(cellStyles('38;5;;1'), [K('38;5;0', 1), K(39, 22)]);
  assert.deepStrictEqual(cellStyles('38;5;1;1'), [K('38;5;1', 1), K(39, 22)]);
  assert.deepStrictEqual(cellStyles('38;2;1;2;3;4'), [K('38;2;1;2;3', 4), K(39, 24)]);
  assert.deepStrictEqual(cellStyles('1;38;5'), [K(1, 38, 5), K(22, 39, 25)]);
});

test('SGR-WHOLE: a colon or more than 32 parameters is ONE style, in its first parameter\'s attribute', () => {
  assert.deepStrictEqual(cellStyles('4:3'), [K('4:3'), K(24)]);
  assert.deepStrictEqual(cellStyles('4', '4:3'), [K('4:3'), K(24)]);
  assert.deepStrictEqual(cellStyles('31', '38:5:208'), [K('38:5:208'), K(39)]);
  assert.deepStrictEqual(cellStyles('1', '1;4:3'), [K('1;4:3'), K(22)]);
  assert.deepStrictEqual(cellStyles('4:3;1'), [K('4:3;1'), K(24)]);
  assert.deepStrictEqual(cellStyles('1', ':1'), [K(1, ':1'), K(22, 0)]);
  assert.deepStrictEqual(cellStyles('1', '0;1:2'), [K(1, '0;1:2'), K(22, 0)]);
  assert.deepStrictEqual(cellStyles('10', '0;1:2'), [K('0;1:2'), K(0)]);
  assert.deepStrictEqual(cellStyles('1', '22:1'), [K(1, '22:1'), K(22, 0)]);
  assert.deepStrictEqual(cellStyles('31', '39:0'), [K(31, '39:0'), K(39, 0)]);
  assert.deepStrictEqual(cellStyles('4:3', '24'), [[], []]);
  assert.deepStrictEqual(cellStyles('4:3', '0'), [[], []]);
  assert.deepStrictEqual(cellStyles('4:3', '4'), [K(4), K(24)]);
  assert.deepStrictEqual(cellStyles('1', R(32, 1)), [K(1), K(22)]);
  assert.deepStrictEqual(cellStyles('1', R(33, 1)), [K(R(33, 1)), K(22)]);
  assert.deepStrictEqual(cellStyles('4', '31;' + R(32, 1)), [K(4, '31;' + R(32, 1)), K(24, 39)]);
  assert.deepStrictEqual(cellStyles('1', '0;' + R(32, 4)), [K(1, '0;' + R(32, 4)), K(22, 0)]);
  assert.deepStrictEqual(cellStyles('1', R(31, 1) + ';'), [[], []]);
  assert.deepStrictEqual(cellStyles('1', R(32, 1) + ';'), [K(R(32, 1) + ';'), K(22)]);
});

test('CELL-SGR: ESC spellings, a parameter over 255 is whole, an identical re-open stays where it is', () => {
  assert.deepStrictEqual(cellStyles('1;256'), [K('1;256'), K(22)]);
  assert.deepStrictEqual(cellStyles('1;255'), [K(1, 255), K(22, 0)]);
  assert.deepStrictEqual(cellStyles('1', '0256'), [K(1, '0256'), K(22, 0)]);
  assert.deepStrictEqual(cellStyles('00255;1'), [K(255, 1), K(0, 22)]);
  assert.deepStrictEqual(cellStyles('38;5;256;1'), [K('38;5;256;1'), K(39)]);
  assert.deepStrictEqual(cellStyles('31', '286;1'), [K(31, '286;1'), K(39, 0)]);
  assert.deepStrictEqual(cellStyles('10', '1000001'), [K(1000001), K(0)]);
  assert.deepStrictEqual(cellStyles('04:3'), [K('04:3'), K(24)]);
  assert.deepStrictEqual(cellStyles('31', '1', '31'), [K(31, 1), K(39, 22)]);
  assert.deepStrictEqual(cellStyles('1', '2', '1'), [K(1, 2), K(22, 22)]);
  assert.deepStrictEqual(cellStyles('10', '1', '10'), [K(10, 1), K(0, 22)]);
  assert.deepStrictEqual(cellStyles('38;5;200', '1', '38;5;200'), [K('38;5;200', 1), K(39, 22)]);
  assert.deepStrictEqual(cellStyles('38;5;1', '1', '38;5;01'), [K('38;5;1', 1), K(39, 22)]);
  assert.deepStrictEqual(cellStyles('4:3', '1', '4:3'), [K(1, '4:3'), K(22, 24)]);
  assert.deepStrictEqual(cellStyles('999', '1', '999'), [K(1, 999), K(22, 0)]);
  // A C1 CSI's parameters reach cellSgr as an ESC CSI's do (ESCAPE-LAYER), so its style is
  // spelled ESC[ too: native `U+009B 04:3m x` is `ESC[04:3m`.
  assert.deepStrictEqual(cellStyles(...SGR(0x9b, 0x30, 0x34, 0x3a, 0x33, 0x6d, 0x78)), [K('04:3'), K(24)]);
});

// ---- OSC-8 (sliceAnsi's and CellSegmenter's) ----------------------------------------------
// Every expectation is native 2.1.278's, measured 2026-09-25: CellSegmenter's `uris` entry for
// the cell after the sequence (through escapeLayer, as bun-shim reads it: the OSCs it records,
// judged by oscLink), and Bun.sliceAnsi's answer for the same sequences. CELL-LINK, which is
// the shim's, is pinned in test/bun-shim-cell-segmenter.test.cjs.
const LINKS = (s) => escapeLayer(s).sequences.filter((q) => q.kind === 'osc').map((q) => oscLink(q.params, q.final));

test('OSC-8: `8;`, parameters to the next `;`, the URI verbatim, ended by BEL, U+009C or ESC \\', () => {
  // native CellSegmenter: each of the three terminators, after either introducer, links `u`
  assert.deepStrictEqual(LINKS('\x1b]8;;u\x07a\x1b]8;;u\x9cb\x1b]8;;u\x1b\\c\x9d8;;u\x07d\x9d8;;u\x1b\\e'), ['u', 'u', 'u', 'u', 'u']);
  // the parameters run to the next `;` and are not the URI: `8;a;b;u` links `b;u`, `8;;;` links `;`
  assert.deepStrictEqual(LINKS('\x1b]8;id=1:foo=bar;u\x07\x1b]8;a;b;u\x07\x1b]8;;;\x07\x1b]8;;u;v;w\x07'), ['u', 'b;u', ';', 'u;v;w']);
  // an empty URI closes, with or without parameters
  assert.deepStrictEqual(LINKS('\x1b]8;;\x07\x1b]8;id=1;\x1b\\\x9d8;;\x9c'), ['', '', '']);
  // the URI is verbatim: TAB, NEL, CSI, DEL, NUL, U+009D, a lone surrogate, non-ASCII
  for (const cp of [0x09, 0x85, 0x9b, 0x7f, 0x00, 0x9d, 0xd800, 0x4e2d, 0x1f600]) {
    assert.deepStrictEqual(LINKS('\x1b]8;;u' + H(cp) + 'v\x07a'), ['u' + H(cp) + 'v'], `U+${cp.toString(16)}`);
  }
  // not links: one `;`, none, `08`, `88`, `8 `, another OSC; ended by an ESC that is not ST
  assert.deepStrictEqual(LINKS('\x1b]8;v\x07\x1b]8\x07\x1b]08;;v\x07\x1b]88;;v\x07\x1b]8 ;;v\x07\x1b]0;t\x07\x1b]8;;v\x1b[1m'),
    [null, null, null, null, null, null, null]);
  // ... by CAN, SUB or the end of the text (the escape layer records none of those at all)
  assert.deepStrictEqual(LINKS('\x1b]8;;v\x18a\x1b]8;;v\x1aa\x1b]8;;v'), []);
});

test('OSC-8 through sliceAnsi: the same links, replayed as written (SLICE-LINKS)', () => {
  // native Bun.sliceAnsi
  assert.strictEqual(sliceAnsi('a\x1b]8;a;b;u\x07bc', 1), '\x1b]8;a;b;u\x07bc\x1b]8;;\x07');
  assert.strictEqual(sliceAnsi('a\x1b]8;;;\x07bc', 1), '\x1b]8;;;\x07bc\x1b]8;;\x07');
  assert.strictEqual(sliceAnsi('a\x1b]8;;u\x85v\x07bc', 1, 2), '\x1b]8;;u\x85v\x07b\x1b]8;;\x07');
  assert.strictEqual(sliceAnsi('a\x1b]8;u\x07bc', 1), 'bc');
  assert.strictEqual(sliceAnsi('a\x1b]08;;u\x07bc', 1), 'bc');
  assert.strictEqual(sliceAnsi('a\x1b]8;;u\x1b[1mbc', 1), '\x1b[1mbc\x1b[22m');
  // no nesting, and SGR 0 closes no link
  assert.strictEqual(sliceAnsi('\x1b]8;;u\x07a\x1b]8;;v\x07b\x1b]8;;\x07c', 1, 2), '\x1b]8;;v\x07b\x1b]8;;\x07');
  assert.strictEqual(sliceAnsi('\x1b]8;;u\x07a\x1b[0mbc', 1, 2), '\x1b]8;;u\x07b\x1b]8;;\x07');
});

test('ESCAPE-LAYER: an OSC ended by ESC \\ is recorded with that terminator; by another ESC, with none', () => {
  const finals = (s) => escapeLayer(s).sequences.filter((q) => q.kind !== 'csi').map((q) => q.final);
  assert.deepStrictEqual(finals('\x1b]0;t\x1b\\a\x1b]0;t\x1b[1mb\x1bPq\x1b\\c'), ['\x1b\\', '', '\x1b\\']);
  // the ST is still read as the two-character sequence it is: nothing of it is text
  assert.strictEqual(escapeLayer('\x1b]0;t\x1b\\a').text, 'a');
});

// ---- Bun.wrapAnsi ---------------------------------------------------------------------------
// Every expectation is native 2.1.283's Bun.wrapAnsi (Bun 1.4.3), measured 2026-09-26, and each
// test pins ONE rule libexec/unicode-text.cjs names (WRAP-...). Strings are built from code points
// (H) where they are not ASCII. test/fidelity/text-differential.test.cjs judges the whole against
// native over every text corpus (text-diff-wrapansi) and the wrap corpus at every width 1-80
// (text-diff-wrapansi-cases).
const HARD = { hard: true }, KEEP = { trim: false }, HARD_KEEP = { hard: true, trim: false };

test('WRAP-ARGUMENTS: the input as a template literal converts it, columns as integers, options only from an object', () => {
  assert.strictEqual(wrapAnsi('', 5), '');
  assert.strictEqual(wrapAnsi(undefined, 5), 'undefined');
  assert.strictEqual(wrapAnsi(null, 3), 'null');
  assert.strictEqual(wrapAnsi(12345, 2, HARD), '12\n34\n5');
  assert.strictEqual(wrapAnsi(true, 2, HARD), 'tr\nue');
  assert.throws(() => wrapAnsi(Symbol('x'), 3), TypeError);
  // an empty input is answered before the columns are read
  assert.strictEqual(wrapAnsi('', Symbol('x')), '');
  assert.throws(() => wrapAnsi('a', Symbol('x')), TypeError);
  assert.strictEqual(wrapAnsi('ab cd', 2.9), 'ab\ncd');
  assert.strictEqual(wrapAnsi('ab cd', '2'), 'ab\ncd');
  assert.strictEqual(wrapAnsi('ab cd', true), 'ab\ncd');
  // only an object is read: hard by its truthiness, wordWrap and trim only when exactly false
  assert.strictEqual(wrapAnsi('abc de', 2, true), 'abc\nde');
  assert.strictEqual(wrapAnsi('abc de', 2, 'hard'), 'abc\nde');
  assert.strictEqual(wrapAnsi('abc de', 2, { hard: 1 }), 'ab\nc\nde');
  assert.strictEqual(wrapAnsi('  ab  ', 5, { trim: 0 }), 'ab');
  assert.strictEqual(wrapAnsi('  ab  ', 5, { trim: null }), 'ab');
  assert.strictEqual(wrapAnsi('  ab  ', 5, { trim: false }), '  ab \n ');
  assert.strictEqual(wrapAnsi('abc de', 2, { wordWrap: 0 }), 'abc\nde');
  assert.strictEqual(wrapAnsi('abc de', 2, { wordWrap: false }), 'ab\nc\nde');
  // ambiguousIsNarrow is true unless given, then taken for its truthiness (U+00A7 is Ambiguous)
  assert.strictEqual(wrapAnsi(H(0xa7) + ' a', 3), H(0xa7) + ' a');
  assert.strictEqual(wrapAnsi(H(0xa7) + ' a', 3, { ambiguousIsNarrow: undefined }), H(0xa7) + ' a');
  assert.strictEqual(wrapAnsi(H(0xa7) + ' a', 3, { ambiguousIsNarrow: false }), H(0xa7) + '\na');
  assert.strictEqual(wrapAnsi(H(0xa7) + ' a', 3, { ambiguousIsNarrow: null }), H(0xa7) + '\na');
});

test('WRAP-NARROW: with no positive finite width the input comes back as given, line breaks and all', () => {
  for (const c of [0, -1, NaN, Infinity, -Infinity, 0.9]) assert.strictEqual(wrapAnsi('a\rb c', c), 'a\rb c', String(c));
  assert.strictEqual(wrapAnsi('ab cd', undefined), 'ab cd');
  assert.strictEqual(wrapAnsi('ab cd', -0.5), 'ab cd');
  assert.strictEqual(wrapAnsi('a\r\nb', -3), 'a\r\nb');
  assert.strictEqual(wrapAnsi('  a  ', 0), '  a  ');
  // one column is a width, and so is a finite huge one
  assert.strictEqual(wrapAnsi('a b', 1), 'a\nb');
  assert.strictEqual(wrapAnsi('a b', 1.9), 'a\nb');
  assert.strictEqual(wrapAnsi('ab cd', 1e30), 'ab cd');
});

test('WRAP-NEWLINE: LF, a lone CR and CRLF each end a line and come out as one LF; nothing carries across one', () => {
  assert.strictEqual(wrapAnsi('a\rb', 3), 'a\nb');
  assert.strictEqual(wrapAnsi('a\r\nb', 3), 'a\nb');
  assert.strictEqual(wrapAnsi('a\n\rb', 3), 'a\n\nb');
  assert.strictEqual(wrapAnsi('a\r\rb', 3), 'a\n\nb');
  assert.strictEqual(wrapAnsi('a\r\r\nb', 2), 'a\n\nb');
  assert.strictEqual(wrapAnsi('a\r', 3), 'a\n');
  assert.strictEqual(wrapAnsi('\r\n', 3), '\n');
  assert.strictEqual(wrapAnsi('ab cd\r', 2), 'ab\ncd\n');
  // each line is wrapped on its own: what is open at a line break is not closed before it nor
  // reopened after it
  assert.strictEqual(wrapAnsi('\x1b[31mab cd\nef gh', 2), '\x1b[31mab\x1b[39m\n\x1b[31mcd\nef\ngh');
  assert.strictEqual(wrapAnsi('\x1b]8;;u\x07ab\ncd ef', 2), '\x1b]8;;u\x07ab\ncd\nef');
  // lines are split before any escape is read: a LF inside an OSC ends the line
  assert.strictEqual(wrapAnsi('\x1b]8;;u\nv\x07ab', 2), '\x1b]8;;u\nv\x07ab');
  // U+2028 and NEL are not line breaks
  assert.strictEqual(wrapAnsi('a' + H(0x2028) + 'b c', 3), 'a' + H(0x2028) + 'b\nc');
  assert.strictEqual(wrapAnsi('a' + H(0x85) + 'b c', 3), 'a' + H(0x85) + 'b\nc');
});

test('WRAP-VERBATIM: text is copied code unit for code unit, never normalised', () => {
  // npm wrap-ansi NFC-normalised its input: U+0340 came back U+0300, `e U+0301` came back U+00E9
  assert.strictEqual(wrapAnsi(H(0x340), 1), H(0x340));
  assert.strictEqual(wrapAnsi(H(0x65, 0x301), 1), H(0x65, 0x301));
  assert.strictEqual(wrapAnsi(H(0x958) + ' ' + H(0x958), 1), H(0x958) + '\n' + H(0x958));
  assert.strictEqual(wrapAnsi(H(0x212b) + ' ' + H(0x212b), 1, HARD), H(0x212b) + '\n' + H(0x212b));
  // controls and lone surrogates stay (two 0-wide lone halves even meet: WRAP-TRIM)
  assert.strictEqual(wrapAnsi('a\x00b c', 2), 'a\x00b\nc');
  assert.strictEqual(wrapAnsi('ab\x0bcd ef', 2), 'ab\x0bcd\nef');
  assert.strictEqual(wrapAnsi(H(0xd800) + ' ' + H(0xdc00), 2), H(0xd800, 0xdc00));
});

test('WRAP-SPACE: U+0020 outside an escape sequence is the one separator, and each one is kept or broken at', () => {
  assert.strictEqual(wrapAnsi('ab cd', 2), 'ab\ncd');
  assert.strictEqual(wrapAnsi('ab' + H(0xa0) + 'cd', 2), 'ab' + H(0xa0) + 'cd');
  assert.strictEqual(wrapAnsi('ab' + H(0x3000) + 'cd', 2), 'ab' + H(0x3000) + 'cd');
  assert.strictEqual(wrapAnsi('ab' + H(0x2003) + 'cd', 2), 'ab' + H(0x2003) + 'cd');
  // a run of spaces is a run of empty words, each written back as one space
  assert.strictEqual(wrapAnsi('a  b', 10), 'a  b');
  assert.strictEqual(wrapAnsi('ab   cd', 3, KEEP), 'ab \n  \ncd');
  assert.strictEqual(wrapAnsi('a     b', 4, KEEP), 'a   \n  b');
  assert.strictEqual(wrapAnsi('a b c d e f', 3, KEEP), 'a b\n c \nd e\n f');
  // a space inside a sequence separates nothing (here, in an OSC 8 URI)
  assert.strictEqual(wrapAnsi('\x1b]8;;http://a b\x07cd ef', 2),
    '\x1b]8;;http://a b\x07cd\x1b]8;;\x07\n\x1b]8;;http://a b\x07ef');
});

test('WRAP-TAB: a tab is a 0-wide character of its word: never a separator, never expanded', () => {
  assert.strictEqual(wrapAnsi('a\tb', 1), 'a\tb');
  assert.strictEqual(wrapAnsi('a\tb', 1, HARD), 'a\n\tb');
  assert.strictEqual(wrapAnsi('a\tb\tc', 2, HARD), 'a\tb\n\tc');
  assert.strictEqual(wrapAnsi('aa\t\t\t\tbb', 2, HARD), 'aa\n\t\t\t\tbb');
  assert.strictEqual(wrapAnsi('ab\tcd ef', 5), 'ab\tcd\nef');
  assert.strictEqual(wrapAnsi('ab\tcd ef', 4, KEEP), 'ab\tcd\n ef');
});

test('WRAP-TRIM: a blank line is empty; a row loses its leading spaces and tabs as words are placed, and its trailing spaces', () => {
  assert.strictEqual(wrapAnsi('  ab  ', 5), 'ab');
  assert.strictEqual(wrapAnsi(' ab cd ', 4), 'ab\ncd');
  assert.strictEqual(wrapAnsi('\t\t', 5), '');
  assert.strictEqual(wrapAnsi(' \t ', 5), '');
  assert.strictEqual(wrapAnsi(' \t ', 1, KEEP), ' \t\n ');
  // a leading tab goes when the next word is placed on its row, and stays when none is
  assert.strictEqual(wrapAnsi('\tab cd', 5), 'ab cd');
  assert.strictEqual(wrapAnsi('\tab', 5), '\tab');
  // leading spaces go around an escape, which stays
  assert.strictEqual(wrapAnsi('  \x1b[1mab', 2), '\x1b[1mab');
  assert.strictEqual(wrapAnsi('\x1b[1m  ab', 2), '\x1b[1mab');
  // past the row's last word with a width only spaces go: tabs and escapes stay
  assert.strictEqual(wrapAnsi('a \t b', 1), 'a\t\nb');
  assert.strictEqual(wrapAnsi('ab \x1b[1m  ', 10), 'ab\x1b[1m');
  assert.strictEqual(wrapAnsi('ab\x1b[1m \x1b[22m cd', 3), 'ab\x1b[1m\x1b[22m\ncd');
  // no separator is written at the start of a row that has no width, so 0-wide words run together
  assert.strictEqual(wrapAnsi(H(0x340) + ' ' + H(0x340), 1), H(0x340, 0x340));
  // without trim a row already full is ended BEFORE the separator, which then leads the next row
  assert.strictEqual(wrapAnsi('ab cd', 2, KEEP), 'ab\n \ncd');
  assert.strictEqual(wrapAnsi('\x1b[1m  ab', 2, KEEP), '\x1b[1m  \x1b[22m\n\x1b[1mab');
});

test('WRAP-HARD: a word wider than the row is broken code point by code point, on a fresh row only when that saves a break', () => {
  assert.strictEqual(wrapAnsi('abcdefgh', 3, HARD), 'abc\ndef\ngh');
  assert.strictEqual(wrapAnsi('ab cdefgh', 3, HARD), 'ab\ncde\nfgh');
  assert.strictEqual(wrapAnsi('a bcdefg', 3, HARD), 'a\nbcd\nefg');
  assert.strictEqual(wrapAnsi('a bcdefgh', 3, HARD), 'a b\ncde\nfgh');
  assert.strictEqual(wrapAnsi('abcdef ghijklmnop', 5, HARD), 'abcde\nf\nghijk\nlmnop');
  assert.strictEqual(wrapAnsi('abcdef ghijklmnop', 5, HARD_KEEP), 'abcde\nf \nghijk\nlmnop');
  // each code point at its own width, and U+20E3 is 0 there (a CLUSTER holding it is 2: WIDTH-KEYCAP)
  assert.strictEqual(wrapAnsi('ab' + H(0x20e3) + 'cd', 2, HARD_KEEP), 'ab\n' + H(0x20e3) + 'cd');
  assert.strictEqual(wrapAnsi('ab#' + H(0x20e3) + 'cd', 2, HARD_KEEP), 'ab\n#' + H(0x20e3) + 'c\nd');
  // wordWrap: false breaks a word that does not fit into the rest of its row, the same way
  assert.strictEqual(wrapAnsi('abc defg', 3, { wordWrap: false }), 'abc\ndef\ng');
  assert.strictEqual(wrapAnsi('abc defg', 3, { wordWrap: false, trim: false }), 'abc\n de\nfg');
  assert.strictEqual(wrapAnsi('abcdefg hi', 3, { wordWrap: false }), 'abc\ndef\ng h\ni');
});

test('WRAP-WIDE: a code point wider than the room left starts a row, even from an empty one; a full row ends before what follows', () => {
  assert.strictEqual(wrapAnsi(H(0x4e2d), 1, HARD), '\n' + H(0x4e2d));
  assert.strictEqual(wrapAnsi(H(0x1f600), 1, HARD), '\n' + H(0x1f600));
  assert.strictEqual(wrapAnsi('a' + H(0x4e2d), 2, HARD), 'a\n' + H(0x4e2d));
  assert.strictEqual(wrapAnsi(H(0x4e2d, 0x6587), 3, HARD), H(0x4e2d) + '\n' + H(0x6587));
  assert.strictEqual(wrapAnsi(H(0x4e2d), 1), H(0x4e2d));
  // a cluster is broken like any word: each code point of a ZWJ sequence at its own width
  assert.strictEqual(wrapAnsi(H(0x1f468, 0x200d, 0x1f469), 1, HARD), '\n' + H(0x1f468) + '\n' + H(0x200d) + '\n' + H(0x1f469));
  assert.strictEqual(wrapAnsi(H(0x1f468, 0x200d, 0x1f469), 2, HARD), H(0x1f468, 0x200d, 0x1f469));
  // a row filled exactly ends before the next code point or escape; what is left with no width rejoins it
  assert.strictEqual(wrapAnsi('ab\x1b[1mcd', 2, HARD), 'ab\n\x1b[1mcd');
  assert.strictEqual(wrapAnsi('ab\x1b[1m', 1, HARD), 'a\nb\x1b[1m');
  assert.strictEqual(wrapAnsi('ab' + H(0x301), 1, HARD), 'a\nb' + H(0x301));
  assert.strictEqual(wrapAnsi('ab' + H(0x301) + 'c', 2, HARD), 'ab\n' + H(0x301) + 'c');
});

test('WRAP-ROW-WIDTH: the row is re-measured when a word may join the separator before it, and summed otherwise', () => {
  // U+20E3 after the separator joins it (WIDTH-KEYCAP): re-measured, the row is 6 wide and `cc` fits at 9
  assert.strictEqual(wrapAnsi('aa ' + H(0x20e3) + 'bb cc', 9), 'aa ' + H(0x20e3) + 'bb cc');
  assert.strictEqual(wrapAnsi('aa \x1b[1m' + H(0x20e3) + 'bb cc', 9), 'aa \x1b[1m' + H(0x20e3) + 'bb cc');
  assert.strictEqual(wrapAnsi('aa \x1b x' + H(0x20e3) + 'bb cc', 9), 'aa \x1b x' + H(0x20e3) + 'bb cc');
  // a word starting with anything else is summed: a lone surrogate first hides the keycap, so the
  // row counts 3 + 4 (Bun.stringWidth of it is 6) and `cc` goes down
  assert.strictEqual(wrapAnsi('aa ' + H(0xdc00, 0x20e3) + 'bb cc', 9), 'aa ' + H(0xdc00, 0x20e3) + 'bb\ncc');
  // ...as does the low half an escape's intermediate leaves: it takes ONE code unit (ESCAPE-LAYER)
  assert.strictEqual(wrapAnsi('aa \x1b ' + H(0x1f600, 0x20e3) + 'bb cc', 9), 'aa \x1b ' + H(0x1f600, 0x20e3) + 'bb\ncc');
});

// joinsSpace (WRAP-ROW-WIDTH's predicate) restates "after a space, this code point is in the
// space's bun-cell cluster" from the GCB tables (GB9/GB9a plus MODIFIER-NEEDS-BASE). Held to the
// clusterer itself over every code point, so the two cannot drift. The one exception is measured:
// bun-cell drops a lone surrogate (LONE-SURROGATES-INVISIBLE), so ' ' + U+D800 is one cluster,
// but native SUMS a word that starts with one (the U+DC00 literal in the WRAP-ROW-WIDTH test).
test('WRAP-ROW-WIDTH: joinsSpace(cp) is exactly "space + cp is one bun-cell cluster", lone surrogates excepted', () => {
  let examined = 0;
  const differ = [];
  for (let cp = 0; cp <= 0x10ffff; cp++) {
    const s = ' ' + String.fromCodePoint(cp);
    const surrogate = cp >= 0xd800 && cp <= 0xdfff;
    const want = surrogate ? false : graphemeBoundaries(s, 0, s.length, 'bun-cell').length === 1;
    if (joinsSpace(cp) !== want) differ.push(cp.toString(16));
    examined++;
  }
  assert.strictEqual(examined, 0x110000);
  assert.deepStrictEqual(differ.slice(0, 20), [], `${differ.length} code points differ`);
});

test('WRAP-SGR: the last one-number SGR is closed at each row end by its close code and reopened after the break', () => {
  assert.strictEqual(wrapAnsi('\x1b[31mab cd\x1b[39m', 2), '\x1b[31mab\x1b[39m\n\x1b[31mcd\x1b[39m');
  assert.strictEqual(wrapAnsi('\x1b[31mab cd\x1b[39m', 2, KEEP), '\x1b[31mab\x1b[39m\n\x1b[31m \x1b[39m\n\x1b[31mcd\x1b[39m');
  // only the LAST style: italic then bold closes and reopens the bold, and the italic runs on
  assert.strictEqual(wrapAnsi('\x1b[3mab \x1b[1mcd ef\x1b[22m gh\x1b[23m', 2),
    '\x1b[3mab\x1b[23m\n\x1b[3m\x1b[1mcd\x1b[22m\n\x1b[1mef\x1b[22m\ngh\x1b[23m');
  assert.strictEqual(wrapAnsi('\x1b[1m\x1b[31mBold Red text here\x1b[0m', 2),
    '\x1b[1m\x1b[31mBold\x1b[39m\n\x1b[31mRed\x1b[39m\n\x1b[31mtext\x1b[39m\n\x1b[31mhere\x1b[0m');
  // a close code, 0 or an empty SGR, and 39 leave nothing to close or reopen
  assert.strictEqual(wrapAnsi('\x1b[1mab\x1b[22m cd', 2), '\x1b[1mab\x1b[22m\ncd');
  assert.strictEqual(wrapAnsi('\x1b[31mab\x1b[m cd', 2), '\x1b[31mab\x1b[m\ncd');
  assert.strictEqual(wrapAnsi('\x1b[31mab\x1b[39m cd', 2), '\x1b[31mab\x1b[39m\ncd');
  // compound, extended and empty-parameter forms change nothing
  assert.strictEqual(wrapAnsi('\x1b[1;31mab cd\x1b[0m', 2), '\x1b[1;31mab\ncd\x1b[0m');
  assert.strictEqual(wrapAnsi('\x1b[38;5;196mRed text here\x1b[0m', 2), '\x1b[38;5;196mRed\ntext\nhere\x1b[0m');
  assert.strictEqual(wrapAnsi('\x1b[;31mab cd', 2), '\x1b[;31mab\ncd');
  // a code with no close code is neither closed nor reopened (99); one with one is (100, by 49)
  assert.strictEqual(wrapAnsi('\x1b[99mab cd', 2), '\x1b[99mab\ncd');
  assert.strictEqual(wrapAnsi('\x1b[100mab cd', 2), '\x1b[100mab\x1b[49m\n\x1b[100mcd');
  // the number is 32 bits: 2^32 + 1 is bold, reopened as 1, and 2^32 + 39 closes
  assert.strictEqual(wrapAnsi('\x1b[4294967297mab cd', 2), '\x1b[4294967297mab\x1b[22m\n\x1b[1mcd');
  assert.strictEqual(wrapAnsi('\x1b[4294967335mab cd', 2), '\x1b[4294967335mab\ncd');
  // a C1 CSI counts, and is reopened in the ESC form; an abandoned CSI does not
  assert.strictEqual(wrapAnsi('\x9b31mab cd', 2), '\x9b31mab\x1b[39m\n\x1b[31mcd');
  assert.strictEqual(wrapAnsi('\x1b[1\x1b[31mab cd', 2), '\x1b[1\x1b[31mab\x1b[39m\n\x1b[31mcd');
});

test('WRAP-LINK: the OSC 8 link in force is closed at each row end and reopened after the break, with BEL', () => {
  assert.strictEqual(wrapAnsi('\x1b]8;;u\x07ab cd', 2), '\x1b]8;;u\x07ab\x1b]8;;\x07\n\x1b]8;;u\x07cd');
  assert.strictEqual(wrapAnsi('\x1b]8;id=1;u\x1b\\ab cd', 2), '\x1b]8;id=1;u\x1b\\ab\x1b]8;;\x07\n\x1b]8;id=1;u\x07cd');
  assert.strictEqual(wrapAnsi('\x9d8;;u\x9cab cd', 2), '\x9d8;;u\x9cab\x1b]8;;\x07\n\x1b]8;;u\x07cd');
  assert.strictEqual(wrapAnsi('\x1b]8;a;b;c\x07ab cd', 2), '\x1b]8;a;b;c\x07ab\x1b]8;;\x07\n\x1b]8;a;b;c\x07cd');
  // with a style: the link is closed first and reopened last
  assert.strictEqual(wrapAnsi('\x1b[31m\x1b]8;;u\x07ab cd', 2),
    '\x1b[31m\x1b]8;;u\x07ab\x1b]8;;\x07\x1b[39m\n\x1b[31m\x1b]8;;u\x07cd');
  // a link replaces the one in force; an empty URI closes it
  assert.strictEqual(wrapAnsi('\x1b]8;;u\x07ab \x1b]8;;v\x07cd ef', 2),
    '\x1b]8;;u\x07ab\x1b]8;;\x07\n\x1b]8;;u\x07\x1b]8;;v\x07cd\x1b]8;;\x07\n\x1b]8;;v\x07ef');
  assert.strictEqual(wrapAnsi('\x1b]8;;u\x07ab \x1b]8;;\x07cd ef', 2), '\x1b]8;;u\x07ab\x1b]8;;\x07\n\x1b]8;;u\x07\x1b]8;;\x07cd\nef');
  // not links (OSC-8): one `;`, ended by an ESC that is not ST, by CAN, or not ended
  assert.strictEqual(wrapAnsi('\x1b]8;u\x07ab cd', 2), '\x1b]8;u\x07ab\ncd');
  assert.strictEqual(wrapAnsi('\x1b]8;;u\x1bxab cd', 2), '\x1b]8;;u\x1bxab\ncd');
  assert.strictEqual(wrapAnsi('\x1b]8;;u\x18ab cd', 2), '\x1b]8;;u\x18ab\ncd');
  assert.strictEqual(wrapAnsi('\x1b]8;;u', 2), '\x1b]8;;u');
});

// wrapAnsi takes two fast paths for input that is printable ASCII, with or without ESC sequences,
// and finds escapes with indexOf when the input holds no C1 introducer; both are a second statement
// of rules the general path states (BUN-STRINGWIDTH, ESCAPE-LAYER). WRAP-NEWLINE wraps each line
// on its own, so a line must wrap the same whatever the other lines hold: a second line holding a
// non-ASCII character sends the first down the general path, one holding U+009B down the
// character-by-character scan for introducers. Seeded, so the same strings every run. (Measured
// 2026-09-26: a fast path that counted a sequence ended by an ESC alone as 0 wide broke it on
// 40 of these 40,000 strings, where every unit test above and every text gate stayed green.)
//
// THE RNG AND THE CENSUS (observability Task 4). It drew `seed % n` from `seed * 1103515245`, which in JS rounds past
// 2^53 into a 10,466-state cycle whose low bits cycle besides (rnd(8) picked the options): measured 2026-11-19, its
// 40,000 draws were 1,647 distinct inputs, and only 6 of the 24 (options, other line) pairs were ever drawn. It draws from test/shape-census.cjs's intRng now, and the census below
// proves the inputs are distinct and hold every shape the paragraph above names.
const WRAP_ATOMS = ['a', 'b', 'c', 'x', ' ', ' ', ' ', '  ', '#', '1', 'longword', 'abcdefghij', '\x1b[1m', '\x1b[22m', '\x1b[31m',
  '\x1b[39m', '\x1b[0m', '\x1b[m', '\x1b[4294967297m', '\x1b[1;31m', '\x1b[38;5;1m', '\x1b]8;;u\x1b\\', '\x1b]8;;\x1b\\',
  '\x1b]8;id=1;v w\x1b\\', '\x1b ', '\x1b  ', '\x1b', '\x1b\x1b', '\x1b7', '\x1b[1', '\x1b[1 m', '\x1bPq\x1b\\', '\x1b_x',
  '\x1b]0;t', '\x1b(B'];
const WRAP_OTHERS = ['\n' + H(0xe9), '\n\x9b', '\r' + H(0x4e2d) + ' x'];
const WRAP_OPTS = [];
for (const hard of [false, true]) for (const trim of [true, false]) for (const wordWrap of [true, false]) WRAP_OPTS.push({ hard, trim, wordWrap });
const WRAP_SEED = 12345, WRAP_N = 40000, WRAP_MAX_ATOMS = 12, WRAP_MAX_COLS = 14;
function wrapInputs(rnd = intRng(WRAP_SEED)) {
  const out = [];
  for (let k = 0; k < WRAP_N; k++) {
    const atoms = [];
    for (let j = 1 + rnd(WRAP_MAX_ATOMS); j > 0; j--) atoms.push(rnd(WRAP_ATOMS.length));
    const cols = 1 + rnd(WRAP_MAX_COLS), o = rnd(WRAP_OPTS.length), other = rnd(WRAP_OTHERS.length);
    out.push({ atoms, s: atoms.map((i) => WRAP_ATOMS[i]).join(''), cols, o, other });
  }
  return out;
}
test('wrapAnsi: a line wraps the same whatever the other lines hold (the fast paths are the general one)', () => {
  let differ = 0, first = '';
  for (const { s, cols, o: oi, other: ki } of wrapInputs()) {
    const o = WRAP_OPTS[oi], other = WRAP_OTHERS[ki];
    const together = wrapAnsi(s + other, cols, o);
    const apart = wrapAnsi(s, cols, o) + '\n' + wrapAnsi(other.slice(1), cols, o);
    if (together !== apart && differ++ === 0) first = JSON.stringify([s, cols, o, other, together, apart]);
  }
  assert.strictEqual(differ, 0, `${differ} of ${WRAP_N} strings wrap differently beside another line; first: ${first}`);
});
// MUTATION CONTROL (observability Task 4, review fix round 1): the property must still catch a broken fast path on
// the NEW inputs. The 2026-09-26 mutant (a sequence ended by an ESC alone counted 0 wide) was never committed, so two
// stand-ins break the ESC_ONLY path's own width sum in libexec/unicode-text.cjs, loaded with the mutation into a fresh
// module: a lone ESC counted 1 wide, and an ESC (then a space) after a sequence swallowed into it. Measured 2026-11-19
// over the old float-LCG inputs and the new intRng ones: the first, 1 and 84 strings differ; the second, 416 and 742.
const WRAP_MUTANTS = [
  ['a lone ESC counted 1 wide in the ESC_ONLY sum', '      width -= e - i;\n      i = e;', '      width -= e - i === 1 ? 0 : e - i;\n      i = e;'],
  ['an ESC (then a space) after a sequence swallowed into it', '      const e = readSequence(str, i, 0, null, b);\n      width -= e - i;',
    '      let e = readSequence(str, i, 0, null, b);\n      if (e < b && str.charCodeAt(e - 1) !== 0x1b && str.charCodeAt(e) === 0x1b && (e + 1 >= b || str.charCodeAt(e + 1) === 0x20)) e = e + 1;\n      width -= e - i;'],
];
// A guard (defineGuard): read() applies each mutation to the real source, scan() runs the property's inputs through
// each mutant and names any mutant they do NOT catch. Its control is a mutation that changes nothing, which no input
// can catch, so the guard must name it.
function wrapMutantModule(src, file) {
  const Module = require('node:module');
  const m = new Module(file, null);
  m.filename = file;
  m.paths = Module._nodeModulePaths(path.dirname(file));
  m._compile(src, file);
  return m.exports;
}
function readWrapMutants(mutants = WRAP_MUTANTS) {
  const file = path.join(__dirname, '..', 'libexec', 'unicode-text.cjs');
  const src = require('node:fs').readFileSync(file, 'utf8');
  return { mutants: mutants.map(([name, from, to]) => (src.split(from).length !== 2
    ? { name, moved: true } : { name, wrap: wrapMutantModule(src.replace(from, to), file).wrapAnsi })) };
}
function scanWrapMutants({ mutants }) {
  const inputs = wrapInputs();
  const findings = [];
  for (const { name, moved, wrap } of mutants) {
    if (moved) { findings.push(`${name}: the mutation site moved in libexec/unicode-text.cjs; re-anchor it`); continue; }
    let differ = 0;
    for (const { s, cols, o: oi, other: ki } of inputs) {
      const o = WRAP_OPTS[oi], other = WRAP_OTHERS[ki];
      if (wrap(s + other, cols, o) !== wrap(s, cols, o) + '\n' + wrap(other.slice(1), cols, o)) differ++;
    }
    if (differ < 20) findings.push(`${name}: only ${differ} of ${WRAP_N} inputs catch it (floor 20; 84 and 742 measured)`);
  }
  return { findings, examined: mutants.length };
}
guardTests(defineGuard({
  name: 'wrapAnsi-fast-path-mutants-caught',
  floor: WRAP_MUTANTS.length,
  read: () => readWrapMutants(),
  scan: scanWrapMutants,
  control: () => readWrapMutants([['an identity mutation', 'width -= e - i;', 'width -= e - i;']]),
}));
test('wrapAnsi\'s fast-path property: distinct inputs, every option beside every other line, every escape shape, an unbiased RNG (census)', (t) => {
  const ESC_ALONE = new Set(['\x1b ', '\x1b  ', '\x1b', '\x1b\x1b'].map((a) => WRAP_ATOMS.indexOf(a)));
  const has = (x, a) => x.atoms.includes(WRAP_ATOMS.indexOf(a));
  // The floors: a floor written as a fraction of today's count is a regression tripwire on a deterministic count (the
  // seeds are fixed), not a coverage requirement.
  // Floors measured 2026-11-19 over the 40,000 intRng inputs: 39,467 distinct; each of the 24 (option, other line)
  // pairs 1,583-1,741 (1,667 expected); ESC alone 20,112, OSC-8 12,186, unterminated CSI 6,692; a long word 7,067.
  const shapes = [
    { shape: 'a distinct input', min: 38000, has: firstSighting((x) => `${x.s}\u0000${x.cols}\u0000${x.o}\u0000${x.other}`),
      why: 'nearly all of 40,000 (39,467 measured); the float-rounded LCG gave 1,647' },
    ...WRAP_OPTS.flatMap((o, oi) => WRAP_OTHERS.map((_, ki) => ({ shape: `options ${JSON.stringify(o)} beside other line ${ki}`, min: 800,
      has: (x) => x.o === oi && x.other === ki, why: 'half of the 1,667 each pair expects (the float-rounded LCG drew 6 of the 24 pairs at all)' }))),
    { shape: 'a sequence ended by an ESC alone', min: 1000, has: (x) => x.atoms.some((i) => ESC_ALONE.has(i)),
      why: 'the 2026-09-26 defect: such sequences broke 40 of 40,000; a twentieth of the 20,112 measured' },
    { shape: 'an OSC-8 link', min: 1000, has: (x) => has(x, '\x1b]8;;u\x1b\\') || has(x, '\x1b]8;id=1;v w\x1b\\'), why: 'a twelfth of the 12,186 measured' },
    { shape: 'an unterminated CSI', min: 500, has: (x) => has(x, '\x1b[1'), why: 'a thirteenth of the 6,692 measured' },
    { shape: 'a word longer than its column count', min: 5000, has: (x) => (has(x, 'longword') && x.cols < 8) || (has(x, 'abcdefghij') && x.cols < 10),
      why: 'hard and soft wrapping split it; under three quarters of the 7,067 measured' },
  ];
  const inputs = census('wrapAnsi fast-path inputs', shapes, wrapInputs());
  const moduli = [WRAP_MAX_ATOMS, WRAP_ATOMS.length, WRAP_MAX_COLS, WRAP_OPTS.length, WRAP_OTHERS.length];
  const bias = rngBias('wrapAnsi fast-path RNG', () => intRng(WRAP_SEED), moduli);
  for (const r of [inputs, bias]) t.diagnostic(r.summary);
  assertCensus(assert, inputs, bias);
});
