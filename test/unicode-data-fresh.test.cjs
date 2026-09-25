'use strict';
// libexec/unicode-text.cjs's GENERATED region must be exactly what the generator
// produces from the pinned UCD inputs and the native Claude named in its header. A Bun
// bump that changes a width fails HERE, naming the code points it moves, instead of
// shifting the screen.
//
// Lives in test/, not test/build-gates/ (controller ruling R7, phase 3): its control is
// synthetic and it does not trip the generator's own refusals, so it must not be counted
// by test/guards-population.cjs as controlling scripts/gen-unicode-data.cjs or
// scripts/lib/native-oracle.cjs.
//
// Runs only against the SAME native the table was generated from (ruling R11): a
// different Bun is a different oracle, not a failure of ours, so any other version skips
// and names both. The native comes from resolveNativeOracle() (ruling R1): the text
// oracle, CLODE_NATIVE_ORACLE first.
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert');
const { defineGuard, guardTests } = require('./guard.cjs');
const { resolveNativeOracle, nativeVersion } = require('../scripts/lib/native-oracle.cjs');

const REPO = path.resolve(__dirname, '..');
const GEN = path.join(REPO, 'scripts', 'gen-unicode-data.cjs');

// The generated header of `src`, or the problem that stops it being read. A missing or
// garbled region is a FINDING, never a skip: the table has been generated since phase 3,
// so "no UNICODE_DATA" now means a hand edit or a failed splice broke it, and a skip there
// would read as "nothing to check" exactly when everything is wrong.
function headerOf(src) {
  const m = src.match(/const UNICODE_DATA = (\{.*\});\n/);
  if (!m) return { problem: 'libexec/unicode-text.cjs has no generated `const UNICODE_DATA = {...};` line: the region is missing or reshaped' };
  let h;
  try { h = JSON.parse(m[1]).header; } catch (e) { return { problem: `libexec/unicode-text.cjs's UNICODE_DATA does not parse: ${e.message}` }; }
  if (!h || typeof h.nativeClaude !== 'string' || !h.nativeClaude) {
    return { problem: 'libexec/unicode-text.cjs\'s UNICODE_DATA header names no nativeClaude to regenerate against' };
  }
  return { h };
}

guardTests(defineGuard({
  name: 'unicode-data-fresh',
  read() {
    const { h, problem } = headerOf(fs.readFileSync(path.join(REPO, 'libexec', 'unicode-text.cjs'), 'utf8'));
    if (problem) return { status: null, out: '', problem };
    const bin = resolveNativeOracle();
    if (!bin) return { skip: `no native claude; the table was generated from ${h.nativeClaude} (set CLODE_NATIVE_ORACLE)` };
    const v = nativeVersion(bin);
    if (v !== h.nativeClaude) return { skip: `native is ${JSON.stringify(v)} but the table was generated from ${JSON.stringify(h.nativeClaude)}; set CLODE_NATIVE_ORACLE to that version` };
    const r = spawnSync(process.execPath, [GEN, '--native', bin, '--check'], { encoding: 'utf8', timeout: 1800000 });
    const out = (r.stdout || '') + (r.stderr || '');
    // Exit 3 = offline (the suite's default, test/run.mjs) with a pinned UCD input not yet
    // cached: this run could not look, which is a missing precondition, not a stale table.
    // Warm the cache once online (`node scripts/gen-unicode-data.cjs --native <bin> --check`
    // or `node test/run.mjs --online`) and the gate runs offline from then on.
    if (r.status === 3) return { skip: `offline and the UCD cache is cold — ${out.trim().split('\n').pop()}` };
    return { status: r.status, out };
  },
  scan({ status, out, problem }) {
    // examined: one table; the generator's own refusals come back as status 2.
    if (problem) return { examined: 1, findings: [problem] };
    return { examined: 1, findings: status === 0 ? [] : [`regeneration differs or failed (exit ${status}):\n${out.slice(-2000)}`] };
  },
  control() { return { status: 1, out: 'unicode-data: STALE — planted' }; },
}));

test('a missing or garbled generated region is a finding, not a skip', () => {
  assert.match(headerOf("'use strict';\nmodule.exports = {};\n").problem, /no generated `const UNICODE_DATA/);
  assert.match(headerOf('const UNICODE_DATA = {"header":};\n').problem, /does not parse/);
  assert.match(headerOf('const UNICODE_DATA = {"header":{"nativeClaude":""}};\n').problem, /names no nativeClaude/);
  const real = headerOf(fs.readFileSync(path.join(REPO, 'libexec', 'unicode-text.cjs'), 'utf8'));
  assert.strictEqual(real.problem, undefined);
  assert.match(real.h.nativeClaude, /^\d+\.\d+\.\d+/);
});
