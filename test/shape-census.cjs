'use strict';
// shape-census.cjs — observability Task 4 (plan 2026-10-05, Job 0: "observe our current state more accurately than
// yesterday"). A property or random test proves it produced the input shapes it claims to cover.
//
// WHY. A generator's comment says what it draws; nothing checked that it does. The rg-regex oracle generator's header
// said "alternation" and its draws took an LCG's LOW bits, whose period is tiny (rnd(2) merely alternates), so over
// about 8,000 patterns it never once drew an alternation whose branches shared a prefix: rg's lift_common_prefix
// (RG-RE-ALT-LIFT) went unemulated, ranges were silently wrong on ordinary patterns, and a reviewer, not the suite,
// found it (4ce7800). A generator that cannot reach a shape and a generator that reached it and found nothing print the
// same green. This module makes the difference a count.
//
// THE API (two checks per generator; test/generator-census-gate.test.cjs makes every drawing file call both):
//
//   census(name, shapes, samples) -> { name, counts, findings, examined, summary }
//       shapes: [{ shape, min, why, has(sample) -> boolean | count }]. Every shape is DECLARED with its floor `min`
//       (an integer >= 1) and `why` (the justification for that floor: a non-empty sentence). has() is run over every
//       sample; a count below `min` is a finding naming the shape, its count, its floor and its reason. A declaration
//       without a floor or a reason is itself a finding, so a census cannot be written that cannot fail.
//   rngBias(name, makeRnd, moduli, opts) -> { name, findings, examined, summary }
//       makeRnd() returns a FRESH generator positioned at its seed, called as rnd(m) -> an integer in [0, m), exactly as
//       the generator under test maps its state to a choice (pass its own mapping: `seed % m` and `(seed >>> 12) % m`
//       are different bits of the same state). For each modulus the generator really uses, it draws a stream of rnd(m)
//       and tests the values (chi-square over m cells) and consecutive PAIRS (over m*m cells, for m <= 64): the LCG
//       low-bit flaw passes the first (rnd(2) alternates 0,1,0,1: perfectly uniform) and fails the second (the pairs
//       (0,0) and (1,1) never occur). Threshold: df + 7*sqrt(2*df), seven standard deviations of the chi-square, so a
//       sound RNG does not trip it by chance and a cycling one cannot pass it.
//   assertCensus(assert, ...results)
//       one assertion over any number of census/rngBias results, with every finding in the message.
//   intRng(seed) -> rnd(m)
//       the suite's sound seeded generator (mulberry32, taking its HIGH bits through floor(f * m)), for a generator that
//       has no reason to keep its own.
//   firstSighting(key) -> has(sample)
//       a has() that counts a sample the first time its key is seen: the "distinct inputs" shape, which is how a
//       generator caught in a short cycle shows itself (one whose 40,000 draws are 1,000 inputs drawn 40 times).
//       Stateful: make a fresh one for each census() call.
//
// What it does NOT judge: whether the declared shapes are the RIGHT shapes (the author's claim, read in review), or
// whether a shape that appeared was then checked against an oracle (the property test's own job).

function census(name, shapes, samples) {
  const findings = [];
  const counts = {};
  const seen = new Set();
  if (!Array.isArray(shapes) || shapes.length === 0) findings.push(`${name}: no shapes declared: a census of nothing cannot fail`);
  for (const s of shapes || []) {
    const id = s && s.shape;
    if (typeof id !== 'string' || !id) { findings.push(`${name}: a shape without a name`); continue; }
    if (seen.has(id)) findings.push(`${name}: shape "${id}" declared twice`);
    seen.add(id);
    if (!Number.isInteger(s.min) || s.min < 1) findings.push(`${name}: shape "${id}" has no floor (min must be an integer >= 1)`);
    if (typeof s.why !== 'string' || !s.why.trim()) findings.push(`${name}: shape "${id}" does not say why its floor is ${s.min}`);
    if (typeof s.has !== 'function') { findings.push(`${name}: shape "${id}" has no has(sample)`); continue; }
    counts[id] = 0;
  }
  const list = Array.isArray(samples) ? samples : [];
  if (list.length === 0) findings.push(`${name}: examined no samples: the generator produced nothing`);
  for (const sample of list) {
    for (const s of shapes || []) {
      if (!(s.shape in counts)) continue;
      const v = s.has(sample);
      counts[s.shape] += typeof v === 'number' ? v : v ? 1 : 0;
    }
  }
  for (const s of shapes || []) {
    if (!(s.shape in counts) || !Number.isInteger(s.min)) continue;
    if (counts[s.shape] < s.min) {
      findings.push(`${name}: shape "${s.shape}" appeared ${counts[s.shape]} time(s) in ${list.length} sample(s); its floor is ${s.min} (${s.why})`);
    }
  }
  const summary = `${name}: ${list.length} samples; ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}`;
  return { name, counts, findings, examined: list.length, summary };
}

