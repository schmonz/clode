'use strict';
// NO PATTERN THE BUNDLE BUILDS HAS MORE CAPTURE GROUPS THAN QUICKJS ALLOWS, and how close the
// nearest one is.
//
// QuickJS-ng refused a RegExp with more than 254 capture groups (its capture index was a byte in
// its bytecode). From 2.1.278 the artifact-lead scrub pattern had 559, and under quaude no
// subagent could finish; an extractor hook (LEAD-SCRUB-POSSESSIVE) rewrote that one builder until
// 2.1.327 moved it out from under the anchor with 588. Its siblings (h6(), the harness-tag scrub
// patterns) sat at 251 and 229 at 2.1.283. Since 2026-11-21 the ENGINE allows native's limit,
// 32,768 groups (spike/quickjs/patches/quickjs-ng-regexp-capture-u16.patch; QUICKJS_CAPTURE_LIMIT
// in test/regexp-census.cjs, which test/engine-regexp-captures.test.cjs proves against the real
// engine), and the hook is retired.
//
// This census (test/regexp-census.cjs) counts every pattern naude builds on a plain turn and on a
// synchronous Task turn, against the canned mock, and fails on any above the engine's limit. Its note says the
// HEADROOM, the largest count and where it was built, so a creeping count is visible before it
// is a failure. It covers every pattern built on those turns, not only h6's call sites: which
// pattern crosses next is not something to guess.
//
// WHERE IT RUNS. In the suite against the pinned provider, and daily in upstream-drift.yml
// against `next`, which is where a new tag lands first. Skips, saying so, without a provider or
// when this provider cannot be staged (the carve job answers that question).
const { test } = require('node:test');
const assert = require('node:assert');
const { defineGuard, guardTests } = require('../guard.cjs');
const { censusOf, PROBE_MARK, QUICKJS_CAPTURE_LIMIT } = require('../regexp-census.cjs');
const { stageProviderCli } = require('../oracle-models.cjs');

// A plain turn builds about 1,540 patterns at 2.1.283; far fewer means the preload did not see
// the turn.
const CONSTRUCTED_FLOOR = 300;

// PURE. `turns`: what runTurns() recorded. Findings: a turn that did not complete or was not
// counted, and every pattern above the limit.
function census({ turns }) {
  const findings = [];
  const all = new Map();
  let examined = 0;
  for (const t of turns) {
    if (t.status !== 0 || !t.answered) {
      findings.push(`the ${t.name} turn did not complete under naude (exit ${t.status}, signal ${t.signal}): ${t.stderr}`);
      continue;
    }
    const probe = t.census && t.census.patterns.find((p) => p.at === PROBE_MARK);
    if (!probe || probe.captures !== 2) {
      findings.push(`the ${t.name} turn's census did not count its own two-group probe (${JSON.stringify(probe)}): the instrument is blind`);
      continue;
    }
    examined = Math.min(examined || Infinity, t.census.constructed - 1);
    for (const p of t.census.patterns) {
      if (p.at === PROBE_MARK) continue;
      const key = `${p.captures}:${p.length}:${p.at}`;
      if (!all.has(key)) all.set(key, p);
    }
  }
  const byCount = [...all.values()].sort((a, b) => b.captures - a.captures);
  for (const p of byCount.filter((x) => x.captures > QUICKJS_CAPTURE_LIMIT)) {
    findings.push(`${p.captures} capture groups (QuickJS allows ${QUICKJS_CAPTURE_LIMIT}): a ${p.length}-character `
      + `/${p.flags} pattern built at ${p.at}`);
  }
  const top = byCount[0];
  const note = top
    ? `headroom ${QUICKJS_CAPTURE_LIMIT - top.captures} group(s): the largest has ${top.captures}, a ${top.length}-character `
      + `pattern built at ${top.at}; the next: ${byCount.slice(1, 3).map((p) => `${p.captures} (${p.at})`).join(', ') || 'none'}; `
      + `${all.size} distinct patterns over ${turns.map((t) => t.name).join(' and ')} turns`
    : undefined;
  return { findings, examined: Number.isFinite(examined) ? examined : 0, note };
}

const turnOf = (name, patterns) => ({ name, status: 0, answered: true, stderr: '',
  census: { constructed: 1000, patterns: [{ captures: 2, length: 1, flags: '', at: PROBE_MARK, times: 1 }, ...patterns] } });

const guard = defineGuard({
  name: 'regexp-capture-census',
  floor: CONSTRUCTED_FLOOR,
  read() {
    const staged = stageProviderCli();
    if (!staged) return { skip: 'no provider (CLODE_PROVIDER_BIN, or UPSTREAM_PIN\'s carve in the provider store)' };
    if (staged.error) return { skip: `this provider cannot be staged, so naude cannot run it: ${staged.error}` };
    return censusOf(staged.dir);
  },
  scan: census,
  control() {
    // 2.1.327's largest pattern as the census recorded it (588 groups, within the engine's limit,
    // no finding), beside one past the limit, which must be.
    return { turns: [turnOf('plain', [
      { captures: 588, length: 980559, flags: 'giu', at: 'AQa (chunk-21zx92hg.js:6:34624)', times: 1 },
      { captures: QUICKJS_CAPTURE_LIMIT + 1, length: 98307, flags: '', at: 'past the limit', times: 1 },
    ])] };
  },
});

guardTests(guard, { test, assert });

test('regexp-capture-census: the limit is counted exactly, and a blind or failed turn is a finding', () => {
  const at = (n) => ({ captures: n, length: 10, flags: 'u', at: `f${n}`, times: 1 });
  const L = QUICKJS_CAPTURE_LIMIT;
  assert.strictEqual(L, 32768, 'native\'s limit (test/regexp-census.cjs)');
  assert.deepStrictEqual(census({ turns: [turnOf('plain', [at(L)])] }).findings, []);
  assert.strictEqual(census({ turns: [turnOf('plain', [at(L + 1)])] }).findings.length, 1);
  assert.match(census({ turns: [turnOf('plain', [at(L), at(3)])] }).note, new RegExp(`^headroom 0 group\\(s\\): the largest has ${L}`));
  const blind = turnOf('plain', []);
  blind.census.patterns = [];
  assert.match(census({ turns: [blind] }).findings[0], /the instrument is blind/);
  assert.match(census({ turns: [{ ...turnOf('task', []), status: 1 }] }).findings[0], /did not complete/);
});
