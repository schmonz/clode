'use strict';
// The pure halves of the Unicode-table pipeline: scripts/lib/ucd.cjs (pinned UCD inputs)
// and the table-building functions scripts/gen-unicode-data.cjs exports. No network, no
// native Claude: every input here is a literal built in this file.
const test = require('node:test');
const assert = require('node:assert');
const { parseRanges, verifyText } = require('../scripts/lib/ucd.cjs');
const { toRanges, toSpans, ambiguousFrom, eawAssigned, eawPredicted, widthDisagreements, describeDrift } = require('../scripts/gen-unicode-data.cjs');

test('parseRanges reads single points, ranges and a sub-field', () => {
  const t = '0600..0605    ; Prepend # Cf   [6] ARABIC NUMBER SIGN..\n00AD          ; Control\n# c\n';
  assert.deepStrictEqual(parseRanges(t), [[0x600, 0x605, 'Prepend'], [0xad, 0xad, 'Control']]);
  const d = '094D          ; InCB; Linker # Mn       DEVANAGARI SIGN VIRAMA\n0915..0939 ; InCB; Consonant # Lo\n0300 ; Alphabetic # x\n';
  assert.deepStrictEqual(parseRanges(d, 'InCB'), [[0x94d, 0x94d, 'Linker'], [0x915, 0x939, 'Consonant']]);
});

test('verifyText refuses bytes that do not match the pin', () => {
  assert.throws(() => verifyText('hello', { sha256: '0'.repeat(64), url: 'u' }), /sha256 mismatch/);
  assert.throws(() => verifyText('hello', { url: 'u' }), /no sha256 pin/);
  // and the right pin passes the text through untouched
  const good = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
  assert.strictEqual(verifyText('hello', { sha256: good, url: 'u' }), 'hello');
});

test('toRanges run-length encodes and keeps only the values asked for', () => {
  const a = Uint8Array.from([1, 1, 2, 2, 2, 1, 0, 0]);
  assert.deepStrictEqual(toRanges(a, (v) => v !== 1), [2, 4, 2, 6, 7, 0]);
  assert.deepStrictEqual(toRanges(a, (v) => v === 1), [0, 1, 1, 5, 5, 1]);
});

// Controller ruling R5: the table encodes "ambiguous" as ONE flag meaning "1 when
// ambiguousIsNarrow, 2 otherwise". Any other narrow/wide pair cannot be represented, so
// the generator refuses rather than writing a table that lies about it.
test('ambiguousFrom flags 1 -> 2 and refuses every other narrow/wide difference (R5)', () => {
  assert.deepStrictEqual(Array.from(ambiguousFrom(Uint8Array.from([1, 1, 0, 2]), Uint8Array.from([1, 2, 0, 2]))), [0, 1, 0, 0]);
  assert.throws(() => ambiguousFrom(Uint8Array.from([1, 0, 2]), Uint8Array.from([1, 1, 1])),
    (e) => /2 code point\(s\).*U\+0001 narrow 0 wide 1.*U\+0002 narrow 2 wide 1/s.test(e.message));
});

// Controller ruling R6: "assigned" = covered by an explicit EastAsianWidth.txt line; the
// `# @missing` defaults (whole unassigned CJK planes default to W) are comments here and
// count as UNASSIGNED, so a version-choice count can say how much of it is real.
test('eawAssigned counts explicit lines only; @missing defaults stay unassigned', () => {
  const t = '# @missing: 0000..10FFFF; N\n# @missing: 3400..4DBF; W\n3400..3402 ; W  # Lo\n00A1 ; A # Po\n';
  const a = eawAssigned(t);
  assert.deepStrictEqual([a[0x3400], a[0x3402], a[0x3403], a[0xa1], a[0x41]], [1, 1, 0, 1, 0]);
});

test('eawPredicted: W, F and Emoji_Presentation are 2, everything else 1', () => {
  const eaw = '1100 ; W # Lo\nFF01 ; F # Po\n00A1 ; A # Po\n';
  const emoji = '231A ; Emoji_Presentation # E0.6\n00A9 ; Extended_Pictographic # E0.6\n';
  const p = eawPredicted(eaw, emoji);
  assert.deepStrictEqual([p[0x1100], p[0xff01], p[0x231a], p[0xa1], p[0xa9], p[0x41]], [2, 2, 2, 1, 1, 1]);
});

test('widthDisagreements splits assigned from unassigned and skips zero-width and C0', () => {
  const nat = new Uint8Array(0x110000).fill(1);
  const pred = new Uint8Array(0x110000).fill(1);
  const assigned = new Uint8Array(0x110000);
  nat[0x3400] = 2; assigned[0x3400] = 1;          // assigned disagreement
  nat[0x20000] = 2;                                // unassigned (a @missing W default)
  nat[0x0300] = 0; pred[0x0300] = 1;               // zero-width: never counted
  nat[0x0007] = 2;                                 // below U+0020: never counted
  const r = widthDisagreements(pred, nat, assigned);
  assert.strictEqual(r.assigned, 1);
  assert.strictEqual(r.unassigned, 1);
  assert.strictEqual(r.total, 2);
  assert.deepStrictEqual(r.assignedCodePoints, [0x3400]);
});