const PAIR_MAX = 64;
function chiSquare(cells, total) {
  const e = total / cells.length;
  let x = 0;
  for (const c of cells) x += (c - e) * (c - e) / e;
  return x;
}
const limit = (df) => df + 7 * Math.sqrt(2 * df);

function rngBias(name, makeRnd, moduli, opts = {}) {
  const findings = [];
  const notes = [];
  let examined = 0;
  if (!Array.isArray(moduli) || moduli.length === 0) findings.push(`${name}: no moduli: say which rnd(m) the generator calls`);
  for (const m of [...new Set(moduli || [])]) {
    if (!Number.isInteger(m) || m < 2) { if (m !== 1) findings.push(`${name}: modulus ${m} is not an integer >= 2`); continue; }
    const pairs = m <= PAIR_MAX;
    // enough draws that every cell expects at least 20
    const draws = opts.draws || Math.max(4000, 20 * (pairs ? m * m : m) + 1);
    const rnd = makeRnd();
    const one = new Array(m).fill(0);
    const two = pairs ? new Array(m * m).fill(0) : null;
    let prev = -1, bad = null;
    for (let i = 0; i < draws; i++) {
      const v = rnd(m);
      if (!Number.isInteger(v) || v < 0 || v >= m) { bad = v; break; }
      one[v]++;
      if (pairs && prev >= 0) two[prev * m + v]++;
      prev = v;
    }
    examined += draws;
    if (bad !== null) { findings.push(`${name}: rnd(${m}) returned ${bad}, outside [0, ${m})`); continue; }
    const x1 = chiSquare(one, draws);
    if (x1 > limit(m - 1)) {
      findings.push(`${name}: rnd(${m}) is biased: chi-square ${x1.toFixed(1)} over ${m} values (limit ${limit(m - 1).toFixed(1)}); `
        + `${one.filter((c) => c === 0).length} value(s) never drawn in ${draws}`);
    }
    if (pairs) {
      const x2 = chiSquare(two, draws - 1);
      const df = m * m - 1;
      if (x2 > limit(df)) {
        findings.push(`${name}: rnd(${m}) is serially correlated: chi-square ${x2.toFixed(1)} over ${m * m} consecutive pairs `
          + `(limit ${limit(df).toFixed(1)}); ${two.filter((c) => c === 0).length} of ${m * m} pairs never drawn in ${draws} `
          + '(an LCG\'s low bits cycle, and a JS `seed * a` past 2^53 rounds its low bits away: take the high bits of a Math.imul product)');
      }
    }
    notes.push(`rnd(${m}) x${draws}`);
  }
  return { name, findings, examined, summary: `${name}: ${notes.join(', ')}` };
}

function firstSighting(key) {
  const seen = new Set();
  return (sample) => { const k = key(sample); if (seen.has(k)) return false; seen.add(k); return true; };
}

function assertCensus(assert, ...results) {
  const findings = results.flatMap((r) => r.findings);
  for (const r of results) assert.ok(r.examined > 0, `${r.name}: examined nothing`);
  assert.deepStrictEqual(findings, [], `${findings.length} shape/RNG finding(s):\n  ${findings.join('\n  ')}`);
}

// mulberry32: a 32-bit state, every output bit mixed; floor(f * m) takes its high bits.
function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function intRng(seed) {
  const f = mulberry32(seed);
  return (m) => Math.floor(f() * m);
}

module.exports = { census, rngBias, assertCensus, firstSighting, mulberry32, intRng };
