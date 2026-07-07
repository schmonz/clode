'use strict';
// Characterization: node:events / node:util / node:process (nextTick,
// hrtime.bigint, env enumeration, etc.) must match host node's answers.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

const PROG = `
const { EventEmitter } = require('node:events');
const util = require('node:util');
const out = [];
const e = new EventEmitter();
const h = (x) => out.push('a' + x);
e.on('t', h); e.once('t', (x) => out.push('b' + x));
e.emit('t', 1); e.emit('t', 2);
e.off('t', h); e.emit('t', 3);
out.push(e.listenerCount('t'));
let threw = false;
try { e.emit('error', new Error('boom')); } catch (err) { threw = err.message === 'boom'; }
out.push(threw);
out.push(util.format('%s=%d %j', 'x', 5, { a: 1 }));
const sleep = util.promisify((ms, cb) => setTimeout(() => cb(null, 'woke'), ms));
process.nextTick(() => out.push('tick'));
sleep(1).then((w) => { out.push(w); console.log(JSON.stringify(out)); });
`;

test('events/util/process characterization vs host node', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-core-'));
  const f = path.join(dir, 'prog.cjs');
  fs.writeFileSync(f, PROG);
  const nodeOut = require('node:child_process')
    .execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim();
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), nodeOut);
});

test('process: env enumeration matches host node (Object.keys/spread)', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-envenum-'));
  const f = path.join(dir, 'envenum.cjs');
  fs.writeFileSync(f, `
const keys = Object.keys(process.env);
const spread = { ...process.env };
console.log(JSON.stringify({
  hasMarker: keys.includes('SHIM_CORE_MARKER'),
  spreadHasMarker: 'SHIM_CORE_MARKER' in spread,
  spreadMarkerValue: spread.SHIM_CORE_MARKER,
  markerCount: keys.filter((k) => k === 'SHIM_CORE_MARKER').length,
}));
`);
  const extraEnv = { SHIM_CORE_MARKER: 'marker-value-123' };
  const nodeOut = require('node:child_process')
    .execFileSync(process.execPath, [f], { encoding: 'utf8', env: { ...process.env, ...extraEnv } }).trim();
  const r = runLoader(f, [], { env: extraEnv });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), nodeOut);
});

test('process.stdout.write flushes synchronously before immediate exit', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-flush-'));
  const f = path.join(dir, 'flush.cjs');
  // No trailing newline, no console.log — the write() call itself must land
  // in the captured pipe even though exit() follows on the very next tick.
  fs.writeFileSync(f, `process.stdout.write('flushed-bytes'); process.exit(0);`);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout, 'flushed-bytes');
});

test('process.stdout.write: large payload writes fully (short-write loop)', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-bigwrite-'));
  const f = path.join(dir, 'bigwrite.cjs');
  // ~200KB deterministic payload, then immediate exit — a single POSIX
  // write(2) on a blocking pipe can legally short-write this, so the shim's
  // writeSync must loop or bytes are silently dropped.
  const N = 200000;
  fs.writeFileSync(f, `const N = ${N};
process.stdout.write('x'.repeat(N));
process.exit(0);`);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.length, N);
  assert.strictEqual(r.stdout, 'x'.repeat(N));
});