test('toSpans drops the value column; describeDrift names the code points a regeneration moves', () => {
  assert.deepStrictEqual(toSpans(Uint8Array.from([0, 1, 1, 0, 1])), [1, 2, 4, 4]);
  const was = { header: { unicode: '16.0.0' }, gcb: [], incb: [], extPict: [], width: [0x300, 0x301, 0], ambiguous: [], overrides: [] };
  const now = { header: { unicode: '16.0.0' }, gcb: [], incb: [], extPict: [], width: [0x300, 0x300, 0], ambiguous: [], overrides: [] };
  assert.deepStrictEqual(describeDrift(was, now), ['width: 1 code point(s) change: U+0301 0 -> 1']);
  assert.deepStrictEqual(describeDrift(was, { ...was, header: { unicode: '17.0.0' } }), ['header.unicode: "16.0.0" -> "17.0.0"']);
});

test('download retries, then names every failed attempt', async () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const { pathToFileURL } = require('node:url');
  const { download } = require('../scripts/lib/ucd.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucd-dl-'));
  try {
    const src = path.join(dir, 'src.txt'); fs.writeFileSync(src, '0041 ; L\n');
    await download(pathToFileURL(src).href, path.join(dir, 'a', 'b.txt'), { attempts: 2, delayMs: 1 });
    assert.strictEqual(fs.readFileSync(path.join(dir, 'a', 'b.txt'), 'utf8'), '0041 ; L\n');
    await assert.rejects(download(pathToFileURL(path.join(dir, 'absent.txt')).href, path.join(dir, 'c.txt'), { attempts: 2, delayMs: 1 }),
      (e) => /could not download .*attempt 1: .*; attempt 2: /.test(e.message));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('mapValues refuses a class name the generator does not know, even an inherited one', () => {
  const { mapValues } = require('../scripts/gen-unicode-data.cjs');
  const t = { Linker: 1 };
  assert.strictEqual(mapValues([[0x94d, 0x94d, 'Linker']], t, 'InCB')[0x94d], 1);
  assert.throws(() => mapValues([[0x41, 0x41, 'Brand_New']], t, 'InCB'), /InCB: unknown value "Brand_New" at U\+0041/);
  assert.throws(() => mapValues([[0x41, 0x41, 'toString']], t, 'InCB'), /unknown value "toString"/);
});

test('emojiNotWidthBase files the Emoji native did not cap under the override, and refuses a broken probe', () => {
  const { emojiNotWidthBase, propertySet } = require('../scripts/gen-unicode-data.cjs');
  // emoji-data shape: propertySet reads one property's lines and nothing else.
  const emoji = propertySet('0023 ; Emoji # x\n00A9 ; Emoji # x\n203C ; Emoji # x\n2605 ; Extended_Pictographic # x\n', 'Emoji');
  assert.deepStrictEqual(toSpans(emoji), [0x23, 0x23, 0xa9, 0xa9, 0x203c, 0x203c]);
  // The `base` probe's answers, shaped as native gave them on 2026-09-24: a sum (4) for
  // U+0023 and U+00A9, the cap (2) for U+203C; a non-Emoji code point is not consulted.
  const base = new Int16Array(0x110000);
  base[0x23] = 4; base[0xa9] = 4; base[0x203c] = 2; base[0x2605] = 4;
  assert.deepStrictEqual(toSpans(emojiNotWidthBase(emoji, base)), [0x23, 0x23, 0xa9, 0xa9]);
  // -1 = native did not make `X U+0903 U+0903 U+0903 U+200D` one cell: the probe is broken.
  base[0xa9] = -1;
  assert.throws(() => emojiNotWidthBase(emoji, base), /1 Emoji code point\(s\) did not come back as one cell .*U\+00A9; refusing/);
});

// test/run.mjs runs the suite with CLODE_OFFLINE=1 by default. A cold UCD cache offline is
// a missing precondition — refused by name, with its own exit status (3), BEFORE the
// generator needs a native at all — never a silent network fetch and never a red table.
test('offline: a cold cache refuses without fetching, and the generator maps it to exit 3', async () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const { download, fetchVerified, UcdOfflineMiss } = require('../scripts/lib/ucd.cjs');
  const { main, exitCodeFor } = require('../scripts/gen-unicode-data.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucd-offline-'));
  try {
    await assert.rejects(download('https://www.unicode.org/Public/17.0.0/ucd/EastAsianWidth.txt', path.join(dir, 'x.txt'), { offline: true }),
      (e) => e instanceof UcdOfflineMiss && /CLODE_OFFLINE=1/.test(e.message));
    assert.strictEqual(fs.existsSync(path.join(dir, 'x.txt')), false);
    await assert.rejects(fetchVerified('17.0.0', 'EastAsianWidth', { cacheDir: dir, offline: true }),
      (e) => e.name === 'UcdOfflineMiss' && /17\.0\.0.EastAsianWidth\.txt is not cached/.test(e.message));
    // no native exists at this path: an offline miss must be reported before it is needed
    await assert.rejects(main(['--native', path.join(dir, 'no-such-claude'), '--check'], { CLODE_OFFLINE: '1', CLODE_CACHE: dir }),
      (e) => exitCodeFor(e) === 3);
    assert.strictEqual(exitCodeFor(new Error('sha256 mismatch')), 2);
    // --ucd-readonly: an empty read-only dir changes nothing offline (still the named miss, exit 3); a missing value
    // is a usage refusal.
    await assert.rejects(main(['--native', path.join(dir, 'no-such-claude'), '--check', '--ucd-readonly', path.join(dir, 'ro')],
      { CLODE_OFFLINE: '1', CLODE_CACHE: dir }), (e) => exitCodeFor(e) === 3);
    await assert.rejects(main(['--native', 'x', '--ucd-readonly'], { CLODE_OFFLINE: '1', CLODE_CACHE: dir }), /--ucd-readonly needs a directory/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// readOnlyDir. linux-x64-pty (CI 44460009323): all six text-diff gates SKIPPED offline under the suite's throwaway
// HOME, though CI's warm-up step had cached every pinned input in the runner's real cache. That cache now reaches the
// tests as a READ-ONLY input (test/ucd-input.cjs): read, never written, and trusted only for bytes matching the pin.
test('readOnlyDir: a pinned copy there is used offline; a wrong one is passed over; nothing is written anywhere', async () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const crypto = require('node:crypto');
  const { fetchVerified, UcdOfflineMiss } = require('../scripts/lib/ucd.cjs');
  const seed = fs.mkdtempSync(path.join(os.tmpdir(), 'ucd-seed-'));
  const own = fs.mkdtempSync(path.join(os.tmpdir(), 'ucd-own-'));
  const text = '# planted emoji-test\n';
  const pinsTable = { '9.9.9': { 'emoji-test': { url: 'https://example.invalid/emoji-test.txt',
    sha256: crypto.createHash('sha256').update(text).digest('hex') } } };
  const listAll = (d) => fs.readdirSync(d, { recursive: true }).sort();
  try {
    fs.mkdirSync(path.join(seed, '9.9.9'));
    const opts = { cacheDir: own, offline: true, readOnlyDir: seed, pinsTable };
    // CONTROL: the input missing -> the named offline miss (the caller's skip), and nothing fetched or written.
    await assert.rejects(fetchVerified('9.9.9', 'emoji-test', opts), (e) => e instanceof UcdOfflineMiss);
    // Bytes that do not match the pin are never used.
    fs.writeFileSync(path.join(seed, '9.9.9', 'emoji-test.txt'), 'tampered\n');
    await assert.rejects(fetchVerified('9.9.9', 'emoji-test', opts), (e) => e instanceof UcdOfflineMiss);
    // The pinned bytes are used, offline.
    fs.writeFileSync(path.join(seed, '9.9.9', 'emoji-test.txt'), text);
    assert.strictEqual(await fetchVerified('9.9.9', 'emoji-test', opts), text);
    assert.deepStrictEqual(listAll(own), [], 'the suite\'s own cache was never written');
    assert.deepStrictEqual(listAll(seed), ['9.9.9', path.join('9.9.9', 'emoji-test.txt')]);
    assert.strictEqual(fs.readFileSync(path.join(seed, '9.9.9', 'emoji-test.txt'), 'utf8'), text, 'the read-only copy is unchanged');
  } finally {
    fs.rmSync(seed, { recursive: true, force: true }); fs.rmSync(own, { recursive: true, force: true });
  }
});

test('the suite hands the real UCD cache over by name, and the text gates read it through test/ucd-input.cjs', () => {
  const fs = require('node:fs'); const path = require('node:path');
  const { ucdInputOptions } = require('./ucd-input.cjs');
  const o = ucdInputOptions({ CLODE_TEST_UCD_CACHE: '/named/unicode', CLODE_OFFLINE: '1', CLODE_CACHE: '/suite/cache' });
  assert.deepStrictEqual(o, { cacheDir: path.join('/suite/cache', 'unicode'), offline: true, readOnlyDir: '/named/unicode' });
  assert.ok(process.env.CLODE_TEST_UCD_CACHE, 'suite-home.cjs sets CLODE_TEST_UCD_CACHE');
  // The freshness gate's generator is a product script: it gets the input as an argument, never a test env name.
  assert.match(fs.readFileSync(path.join(__dirname, 'unicode-data-fresh.test.cjs'), 'utf8'), /'--ucd-readonly', ro/);
  for (const f of ['fidelity/text-differential.test.cjs', 'unicode-text.test.cjs']) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    assert.match(src, /ucdInput\(/, `${f} reads its UCD input through test/ucd-input.cjs`);
    assert.doesNotMatch(src, /fetchVerified\(/, `${f} must not read the suite home's cache directly`);
  }
});
