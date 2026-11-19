'use strict';
// rg-bundle-line.cjs — a minified bundle's one line, synthesized (seeded code-like tokens; 5,000,000 bytes, then \n):
// the size of slice where a flat per-line budget refused ordinary patterns (review N1; the pinned carve's own extracted
// bundle is one 59 MB line). Shared by test/rg-regex.test.cjs (the matcher) and test/rg-native.test.cjs (both ugrep
// twins), which held identical copies until observability Task 4; its shape census runs in test/rg-regex.test.cjs.
//
// THE RNG (Task 4). The copies drew with `seed = (seed * 1103515245 + 12345) & 0x7fffffff; T[seed % T.length]`. In JS
// that product (about 2^61) is past a double's 53 bits and rounds, so the state fell into a cycle of 10,466 states
// (measured 2026-11-19: a 4,003-draw lead-in, then the cycle), and the "5 MB line" was one ~47 KB stretch of tokens
// repeated about 100 times: 14,469 distinct 8-token runs in 1,289,171. It now draws from test/shape-census.cjs's
// intRng, and the census counts the distinct runs. NATIVE_BUNDLE_LINE was re-measured from native 2.1.283's embedded rg over the new line the same day.
const { intRng, census, rngBias, firstSighting } = require('./shape-census.cjs');

const SEED = 7;
const T = ['var ', 'let ', 'const ', 'function ', 'return ', 'import ', ' from ', 'new ', 'TypeError', 'RangeError', 'this.', '=>', '{', '}', '(', ')',
  '[', ']', ';', ',', '.', '=', '+', '"use strict"', '"a,b"', "'x'", '0', '42', '0x1f', 'foo', 'bar_baz', 'qux9', '$el', 'require', ' ', 'if(', 'else'];

// the token indices of a line of n bytes
function bundleTokens(n = 5000000, rnd = intRng(SEED)) {
  const idx = [];
  let len = 0;
  while (len < n) { const i = rnd(T.length); idx.push(i); len += T[i].length; }
  return idx;
}
function bundleLine(n = 5000000) {
  return Buffer.from(bundleTokens(n).map((i) => T[i]).join('').slice(0, n) + '\n');
}

// native 2.1.283's --json over that line: [pattern, submatches, sha256(JSON [[start,end]...]) prefix]
const NATIVE_BUNDLE_LINE = [
  ['\\w+Error', 64660, '23ef86fe587776a79663'], ['import.*from', 1, '4a958576355f9660d9cf'], ['"[^"]*"', 70013, 'e4349df8f56b6d30a9d2'],
  ['[a-zA-Z_]\\w*\\(', 43715, '245bb4e298716816e51b'], ['\\w+', 711795, '46a3c478b8a8ab6af1aa'], ['x|', 4894633, '6959e2ed75bd3b0b2e9d'],
];

// THE CENSUS. Samples: each 8-token run (a window sliding one token at a time). Floors measured 2026-11-19 on the
// intRng line: 1,293,344 runs, every one distinct; Error after a word character 20,672; identifier before ( 10,279.
const RUN = 8;
function runs(idx) {
  const out = [];
  for (let i = 0; i + RUN <= idx.length; i++) { let k = 0; for (let j = 0; j < RUN; j++) k = k * T.length + idx[i + j]; out.push({ k, a: idx[i], b: idx[i + 1] }); }
  return out;
}
const WORDISH = new Set(T.map((t, i) => (/\w$/.test(t) ? i : -1)).filter((i) => i >= 0));
const ERR = new Set([T.indexOf('TypeError'), T.indexOf('RangeError')]);
const SHAPES = () => [
  { shape: 'a distinct 8-token run', min: 900000, has: firstSighting((r) => r.k),
    why: 'the line must not be one stretch repeated: 1,293,344 of 1,293,344 measured; the float-rounded LCG gave 14,469' },
  { shape: '`Error` straight after a word character (\\w+Error spans tokens)', min: 2000, has: (r) => WORDISH.has(r.a) && ERR.has(r.b),
    why: 'the pinned pattern spans tokens only here; a tenth of the 20,672 measured' },
  { shape: 'an identifier straight before `(`', min: 2000, has: (r) => WORDISH.has(r.a) && T[r.b] === '(', why: 'a fifth of the 10,279 measured, for [a-zA-Z_]\\w*\\(' },
];
function bundleCensus() {
  const idx = bundleTokens();
  const moduli = [T.length];
  return [census('rg-bundle-line tokens', SHAPES(), runs(idx)), rngBias('rg-bundle-line RNG', () => intRng(SEED), moduli)];
}

module.exports = { bundleLine, bundleTokens, NATIVE_BUNDLE_LINE, bundleCensus, T, SEED };
