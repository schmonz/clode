'use strict';
// rg-regex-census.cjs — the shape census of the rg-regex property test's generator (scripts/gen-rg-regex-oracle.cjs),
// observability Task 4. A module of its own (not inside test/rg-regex.test.cjs) so the same census can be pointed at
// ANOTHER generator: the red-first evidence runs it over the pre-fix generator of 4ce7800^ (see the task report).
//
// What it claims. The generator's header promises alternation, every repetition (greedy, lazy, counted, nested, over
// empty-matching subs), every assertion, groups, the i flag, and a corpus of case-folding specials and invalid UTF-8.
// Its 4ce7800 fix adds the LIFT FAMILY: alternations whose branches share a prefix, which rg lifts out
// (RG-RE-ALT-LIFT) and which the pre-fix generator never once drew in about 8,000 patterns. Each shape below is one
// of those promises, detected on the parsed pattern (libexec/rg-regex.cjs parseForCensus) or, for the lift, by the
// emulation's own RG-RE-ALT-LIFT firing (SHAPE_EVENTS.lift) — the rule the shape exists to exercise.
//
// THE FLOORS (N). Measured 2026-11-19 over the 500 patterns of the fixed generator (Math.imul, high bits): lift 99,
// nested counted 16, nullable branch 63, lazy 175, capture 124, empty-sub repetition 44, edge assertion 40,
// fold-special 63, -i 53. Each floor sits near a fifth to a half of that: high enough that a generator which mostly
// stopped producing a shape fails, low enough that a reasoned change to the grammar's weights does not. The lift floor
// is 40 (a fifth of the 200-pattern lift family) because the lift is the shape that escaped; the pre-fix generator drew
// 0 of 500 and the round-4 generator with its float-rounded LCG drew 85.
const R = require('../libexec/rg-regex.cjs');

