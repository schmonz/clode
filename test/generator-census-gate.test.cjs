'use strict';
// generator-census-gate.test.cjs — observability Task 4 (plan 2026-10-05, Job 0: "observe our current state more
// accurately than yesterday"). A test file that draws random inputs without a shape census is a finding.
//
// WHY. A property test is only as wide as its generator, and a generator's width was nobody's measurement: the rg-regex
// oracle generator drew ~8,000 patterns from an LCG whose low bits cycle and never once drew a shared branch prefix
// (rg's lift_common_prefix, RG-RE-ALT-LIFT, went unemulated until a reviewer found it, 4ce7800), and when Task 4 measured
// the rest, five more generators in this suite drew from the same JS "LCG" (`seed * 1103515245` rounds past 2^53 into a
// cycle of 10,466 states, or 419): wrapAnsi's 40,000-input property was 1,647 distinct inputs and drew 6 of its 24
// option pairs; the "5 MB minified line" was one 47 KB stretch repeated. test/shape-census.cjs is the instrument; this
// gate makes using it the price of drawing random inputs at all.
//
// THE RULE. Over every git-tracked or new (not ignored) .cjs/.mjs/.js file under test/ and every scripts/gen-* file
// (the generators of test fixtures), comments stripped (test/strip-comments.cjs): a file DRAWS when it holds a random
// source, detected mechanically by DRAW_RES (Math.random, crypto's random*, an LCG multiplier, mulberry32's constant,
// xorshift's 13/17 shifts, test/shape-census.cjs's intRng/mulberry32). A drawing file passes when
//   - it is a *.test.* file whose own code calls census( AND rngBias( (test/shape-census.cjs): its shapes and its RNG; or
//   - it is a helper named in CENSUS_IN with the test file that runs its census: that test must name the helper, and
//     the two together must call census( and rngBias(; or
//   - it is named in EXEMPT with a reason (a random value that is not an input whose shape matters).
// An EXEMPT or CENSUS_IN entry for a file that no longer draws (or no longer exists) is a finding too: a dead entry
// would silently re-admit the file the day it draws again.
//
// BLIND SPOTS, stated once:
// (1) The unit is the FILE. A file with one censused generator and a second uncensused one passes: today that is
//     test/bun-graph.test.cjs's pseudoText (xorshift filler whose only property is that it resists compression; its
//     test checks the frame size it reaches, which is that property measured).
// (2) It checks that a census and a bias check are CALLED, not that they cover every generator in the file or that
//     their shapes are the right ones (the author's claim, read in review; test/shape-census.cjs states the same).
// (3) A random source DRAW_RES does not know (a new PRNG spelled differently) is invisible. The floor below and the
//     drawing-population floor make a detector that went blind red, not one that never saw a new spelling.
//
// THE CONTROL is the pre-fix shape: a test file drawing from the LCG with no census.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { defineGuard, guardTests } = require('./guard.cjs');
const { stripComments } = require('./strip-comments.cjs');

const REPO = path.resolve(__dirname, '..');

