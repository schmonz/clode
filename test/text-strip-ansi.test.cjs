'use strict';
// Bun.stripANSI is libexec/unicode-text.cjs's stripAnsi (BUN-STRIPANSI), the same escape grammar Bun.stringWidth,
// sliceAnsi and wrapAnsi read. Until 2026-11-27 it was npm strip-ansi (ansi-regex), a second grammar. This file is
// the differential against native and against both old parsers, and the guard that keeps a second grammar out.
//
// The recorded corpus (test/fixtures/strip-ansi-native.json) is the sequences quaude and the bundle really emit or
// read: SGR with 256-colour 38;5;N and 24-bit 38;2;r;g;b, OSC 8 links (BEL and ST), OSC 11/10/4 colour queries, OSC
// 52/133/1337, DECSET (alternate screen, cursor, mouse, focus, bracketed paste) and the pasted-text brackets, kitty
// keyboard queries, xterm modifyOtherKeys, cursor shape, DCS/SOS/PM/APC strings, C1 introducers, cancels, sequences
// the string ends inside, and lone surrogates beside a sequence. Native's answers there are verbatim from 2.1.332.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { stripAnsi, escapeLayer } = require('../libexec/unicode-text.cjs');
const { defineGuard, guardTests } = require('./guard.cjs');
const { stripLineComments, discoverFilesByExt } = require('./source-scan.cjs');

const REPO = path.resolve(__dirname, '..');
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'strip-ansi-native.json'), 'utf8'));
const dropLoneSurrogates = (s) => s.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '');

test('stripAnsi equals native Bun.stripANSI on every recorded case', () => {
  assert.ok(FIXTURE.cases.length >= 70, `${FIXTURE.cases.length} cases`);
  for (const [input, native] of FIXTURE.cases) assert.strictEqual(stripAnsi(input), native, JSON.stringify(input));
});

// Old parser 1: the escape layer is the same grammar; its text differs only by leaving out the lone surrogates of
// the string as given (LONE-SURROGATES-INVISIBLE, what the clusterer must never see), which Bun.stripANSI keeps.
test('stripAnsi is the escape layer\'s grammar: the same text, lone surrogates kept', () => {
  let surrogateRows = 0;
  for (const [input] of FIXTURE.cases) {
    const ours = stripAnsi(input);
    assert.strictEqual(escapeLayer(input).text, stripAnsi(dropLoneSurrogates(input)), JSON.stringify(input));
    if (dropLoneSurrogates(ours) !== ours) surrogateRows++;
  }
  assert.ok(surrogateRows >= 1, 'the corpus must hold a lone surrogate, or this proves nothing about the one difference');
});

// Old parser 2: npm strip-ansi, which backed Bun.stripANSI. Measured 2026-11-27: it disagreed with native on 19 of
// these 74 strings (and on 45,241 of corpusEscapes' 50,081, 184 of corpusLinks' 395, 534 of corpusSliceProbes'
// 4,855, where unicode-text's stripAnsi disagreed on none). These rows are the user-visible ones: text it left
// behind in what Bun.stripANSI's callers measure and compare.
test('npm strip-ansi left text behind where native leaves none (the change this swap makes)', (t) => {
  let sa;
  try { sa = require(path.join(REPO, 'deps', 'claude', 'node_modules', 'strip-ansi')); } catch { return t.skip('deps/claude/node_modules/strip-ansi not installed'); }
  const strip = sa.default || sa;
  const E = '\x1b';
  for (const [input, old] of [
    [`${E}[>4;2m`, '4;2m'], [`${E}[1 q`, ' q'], [`${E}[<0;10;20M`, '0;10;20M'], [`${E}[=5u`, '5u'],
    [`${E}P1$r0m${E}\\`, `1$r0m${E}\\`], [`${E}_apc${E}\\x`, `${E}_apc${E}\\x`], [`x${E}${E}[31my`, `x${E}y`],
  ]) {
    assert.strictEqual(strip(input), old, `strip-ansi on ${JSON.stringify(input)}`);
    const native = FIXTURE.cases.find(([i]) => i === input);
    assert.ok(native, `${JSON.stringify(input)} is a recorded case`);
    assert.strictEqual(stripAnsi(input), native[1]);
    assert.notStrictEqual(native[1], old);
  }
  const differs = FIXTURE.cases.filter(([i, n]) => strip(i) !== n).length;
  assert.strictEqual(differs, 19, 'strip-ansi vs native over the recorded corpus');
});

