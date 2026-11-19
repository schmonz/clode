'use strict';
// The build gates of quaude's rg regex dialect (grep-native Task 5b), each with its control:
//
//   rg-regex-refuses       libexec/rg-regex.cjs refuses, BY NAME, every pattern it cannot answer
//                          exactly and every pattern rg itself rejects (rc 2 in native). A
//                          refusal that went missing would answer where native errors, or answer
//                          a construct it reads differently: the silent wrong answer this whole
//                          plan exists to end. Control: a refusal claimed for a pattern the gate
//                          answers, which this guard must report.
//   rg-regex-data-fresh    scripts/gen-rg-regex-data.cjs's --check verdict (staleness) over
//                          libexec/rg-regex.cjs's GENERATED region, against the pinned native's
//                          own rg: its \w \d \s, POSIX classes and case folding, read from native.
//   rg-regex-oracle-fresh  scripts/gen-rg-regex-oracle.cjs's --check verdict over
//                          test/fixtures/rg-regex-oracle.json (the property test's oracle).
//     Both: an upstream bump whose embedded rg reads a class, a fold or a match differently
//     fails HERE, naming what moved. The provider is pin-exact, so a native whose embedded rg is
//     not the one an artifact was generated from IS such a bump: a finding saying to regenerate
//     (review I1), never a skip. Controls: a planted difference, run through the generator's OWN
//     staleness(), which must name it.
//
// The literal relative requires below are load-bearing for the production-gate population sweep
// (test/guards-population.cjs), which derives "which guard controls this production gate" from them.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const assert = require('node:assert');
const { defineGuard, guardTests } = require('../guard.cjs');
const rgRegex = require('../../libexec/rg-regex.cjs');
const genData = require('../../scripts/gen-rg-regex-data.cjs');
const genOracle = require('../../scripts/gen-rg-regex-oracle.cjs');
const { providerBin } = require('../provider-resolve.cjs');
const { nativeRgVersion } = require('../../scripts/lib/rg-probe.cjs');

const REPO = path.resolve(__dirname, '..', '..');

// ---- rg-regex-refuses ----------------------------------------------------------------------------
// [pattern, the rule that must refuse it]. The rgRejects rows carry native's own message (rc 2,
// 2.1.283's embedded rg, measured 2026-10-03); the others are constructs native answers and
// quaude's rg cannot answer exactly.
const MUST_REFUSE = [
  ['(', 'RG-RE-REFUSE-SYNTAX'],                  // error: unclosed group
  ['a)', 'RG-RE-REFUSE-SYNTAX'],                 // error: unopened group
  ['[^]', 'RG-RE-REFUSE-SYNTAX'],                // error: unclosed character class
  ['a{', 'RG-RE-REFUSE-SYNTAX'],                 // error: repetition quantifier expects a valid decimal
  ['a{2,1}', 'RG-RE-REFUSE-SYNTAX'],             // error: invalid repetition count range
  ['|*', 'RG-RE-REFUSE-SYNTAX'],                 // error: repetition operator missing expression
  ['\\8', 'RG-RE-REFUSE-SYNTAX'],                // backreferences are not supported
  ['(?<!a)b', 'RG-RE-REFUSE-SYNTAX'],            // look-around is not supported
  ['\\x{110000}', 'RG-RE-REFUSE-SYNTAX'],        // hexadecimal literal is not a Unicode scalar value
  ['(?--i)', 'RG-RE-REFUSE-SYNTAX'],             // flag negation operator repeated
  ['(?P<1>a)', 'RG-RE-REFUSE-SYNTAX'],           // invalid capture group character
  ['[\\A]', 'RG-RE-REFUSE-SYNTAX'],              // invalid escape sequence found in character class
  ['[\\d-z]', 'RG-RE-REFUSE-SYNTAX'],            // invalid range boundary, must be a literal
  ['\\b{start', 'RG-RE-REFUSE-SYNTAX'],          // special word boundary assertion is either unclosed or ...
  ['x\\x0Ay', 'RG-RE-REFUSE-NEWLINE'],           // the literal '\n' is not allowed
  ['\\x00', 'RG-RE-REFUSE-NUL'],                 // binary detection is enabled and matching a NUL byte is impossible
  ['\\p{L}', 'RG-RE-REFUSE-UNICODE-CLASS'],
  ['\\z', 'RG-RE-REFUSE-TEXT-ANCHOR'],
  ['(?-u:\\xFF)', 'RG-RE-REFUSE-BYTES'],
  ['(?x) a', 'RG-RE-REFUSE-VERBOSE'],
  ['(?R)$', 'RG-RE-REFUSE-CRLF'],
  ['[[a]]', 'RG-RE-REFUSE-CLASS-SET'],
  ['[ab]|\\n', 'RG-RE-REFUSE-NEWLINE'],         // a class and a character do not merge: the literal '\n' is not allowed
  ['a{40000}b{40000}', 'RG-RE-REFUSE-SIZE'],
  ['\\w{2500}', 'RG-RE-REFUSE-SIZE-LIMIT'],         // compiled regex exceeds size limit of 104857600
];
function scanRefusals({ cases }) {
  const findings = [];
  for (const [pattern, rule] of cases) {
    const t = rgRegex.translateRgRegex(pattern, {});
    if (!t.refuse) findings.push(`${JSON.stringify(pattern)} must refuse (${rule}) and was answered (prefilter ${JSON.stringify(t.prefilter)})`);
    else if (t.rule !== rule) findings.push(`${JSON.stringify(pattern)} must refuse as ${rule}, refused as ${t.rule}`);
    else if (!t.refuse.includes(rule) || !/quaude answers rg/.test(t.refuse)) findings.push(`${JSON.stringify(pattern)}: the reason does not name ${rule} as quaude's rg's refusal`);
  }
  return { findings, examined: cases.length, note: 'patterns that must refuse' };
}
const refusesGuard = defineGuard({
  name: 'rg-regex-refuses',
  floor: MUST_REFUSE.length,
  read: () => ({ cases: MUST_REFUSE }),
  scan: scanRefusals,
  // `needle` is answered: claiming it must refuse is the violation the guard must report.
  control: () => ({ cases: [['needle', 'RG-RE-REFUSE-SYNTAX']] }),
});
guardTests(refusesGuard);