// Spelled in pieces so this file's own source does not draw. Review (fix round 1) widened it: crypto's random calls
// bare (destructured: `const { randomInt } = require('node:crypto')`, or webcrypto.getRandomValues), the census
// helpers under an alias (`const { intRng: r } = require(...)`), the other common LCG multipliers (MINSTD 16807 and
// 48271, 69069, MSVC's 214013), and fast-check's properties.
const DRAW_RES = [
  new RegExp(['\\bMath', '\\.random\\s*\\('].join('')),
  new RegExp(['\\b(?:randomBytes|randomInt|randomFillSync|getRandomValues|random', 'UUID)\\s*\\('].join('')),
  new RegExp(['\\b(?:1103', '515245|1664', '525|22695', '477|6364136223', '846793005|168', '07|482', '71|690', '69|2140', '13)\\b'].join('')),
  new RegExp(['0x6D2B', '79F5'].join(''), 'i'),
  new RegExp(['<<\\s*13\\b[^;\\n]*;[^\\n]{0,60}', '>>>\\s*17\\b'].join('')),
  new RegExp(['\\b(?:int', 'Rng|mulberry', '32)\\s*(?:\\(|:)'].join('')),
  new RegExp(['\\bfc\\.(?:property|asyncProperty|assert|sample)\\s*\\(|require\\([\'"]fast-', 'check[\'"]\\)'].join('')),
];
const CENSUS_RE = /\bcensus\s*\(/;
const BIAS_RE = /\brngBias\s*\(/;

const EXEMPT = [
  { file: 'test/guard.test.cjs', because: 'Math.random makes a throwaway guard name unique in the registry; it draws no input' },
  { file: 'test/import-meta-graph.test.cjs', because: 'Math.random makes a scratch file name unique; the file\'s content is fixed' },
  { file: 'test/node-shim-crypto.test.cjs', because: 'the random API is the subject: bounds, call shapes and error classes compared with node, not a generator of inputs' },
  { file: 'test/clode-net.test.cjs', because: 'randomBytes is an incompressible payload for a byte-exact round trip; any bytes are the shape' },
  { file: 'test/generator-census-gate.test.cjs', because: 'this gate\'s own fixtures spell the random sources it detects; it draws nothing' },
];
const CENSUS_IN = [
  { file: 'scripts/gen-rg-regex-oracle.cjs', census: 'test/rg-regex.test.cjs' },
  { file: 'test/rg-bundle-line.cjs', census: 'test/rg-regex.test.cjs' },
  { file: 'test/lead-scrub-oracle.cjs', census: 'test/fidelity/lead-scrub-equivalence.test.cjs' },
  { file: 'test/shape-census.cjs', census: 'test/shape-census.test.cjs' },
];
// Measured 2026-11-19: 14 drawing files of 506. Fewer than this many drawing files means DRAW_RES went blind.
const DRAWING_FLOOR = 10;

const draws = (code) => DRAW_RES.some((re) => re.test(code));
const isTest = (f) => /\.test\.(?:c|m)?js$/.test(f);

// { files: { rel: source } } -> findings
function scanCensus({ files, exempt = EXEMPT, censusIn = CENSUS_IN, drawingFloor = DRAWING_FLOOR }) {
  const findings = [];
  const code = {};
  for (const [f, src] of Object.entries(files)) code[f] = stripComments(src);
  const drawing = Object.keys(code).filter((f) => draws(code[f]));
  const ex = new Map(exempt.map((e) => [e.file, e]));
  const ci = new Map(censusIn.map((e) => [e.file, e]));
  for (const e of exempt) {
    if (typeof e.because !== 'string' || !e.because.trim()) findings.push(`${e.file}: an EXEMPT entry must say why`);
  }
  for (const e of [...exempt, ...censusIn]) {
    if (!(e.file in code)) findings.push(`${e.file}: named in ${ex.has(e.file) ? 'EXEMPT' : 'CENSUS_IN'} but no such file: remove the entry`);
    else if (!draws(code[e.file])) findings.push(`${e.file}: named in ${ex.has(e.file) ? 'EXEMPT' : 'CENSUS_IN'} but it draws nothing: remove the entry`);
  }
  for (const f of drawing) {
    if (ex.has(f)) continue;
    const own = CENSUS_RE.test(code[f]) && BIAS_RE.test(code[f]);
    if (ci.has(f)) {
      const t = ci.get(f).census;
      const tsrc = code[t];
      if (tsrc === undefined) { findings.push(`${f}: its census test ${t} does not exist`); continue; }
      const base = path.basename(f).replace(/\.(?:c|m)?js$/, '');
      if (!tsrc.includes(base)) findings.push(`${f}: its census test ${t} never names it`);
      const both = code[f] + tsrc;
      if (!CENSUS_RE.test(both) || !BIAS_RE.test(both)) findings.push(`${f}: neither it nor ${t} calls census( and rngBias( (test/shape-census.cjs)`);
      continue;
    }
    if (!isTest(f)) { findings.push(`${f}: a helper that draws random inputs: name the test that runs its census in CENSUS_IN`); continue; }
    if (!own) {
      findings.push(`${f}: draws random inputs without a shape census: declare the shapes it must produce and check its RNG `
        + '(census( and rngBias( from test/shape-census.cjs), or name it in EXEMPT with the reason its draws have no shape');
    }
  }
  if (drawing.length < drawingFloor) findings.push(`only ${drawing.length} file(s) draw random inputs (floor ${drawingFloor}): DRAW_RES went blind`);
  return { findings, examined: Object.keys(code).length, note: `${Object.keys(code).length} files, ${drawing.length} drawing: ${drawing.join(', ')}` };
}

function readFiles() {
  let out;
  try {
    out = execFileSync('git', ['-C', REPO, 'ls-files', '--cached', '--others', '--exclude-standard', '--', 'test', 'scripts'], { encoding: 'utf8' });
  } catch (e) { return { skip: `git ls-files failed: ${e.message}` }; }
  const files = {};
  for (const rel of out.split('\n')) {
    if (!/\.(?:c|m)?js$/.test(rel)) continue;
    if (rel.startsWith('scripts/') && !path.basename(rel).startsWith('gen-')) continue;
    const abs = path.join(REPO, rel);
    if (!fs.existsSync(abs)) continue;       // deleted in the work tree, not yet in the index
    files[rel] = fs.readFileSync(abs, 'utf8');
  }
  return { files };
}

const CONTROL_SRC = ['let seed = 7;\nconst rnd = (n) => { seed = (seed * 1103', '515245 + 12345) & 0x7fffffff; return seed % n; };\n',
  "test('a property', () => { for (let i = 0; i < 100; i++) check(rnd(10)); });\n"].join('');

const guard = defineGuard({
  name: 'generator-shape-census',
  // Measured 2026-11-19: 506 files in scope. Under 400 means the walk (git, the scope filter) lost a large part of the tree.
  floor: 400,
  read: readFiles,
  scan: scanCensus,
  control: () => ({ files: { 'test/pre-fix-generator.test.cjs': CONTROL_SRC }, exempt: [], censusIn: [], drawingFloor: 1 }),
});
guardTests(guard);

const S = (files, extra = {}) => scanCensus({ files, exempt: [], censusIn: [], drawingFloor: 0, ...extra }).findings;
const CENSUSED = "const { census, rngBias } = require('./shape-census.cjs');\ncensus('x', [], []); rngBias('x', () => intRng(1), [2]);\n";

test('the control names the pre-fix shape, and a census plus a bias check clears it', () => {
  assert.match(S({ 'test/a.test.cjs': CONTROL_SRC })[0], /^test\/a\.test\.cjs: draws random inputs without a shape census/);
  assert.deepStrictEqual(S({ 'test/a.test.cjs': CONTROL_SRC + CENSUSED }), []);
  // a census without the bias check, or the reverse, is not enough
  assert.strictEqual(S({ 'test/a.test.cjs': `${CONTROL_SRC}census('x', [], []);\n` }).length, 1);
  assert.strictEqual(S({ 'test/a.test.cjs': `${CONTROL_SRC}rngBias('x', f, [2]);\n` }).length, 1);
});

test('every random source DRAW_RES names is detected; a comment is not a draw', () => {
  for (const src of ['x = Math.random();', 'crypto.randomBytes(4)', 'crypto.randomInt(3)', 's = s * 1664525 + 1;',
    'seed = (seed + 0x6d2b79f5) >>> 0;', 'x ^= x << 13; x >>>= 0; x ^= x >>> 17;', 'const r = intRng(5);', 'const f = mulberry32(1);',
    // fix round 1: destructured crypto, webcrypto, aliased helpers, other LCG multipliers, fast-check
    "const { randomInt } = require('node:crypto'); randomInt(3);", 'randomBytes(4)', 'randomFillSync(b)', 'getRandomValues(a)',
    'crypto.webcrypto.getRandomValues(a)', "const { intRng: r } = require('./shape-census.cjs');", "const { mulberry32: m } = S;",
    's = (s * 16807) % 2147483647;', 's = (s * 48271) % 2147483647;', 's = s * 69069 + 1;', 's = s * 214013 + 2531011;',
    'fc.assert(fc.property(fc.string(), f));', "const fc = require('fast-check');"]) {
    assert.strictEqual(S({ 'test/a.test.cjs': src }).length, 1, src);
  }
  assert.deepStrictEqual(S({ 'test/a.test.cjs': '// Math.random() was here\n/* crypto.randomBytes(1) */\n' }), []);
});

test('a helper that draws needs CENSUS_IN; its census test must name it and call both checks', () => {
  assert.match(S({ 'test/gen.cjs': CONTROL_SRC })[0], /a helper that draws random inputs: name the test/);
  const ci = [{ file: 'test/gen.cjs', census: 'test/g.test.cjs' }];
  assert.deepStrictEqual(S({ 'test/gen.cjs': CONTROL_SRC, 'test/g.test.cjs': `require('./gen.cjs');\n${CENSUSED}` }, { censusIn: ci }), []);
  assert.match(S({ 'test/gen.cjs': CONTROL_SRC, 'test/g.test.cjs': CENSUSED }, { censusIn: ci })[0], /never names it/);
  assert.match(S({ 'test/gen.cjs': CONTROL_SRC, 'test/g.test.cjs': "require('./gen.cjs');" }, { censusIn: ci })[0], /calls census\( and rngBias\(/);
});

test('an exemption needs a reason and a file that still draws; a blind detector is a finding', () => {
  assert.deepStrictEqual(S({ 'test/a.test.cjs': CONTROL_SRC }, { exempt: [{ file: 'test/a.test.cjs', because: 'names only' }] }), []);
  assert.match(S({ 'test/a.test.cjs': CONTROL_SRC }, { exempt: [{ file: 'test/a.test.cjs', because: ' ' }] })[0], /must say why/);
  assert.match(S({ 'test/a.test.cjs': 'x = 1;' }, { exempt: [{ file: 'test/a.test.cjs', because: 'r' }] })[0], /draws nothing: remove the entry/);
  assert.match(S({}, { exempt: [{ file: 'test/gone.test.cjs', because: 'r' }] })[0], /no such file/);
  assert.match(S({ 'test/a.test.cjs': 'x = 1;' }, { drawingFloor: 1 })[0], /DRAW_RES went blind/);
});