// Live, when a native oracle is at hand: the parser-state corpora as well (every escape-layer state x two-token
// continuation, every OSC 8 shape, the slice probes). Any native is Bun.stripANSI's oracle; a disagreement is a
// finding, not a version skip.
test('stripAnsi equals live native Bun.stripANSI over the escape, link and slice corpora', (t) => {
  const { resolveNativeOracle, runInNative } = require('../scripts/lib/native-oracle.cjs');
  const bin = resolveNativeOracle();
  if (!bin) return t.skip('no native claude to ask (CLODE_NATIVE_ORACLE / CLODE_NATIVE_CLAUDE)');
  const tc = require('../scripts/lib/text-corpus.cjs');
  const flat = (x) => (Array.isArray(x) ? x.flatMap(flat) : typeof x === 'string' ? [x] : x && typeof x === 'object' ? Object.values(x).flatMap(flat) : []);
  const corpus = [...flat(tc.corpusEscapes()), ...flat(tc.corpusLinks()), ...flat(tc.corpusSliceProbes())];
  assert.ok(corpus.length > 50000, `${corpus.length} strings`);
  const native = runInNative(bin, 'return input.map((s) => Bun.stripANSI(s));', { input: corpus });
  const wrong = corpus.filter((s, i) => stripAnsi(s) !== native[i]);
  assert.deepStrictEqual(wrong.slice(0, 5), [], `${wrong.length} of ${corpus.length} differ`);
});

test('stripAnsi converts its argument as native does', () => {
  assert.strictEqual(stripAnsi(), 'undefined');
  assert.strictEqual(stripAnsi(null), 'null');
  assert.strictEqual(stripAnsi(123), '123');
  assert.strictEqual(stripAnsi({ toString() { return '\x1b[1mz'; } }), 'z');
  assert.strictEqual(stripAnsi(['\x1b[1ma', 'b']), 'a,b');
  assert.throws(() => stripAnsi(Symbol('s')), TypeError);
});

// ==========================================================================
// GUARD: ONE ANSI ESCAPE GRAMMAR IN SHIPPED AND BUILD CODE.
// ==========================================================================
//
// Two grammars meant one string could be "an escape sequence" to Bun.stringWidth and text to Bun.stripANSI. The
// grammar now lives in libexec/unicode-text.cjs (readSequence). A second one is either the npm package that was the
// first second one (strip-ansi, or its ansi-regex), or a regular expression ending a CSI with the final-byte class
// @-~ (scripts/lib/first-run-report.cjs carried one). node-shim's util.stripVTControlCharacters keeps node's own
// regular expression on purpose (node's rule, not Bun's), and tty.cjs's DECSET filter matches one mode list; neither
// is a CSI grammar, and neither carries that class.
const SHAPES = [
  { re: /(?:\brequire|\bimport|_extResolve)\s*\(\s*['"](?:strip-ansi|ansi-regex)['"]|\bfrom\s+['"](?:strip-ansi|ansi-regex)['"]/, what: 'loads npm strip-ansi/ansi-regex' },
  { re: /(?:\\x1b|\\u001b|\\x9b|\\u009b|\\033)[^\n]{0,60}@-~/i, what: 'ends a CSI with a hand-written @-~ final class' },
];
const ONE_MODULE = 'libexec/unicode-text.cjs';

function readSources() {
  const files = [path.join(REPO, 'libexec'), path.join(REPO, 'scripts')]
    .flatMap((d) => discoverFilesByExt(d, ['.cjs', '.js', '.mjs']));
  return { sources: files.map((f) => ({ rel: path.relative(REPO, f).split(path.sep).join('/'), text: stripLineComments(fs.readFileSync(f, 'utf8')) })) };
}

function scanSecondAnsiGrammar({ sources }) {
  const findings = [];
  for (const s of sources) {
    if (s.rel === ONE_MODULE) continue;
    for (const k of SHAPES) if (k.re.test(s.text)) findings.push(`${s.rel}: ${k.what}, a second ANSI escape grammar; strip with ${ONE_MODULE}'s stripAnsi (Bun.stripANSI), read sequences with its escapeLayer`);
  }
  return { findings, examined: sources.length };
}

// Measured 2026-11-27: 186 .cjs/.js/.mjs files under libexec and scripts (node_modules excluded).
guardTests(defineGuard({
  name: 'one-ansi-grammar',
  floor: 150,
  read: readSources,
  scan: scanSecondAnsiGrammar,
  // the defect as it was: bun-shim.cjs's Bun.stripANSI
  control: () => ({ sources: [{ rel: 'libexec/bun-shim.cjs', text: "const _stripAnsiFn   = _extResolve('strip-ansi');" }] }),
}));

test('one-ansi-grammar: each old shape is recognised on its own', () => {
  for (const text of [
    "const _stripAnsiFn   = _extResolve('strip-ansi');",
    "const sa = require('ansi-regex');",
    'const ANSI = /\\x1b\\[[0-?]*[ -/]*[@-~]|\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)/g;',
  ]) {
    const { findings } = scanSecondAnsiGrammar({ sources: [{ rel: 'synthetic.cjs', text }] });
    assert.strictEqual(findings.length, 1, text);
    assert.match(findings[0], /^synthetic\.cjs: .*a second ANSI escape grammar/);
  }
  // tty.cjs's DECSET filter is not a grammar
  assert.deepStrictEqual(scanSecondAnsiGrammar({ sources: [{ rel: 'synthetic.cjs', text: "str.replace(/\\x1b\\[\\?([\\d;]+)h/g, f)" }] }).findings, []);
});
