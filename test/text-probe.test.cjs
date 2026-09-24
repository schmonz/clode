'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { compareTextResults, runNative, runOurs } = require('../scripts/lib/text-probe.cjs');
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
  assert.deepStrictEqual(d.counts, { segmenter: 1, stringWidth: 1, intl: 1 });
  assert.match(d.findings[0], /^segmenter U\+4E2D: native/);
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
  assert.ok(c.includes('é'));
  assert.ok(c.includes('a‮b́'), 'a bidi control inside a would-be cluster');
  assert.ok(c.includes('e\x1b[1ḿ'), 'an escape inside a would-be cluster');
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
  assert.deepStrictEqual(corpusGraphemeBreakTest(gbt), [' ̈', '\u{1f1e6}\u{1f1e7}\u{1f1e8}']);
  const et = '# group: Smileys\n1F600                  ; fully-qualified     # 😀 E1.0 grinning face\n'
    + '2764 FE0F              ; fully-qualified     # ❤️ E0.6 red heart\n';
  assert.deepStrictEqual(corpusEmojiTest(et), ['\u{1f600}', '❤️']);
});
