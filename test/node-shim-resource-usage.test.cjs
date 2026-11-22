'use strict';
// process.resourceUsage() under quaude answers as node does: libuv's uv_getrusage, node's field names, node's units.
// It did not exist, and 2.1.330's event-loop-stall sampler calls it: every agentic run on the Windows legs logged
// "[event-loop-stall] process.resourceUsage() failed: not a function" (CI 44945260530). The engine now reports rusage
// (txiki-rusage-global.patch, globalThis.__tjs_getrusage); an engine without it is refused by name
// (scripts/engine-api-floor.cjs).
//
// The figures are this process's own, so they cannot equal node's value for value. What is compared: the same fields
// in the same order, every one a non-negative integer, CPU time spent (a busy loop runs first), and maxRSS in the
// same unit as node's -- kilobytes on every platform, which libuv normalises from macOS's bytes. A bytes answer is
// ~1024x node's, far outside the factor-of-ten band both runtimes' resident sizes sit in.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runLoader, skipUnlessTjs, REPO } = require('./node-shim-helper.cjs');

const PROG = `
const t0 = Date.now(); let x = 0; while (Date.now() - t0 < 150) x++;
console.log(JSON.stringify(process.resourceUsage()));`;

test('process.resourceUsage() answers node\'s fields, in node\'s units', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-resource-usage-'));
  try {
    const prog = path.join(dir, 'p.cjs');
    fs.writeFileSync(prog, PROG);
    const node = spawnSync(process.execPath, [prog], { encoding: 'utf8' });
    assert.strictEqual(node.status, 0, node.stderr);
    const want = JSON.parse(node.stdout.trim());
    const r = runLoader(prog, []);
    assert.strictEqual(r.status, 0, String(r.stderr));
    const got = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.deepStrictEqual(Object.keys(got), Object.keys(want), 'the same fields, in node\'s order');
    for (const [k, v] of Object.entries(got)) assert.ok(Number.isInteger(v) && v >= 0, `${k}: ${v}`);
    assert.ok(got.userCPUTime + got.systemCPUTime >= 50000, `150 ms of busy loop is CPU time, in microseconds: ${JSON.stringify(got)}`);
    const ratio = got.maxRSS / want.maxRSS;
    assert.ok(ratio > 0.1 && ratio < 10, `maxRSS ${got.maxRSS} is in node's unit (node: ${want.maxRSS}), kilobytes`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// The stale engine (test/fixtures/stale-engine-prelude.js, which has no __tjs_getrusage) is refused by name, and the
// refusal reaches CLODE_ENGINE_FLOOR_LOG.
test('an engine without __tjs_getrusage is refused by name, and the refusal is logged', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-resource-usage-stale-'));
  try {
    const prelude = fs.readFileSync(path.join(REPO, 'test', 'fixtures', 'stale-engine-prelude.js'), 'utf8');
    const prog = path.join(dir, 'stale.cjs');
    fs.writeFileSync(prog, `${prelude}
let out; try { out = 'returned ' + JSON.stringify(process.resourceUsage()); } catch (e) { out = e.code + ': ' + e.message; }
console.log(JSON.stringify(out));`);
    const log = path.join(dir, 'floor.log');
    const r = runLoader(prog, [], { env: { CLODE_ENGINE_FLOOR_LOG: log } });
    assert.strictEqual(r.status, 0, String(r.stderr));
    const msg = 'node-shim: this engine has no __tjs_getrusage (it predates txiki-rusage-global.patch), so '
      + 'process.resourceUsage() cannot answer; rebuild it: ./build.sh --only engine.compile';
    assert.strictEqual(JSON.parse(r.stdout.trim().split('\n').pop()), `ERR_CLODE_ENGINE_FLOOR: ${msg}`);
    assert.strictEqual(fs.readFileSync(log, 'utf8').split('\n')[0], msg);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// process.cpuUsage([prev]) is the same uv_getrusage source in node: user and system time in microseconds, a delta
// when given prev, and node's errors for a bad prev. It answered zeros while resourceUsage() was real. The deltas are
// compared by shape (positive after a busy loop, and no larger than the cumulative figure); the errors exactly.
const CPU_PROG = `
const t = (f) => { try { return JSON.stringify(f()); } catch (e) { return e.constructor.name + ' ' + e.code + ' ' + e.message; } };
const a = process.cpuUsage();
const t0 = Date.now(); let x = 0; while (Date.now() - t0 < 150) x++;
const d = process.cpuUsage(a);
const ru = process.resourceUsage();
const c = process.cpuUsage();
console.log(JSON.stringify([
  Object.keys(a).join(','), Number.isInteger(a.user) && Number.isInteger(a.system),
  d.user + d.system >= 50000, d.user <= c.user && d.system <= c.system,
  Math.abs(c.user - ru.userCPUTime) < 1000000,
  t(() => process.cpuUsage({ user: 1 })), t(() => process.cpuUsage({ user: -1, system: 0 })),
  t(() => process.cpuUsage(5)), t(() => process.cpuUsage({ user: 'x', system: 0 })),
  Object.keys(process.cpuUsage(null)).join(','),
]));`;

test('process.cpuUsage() is uv_getrusage microseconds, with node\'s prev-delta and errors', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-cpu-usage-'));
  try {
    const prog = path.join(dir, 'p.cjs');
    fs.writeFileSync(prog, CPU_PROG);
    const node = spawnSync(process.execPath, [prog], { encoding: 'utf8' });
    assert.strictEqual(node.status, 0, node.stderr);
    const want = JSON.parse(node.stdout.trim());
    assert.deepStrictEqual(want.slice(0, 5), ['user,system', true, true, true, true], 'the host node oracle');
    const r = runLoader(prog, []);
    assert.strictEqual(r.status, 0, String(r.stderr));
    assert.deepStrictEqual(JSON.parse(r.stdout.trim().split('\n').pop()), want);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