const walk = (n, f, up = []) => {
  if (!n || typeof n !== 'object') return;
  f(n, up);
  for (const k of n.subs || (n.sub ? [n.sub] : [])) walk(k, f, [...up, n]);
};
// `*`, `+`, `?` are not counted repetitions; any other {m,n} is
const counted = (r) => !((r.min === 0 && r.max === null) || (r.min === 1 && r.max === null) || (r.min === 0 && r.max === 1));
const nullable = (n) => {
  switch (n.k) {
    case 'empty': case 'look': return true;
    case 'cat': return n.subs.every(nullable);
    case 'alt': return n.subs.some(nullable);
    case 'rep': return n.min === 0 || nullable(n.sub);
    case 'group': return nullable(n.sub);
    default: return false;
  }
};
// [pattern, ignoreCase] -> the facts the shapes read (computed once per sample)
function facts([pattern, ic]) {
  const before = R.SHAPE_EVENTS.lift;
  R.translateRgRegex(pattern, { ignoreCase: !!ic });
  const f = { lift: R.SHAPE_EVENTS.lift > before, nested: false, nullalt: false, lazy: false, cap: false, emptyrep: false, ic: !!ic };
  let ast = null;
  try { ast = R.parseForCensus(pattern, !!ic); } catch { /* rg rejects it: no structure to count */ }
  walk(ast, (n, up) => {
    if (n.k === 'rep') {
      if (!n.greedy) f.lazy = true;
      const outer = up.filter((u) => u.k === 'rep');
      if (outer.length && (counted(n) || outer.some(counted))) f.nested = true;
      if (nullable(n.sub)) f.emptyrep = true;
    }
    if (n.k === 'alt' && n.subs.some(nullable)) f.nullalt = true;
    if (n.k === 'group' && n.cap) f.cap = true;
  });
  f.edge = /^(?:\^|\$|\\[bB<>])|(?:\^|\$|\\[bB<>]|\\b\{[a-z-]+\})$/.test(pattern);
  // K/k/S/s and their Unicode folds (U+212A KELVIN, U+017F LONG S, U+00DF, U+03C3/U+03C2), under -i or (?i)
  const SPECIAL = new RegExp(`[kKsS${String.fromCodePoint(0x212a, 0x17f, 0xdf, 0x3c3, 0x3c2)}]|\\\\x\\{212a\\}|\\\\u017f`);
  f.fold = (!!ic || /\(\?i/.test(pattern)) && SPECIAL.test(pattern);
  return f;
}

const PATTERN_SHAPES = [
  { shape: 'shared branch prefix (RG-RE-ALT-LIFT fires)', min: 40, has: (f) => f.lift,
    why: 'the escaped shape: a fifth of the 200-pattern lift family (99 measured); the pre-fix generator drew 0' },
  { shape: 'nested counted repetition', min: 8, has: (f) => f.nested,
    why: 'half of the 16 measured; 3c34d6b fixed a prefilter that nested counted repetitions' },
  { shape: 'nullable alternation branch', min: 20, has: (f) => f.nullalt, why: 'a third of the 63 measured' },
  { shape: 'lazy repetition', min: 60, has: (f) => f.lazy, why: 'a third of the 175 measured' },
  { shape: 'capture group', min: 40, has: (f) => f.cap, why: 'a third of the 124 measured; captures block the lift' },
  { shape: 'repetition over an empty-matching sub', min: 15, has: (f) => f.emptyrep, why: 'a third of the 44 measured (Hir::repetition clamps it)' },
  { shape: 'assertion at a pattern edge', min: 15, has: (f) => f.edge, why: 'a third of the 40 measured' },
  { shape: 'case-fold special under case-insensitivity', min: 20, has: (f) => f.fold, why: 'a third of the 63 measured' },
  { shape: '-i', min: 20, has: (f) => f.ic, why: 'a third of the 53 measured (1 in 5 of the 300 grammar draws)' },
];

// The corpus's lines (bytes, terminator excluded): where invalid UTF-8 falls on a line, and the other hostile bytes.
function utf8Bad(b) {
  const bad = [];
  for (let i = 0; i < b.length;) {
    const c = b[i];
    const need = c < 0x80 ? 0 : c >= 0xc2 && c <= 0xdf ? 1 : c >= 0xe0 && c <= 0xef ? 2 : c >= 0xf0 && c <= 0xf4 ? 3 : -1;
    let ok = need >= 0 && i + need < b.length + (need ? 0 : 1);
    for (let k = 1; ok && k <= need; k++) ok = i + k < b.length && (b[i + k] & 0xc0) === 0x80;
    if (ok && need === 2) { const v = ((c & 0x0f) << 12) | ((b[i + 1] & 0x3f) << 6) | (b[i + 2] & 0x3f); ok = v >= 0x800 && (v < 0xd800 || v > 0xdfff); }
    if (ok && need === 3) { const v = ((c & 0x07) << 18) | ((b[i + 1] & 0x3f) << 12) | ((b[i + 2] & 0x3f) << 6) | (b[i + 3] & 0x3f); ok = v >= 0x10000 && v <= 0x10ffff; }
    if (ok) i += need + 1; else { bad.push(i); i++; }
  }
  return bad;
}
function corpusLines(corpus) {
  const out = [];
  for (let s = 0; s < corpus.length;) {
    let e = corpus.indexOf(0x0a, s);
    if (e < 0) e = corpus.length;
    out.push(corpus.subarray(s, e));
    s = e + 1;
  }
  return out;
}
const CORPUS_SHAPES = [
  { shape: 'invalid UTF-8 at a line start', min: 2, has: (b) => utf8Bad(b)[0] === 0,
    why: 'two lines, so no single line carries the shape; the 40-line grammar corpus draws 9 invalid pieces of 39' },
  { shape: 'invalid UTF-8 mid-line', min: 2, has: (b) => utf8Bad(b).some((i) => i > 0 && i < b.length - 1), why: 'as above' },
  { shape: 'invalid UTF-8 at a line end', min: 2, has: (b) => { const x = utf8Bad(b); return x.length > 0 && x[x.length - 1] >= b.length - 3; },
    why: 'as above (a truncated sequence ends the line)' },
  { shape: 'a \\r inside a line', min: 2, has: (b) => b.includes(0x0d), why: 'two lines; rg treats \\r as an ordinary byte without --crlf' },
  { shape: 'an empty line', min: 2, has: (b) => b.length === 0, why: 'two lines; empty matches at a line\'s start and end' },
];

// rnd -> a recorder of the moduli the generator really calls it with (the bits it really uses)
function recordModuli(rnd) {
  const moduli = new Set();
  const rec = (n) => { moduli.add(n); return rnd(n); };
  return { rec, moduli };
}

module.exports = { facts, PATTERN_SHAPES, CORPUS_SHAPES, corpusLines, utf8Bad, recordModuli };
