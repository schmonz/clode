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