// The run-time refusals (a line's look-behind, a line's cost) are judged per line, not per
// pattern; test/rg-regex.test.cjs and test/rg-native.test.cjs pin them, as it pins the non-ASCII one.
test('rg-regex-refuses covers every stated refusal but the run-time ones', () => {
  const covered = new Set(MUST_REFUSE.map(([, r]) => r));
  const stated = Object.keys(rgRegex.REFUSALS).filter((r) => !['RG-RE-REFUSE-LOOKBEHIND', 'RG-RE-REFUSE-COST', 'RG-RE-REFUSE-CAPTURE-NAME'].includes(r));
  assert.deepStrictEqual(stated.filter((r) => !covered.has(r)), []);
});

// ---- rg-regex-data-fresh / rg-regex-oracle-fresh -------------------------------------------------
// The rg version line a generated artifact names, or the problem that stops it being read. A
// missing or garbled header is a FINDING, never a skip: "nothing to compare" is exactly what a
// broken splice looks like.
function dataHeader(src) {
  const m = src.match(/const RG_REGEX_DATA = (\{.*\});\n/);
  if (!m) return { problem: 'libexec/rg-regex.cjs has no generated `const RG_REGEX_DATA = {...};` line: the region is missing or reshaped' };
  try {
    const h = JSON.parse(m[1]).header;
    return h && typeof h.rg === 'string' && h.rg ? { rg: h.rg } : { problem: 'libexec/rg-regex.cjs\'s RG_REGEX_DATA header names no rg version' };
  } catch (e) { return { problem: `libexec/rg-regex.cjs's RG_REGEX_DATA does not parse: ${e.message}` }; }
}
function oracleHeader(text) {
  try {
    const o = JSON.parse(text);
    return typeof o.rg === 'string' && o.rg && Array.isArray(o.cases) ? { rg: o.rg } : { problem: 'test/fixtures/rg-regex-oracle.json names no rg version or no cases' };
  } catch (e) { return { problem: `test/fixtures/rg-regex-oracle.json does not parse: ${e.message}` }; }
}
// null when the pinned native's rg is the one the artifact was generated from, else the finding.
function versionProblem(artifact, generatedFrom, nativeVersionText) {
  const pinned = String(nativeVersionText).split('\n')[0];
  return pinned === generatedFrom ? null
    : `regenerate: ${artifact} was generated from ${generatedFrom}, the pinned native's rg is ${pinned}`;
}
// read(): the artifact as committed, and the generator's regeneration of it from native (--emit).
function readFresh(artifact, header, generator) {
  const current = fs.readFileSync(path.join(REPO, artifact), 'utf8');
  const { rg, problem } = header(current);
  if (problem) return { problem };
  const bin = providerBin(process.env);
  if (!bin) return { skip: `no native provider (CLODE_PROVIDER_BIN or the pinned version): ${artifact} was generated from ${rg}` };
  const v = nativeRgVersion(bin);
  if (!v) return { skip: `the provider ${bin} did not answer as rg here` };
  const moved = versionProblem(artifact, rg, v);
  if (moved) return { problem: moved };
  const r = spawnSync(process.execPath, [path.join(REPO, 'scripts', generator), '--native', bin, '--emit'],
    { encoding: 'utf8', timeout: 600000, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return { problem: `${generator} --emit failed (exit ${r.status}): ${(r.stderr || '').slice(-1500)}` };
  return { current, regenerated: r.stdout };
}
const scanWith = (staleness) => ({ current, regenerated, problem }) => (problem
  ? { examined: 1, findings: [problem] }
  : { examined: 1, findings: staleness(current, regenerated) });

guardTests(defineGuard({
  name: 'rg-regex-data-fresh',
  read: () => readFresh('libexec/rg-regex.cjs', dataHeader, 'gen-rg-regex-data.cjs'),
  scan: scanWith(genData.staleness),
  control: () => {
    const cur = fs.readFileSync(path.join(REPO, 'libexec', 'rg-regex.cjs'), 'utf8');
    return { current: cur, regenerated: cur.replace(/"digit":"[^"]*"/, '"digit":"1c,9"') };
  },
}));
guardTests(defineGuard({
  name: 'rg-regex-oracle-fresh',
  read: () => readFresh('test/fixtures/rg-regex-oracle.json', oracleHeader, 'gen-rg-regex-oracle.cjs'),
  scan: scanWith(genOracle.staleness),
  control: () => {
    const cur = fs.readFileSync(path.join(REPO, 'test', 'fixtures', 'rg-regex-oracle.json'), 'utf8');
    const o = JSON.parse(cur);
    o.cases[0][2] = 'planted';
    return { current: cur, regenerated: JSON.stringify(o) };
  },
}));

// ---- rg-bundle-line-fresh (observability Task 4, review fix round 1) ----------------------------
// test/rg-bundle-line.cjs's NATIVE_BUNDLE_LINE, hand-pinned from native over the 5 MB minified line, re-measured from
// the pinned provider's own rg. A native whose rg is not the one the rows were measured from is a finding (re-measure),
// as above. Control: a planted digest, through the module's own bundleStaleness(), which must name it.
const bundle = require('../rg-bundle-line.cjs');
guardTests(defineGuard({
  name: 'rg-bundle-line-fresh',
  read: () => {
    const bin = providerBin(process.env);
    if (!bin) return { skip: `no native provider (CLODE_PROVIDER_BIN or the pinned version): the rows were measured from ${bundle.NATIVE_BUNDLE_RG}` };
    const v = nativeRgVersion(bin);
    if (!v) return { skip: `the provider ${bin} did not answer as rg here` };
    const moved = versionProblem('test/rg-bundle-line.cjs NATIVE_BUNDLE_LINE', bundle.NATIVE_BUNDLE_RG, v);
    if (moved) return { problem: moved };
    return { pinned: bundle.NATIVE_BUNDLE_LINE, measured: bundle.measureNative(bin) };
  },
  scan: ({ pinned, measured, problem }) => (problem ? { examined: 1, findings: [problem] }
    : { examined: measured.length, findings: bundle.bundleStaleness(pinned, measured) }),
  control: () => ({ pinned: bundle.NATIVE_BUNDLE_LINE,
    measured: bundle.NATIVE_BUNDLE_LINE.map((r, i) => (i === 0 ? [r[0], r[1], 'planted'] : r)) }),
}));

test('a missing or garbled generated header is a finding, not a skip', () => {
  assert.match(dataHeader("'use strict';\n").problem, /no generated `const RG_REGEX_DATA/);
  assert.match(dataHeader('const RG_REGEX_DATA = {"header":};\n').problem, /does not parse/);
  assert.match(dataHeader('const RG_REGEX_DATA = {"header":{"rg":""}};\n').problem, /names no rg version/);
  assert.match(oracleHeader('{').problem, /does not parse/);
  assert.match(oracleHeader('{"rg":"x"}').problem, /no cases/);
  assert.match(dataHeader(fs.readFileSync(path.join(REPO, 'libexec', 'rg-regex.cjs'), 'utf8')).rg, /^ripgrep \d+\.\d+\.\d+/);
  assert.match(oracleHeader(fs.readFileSync(path.join(REPO, 'test', 'fixtures', 'rg-regex-oracle.json'), 'utf8')).rg, /^ripgrep \d+\.\d+\.\d+/);
});

// The provider is pin-exact, so a native whose embedded rg is not the one an artifact was generated
// from IS an upstream bump: a finding naming both and the remedy, never a skip (review I1).
test('a pinned native whose rg differs from the generated one is a finding, not a skip', () => {
  assert.deepStrictEqual(versionProblem('libexec/rg-regex.cjs', 'ripgrep 14.1.1 (rev a)', 'ripgrep 14.1.1 (rev a)\nfeatures'), null);
  assert.match(versionProblem('libexec/rg-regex.cjs', 'ripgrep 14.1.1 (rev a)', 'ripgrep 15.0.0 (rev b)\nfeatures'),
    /regenerate: libexec\/rg-regex\.cjs was generated from ripgrep 14\.1\.1 \(rev a\), the pinned native's rg is ripgrep 15\.0\.0 \(rev b\)/);
});

test('the generators\' staleness names what moved', () => {
  const cur = fs.readFileSync(path.join(REPO, 'libexec', 'rg-regex.cjs'), 'utf8');
  assert.deepStrictEqual(genData.staleness(cur, cur), []);
  assert.match(genData.staleness(cur, cur.replace(/"digit":"[^"]*"/, '"digit":"1c,9"'))[0], /: digit$/);
  const o = fs.readFileSync(path.join(REPO, 'test', 'fixtures', 'rg-regex-oracle.json'), 'utf8');
  assert.deepStrictEqual(genOracle.staleness(o, o), []);
  const p = JSON.parse(o);
  p.cases[3][2] = 'planted';
  assert.match(genOracle.staleness(o, JSON.stringify(p))[0], /answers 1 case\(s\) otherwise/);
});
