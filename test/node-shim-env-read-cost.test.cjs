'use strict';
// A process.env read of an UNSET name costs what a read of a set one does, under node-shim as under node.
//
// FOUND (2026-11-24): under CPU load (the full suite, or 32 `yes`), quaude's `-p` turns logged `[Bootstrap] fetch
// failed: AxiosError: timeout of 5000ms exceeded`, `Failed to fetch org fast mode status ... timeout of 10000ms
// exceeded` and `Failed to fetch MCP registry: canceled`; naude under the same load logged none. A probe timed every
// https request: quaude's loop did not turn for 15-20 s while the bundle kept working, the requests' TLS handshakes
// could not progress (connect 37 s after request()), and axios's timers fired first. `sample` of the stalled process:
// nearly every main-thread sample sat under tjs_getenv -> tjs_throw_errno -> build_backtrace, inside one microtask
// drain. tjs.env answers an unset name by THROWING an engine Error (its backtrace built) and catching it: 18-23 us a
// read where node takes 0.35 us, and 2.1.330 reads unset CLAUDE_CODE_* knobs on nearly every path (a stretch node runs
// in 3 ms took quaude 3.9 s). The bundle's slow stretches, stretched again by load, outlasted its own timeouts.
//
// THE CLASS this holds: a node primitive the shim makes far dearer than node does, on a path the bundle runs hot, so
// quaude holds its event loop where node does not and its I/O completes late. The measure is a RATIO inside one
// process (an unset read over a set read), so the box's load divides out: node's is ~1, the throwing route's was ~36
// shallow and more at depth. And the answers themselves (set, empty, unset, `in`, hasOwn, write, delete) must be
// node's, on the patched engine and on the route an engine without txiki-getenv-global.patch takes.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { skipUnlessTjs, runLoader, LOADER } = require('./node-shim-helper.cjs');
const { makeStaleHost, mkdtemp } = require('./stale-build-host.cjs');

const PROBE = path.join(__dirname, 'fixtures', 'env-read-cost-probe.cjs');
const ENV = { ENV_READ_COST_SET: 'value', ENV_READ_COST_EMPTY: '' };
// An unset read may cost this many set reads. node measures ~1; the throwing route measured 36 (shallow) and 47 (depth
// 40) on darwin-arm64. 4 leaves room for a noisy box without letting an exception-per-read back in.
const MAX_RATIO = 4;

function parse(label, r) {
  assert.strictEqual(r.status, 0, `${label} probe failed (status ${r.status}):\n${r.stderr}`);
  return JSON.parse(r.stdout);
}

test('process.env: an unset read costs what a set read does, and every answer is node\'s', (t) => {
  if (skipUnlessTjs(t)) return;
  const node = parse('host node', spawnSync(process.execPath, [PROBE], { encoding: 'utf8', env: { ...process.env, ...ENV }, timeout: 60000 }));
  const shim = parse('tjs + node-shim', runLoader(PROBE, [], { env: ENV, timeout: 120000 }));
  t.diagnostic(`unset/set read cost: node ${JSON.stringify(node.ratio)}, node-shim ${JSON.stringify(shim.ratio)}`);
  const dear = ['shallow', 'deep'].filter((k) => !(shim.ratio[k] <= MAX_RATIO))
    .map((k) => `${k} stack: ${shim.ratio[k]}x (node ${node.ratio[k]}x)`);
  assert.deepStrictEqual(dear, [], `node-shim: an unset process.env read costs more than ${MAX_RATIO}x a set one, the `
    + 'engine answering an unset name the dear way');
  assert.deepStrictEqual(shim.answers, node.answers, 'process.env answered otherwise than node');
});

test('process.env on an engine without __tjs_getenv: node\'s answers, through tjs.env', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = mkdtemp('env-read');
  try {
    const host = makeStaleHost(dir);
    if (host.skip) { t.skip(host.skip); return; }
    const node = parse('host node', spawnSync(process.execPath, [PROBE], { encoding: 'utf8', env: { ...process.env, ...ENV, PROBE_READS: '200' }, timeout: 60000 }));
    const stale = parse('stale engine', spawnSync(host.engine, ['run', LOADER, PROBE], { encoding: 'utf8', env: { ...process.env, ...ENV, ...host.env, PROBE_READS: '200' }, timeout: 120000 }));
    assert.deepStrictEqual(stale.answers, node.answers, 'process.env on a stale engine answered otherwise than node');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
