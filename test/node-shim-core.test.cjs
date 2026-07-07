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

// Wall (Task 4): the -p boot reads `process.stdin.isTTY` early — process.stdin
// must exist (a Readable-ish with isTTY/fd/on/resume), not be undefined.
test('process.stdin: shape matches host node (isTTY/fd/methods)', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-stdin-'));
  const f = path.join(dir, 'stdin.cjs');
  fs.writeFileSync(f, `console.log(JSON.stringify({
  hasStdin: !!process.stdin,
  isTTY: process.stdin.isTTY ?? null,
  fd: process.stdin.fd,
  on: typeof process.stdin.on,
  resume: typeof process.stdin.resume,
  pause: typeof process.stdin.pause,
  setEncoding: typeof process.stdin.setEncoding,
}));`);
  const nodeOut = require('node:child_process')
    .execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim();
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), nodeOut);
});

// Wall (Task 4): the -p boot's main calls process.removeAllListeners('clodeCustomEvt')
// and registers handlers. The registry surface (on/once/removeListener/
// removeAllListeners/emit/listenerCount) must behave like host node's for manual
// emit (delivery of 'exit'/signals stays a documented divergence).
test('process EventEmitter registry: on/once/removeAllListeners/emit vs host node', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-procEE-'));
  const f = path.join(dir, 'procee.cjs');
  fs.writeFileSync(f, `const seen = [];
process.on('clodeCustomEvt', (w) => seen.push('a:' + w));
process.once('clodeCustomEvt', (w) => seen.push('b:' + w));
process.emit('clodeCustomEvt', 'x');
process.emit('clodeCustomEvt', 'y');
const afterEmit = process.listenerCount('clodeCustomEvt');
process.removeAllListeners('clodeCustomEvt');
console.log(JSON.stringify({ seen, afterEmit, afterRemove: process.listenerCount('clodeCustomEvt') }));`);
  const nodeOut = require('node:child_process')
    .execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim();
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), nodeOut);
});

// Wall (Task 4): the boot gates on process.version.match(/^v(\d+)\./) >= 22.
// process.version must be a 'v'-prefixed semver string.
test('process.version: v-prefixed semver, parses >= 22', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-version-'));
  const f = path.join(dir, 'version.cjs');
  fs.writeFileSync(f, `const maj = process.version.match(/^v(\\d+)\\./)?.[1];
console.log(JSON.stringify({ isStr: typeof process.version === 'string', maj: parseInt(maj), ok: parseInt(maj) >= 22 }));`);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  assert.strictEqual(out.isStr, true);
  assert.strictEqual(out.ok, true);
});

// Wall (Task 4): the -p boot's main does process.execArgv.some(...) to detect
// debug flags. execArgv must be an array.
test('process.execArgv: is an array (like host node plain invocation)', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-execargv-'));
  const f = path.join(dir, 'execargv.cjs');
  fs.writeFileSync(f, `console.log(JSON.stringify({ isArray: Array.isArray(process.execArgv), some: process.execArgv.some((x) => x === '--zzz') }));`);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), { isArray: true, some: false });
});

// Wall (Task 4): the -p boot's main entry calls process.uptime() (for a
// node_boot_ms metric). Must be a number >= 0 that advances.
test('process.uptime(): number that advances (like host node)', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-uptime-'));
  const f = path.join(dir, 'uptime.cjs');
  fs.writeFileSync(f, `const a = process.uptime();
const b = process.uptime();
console.log(JSON.stringify({ isNum: typeof a === 'number', nonneg: a >= 0, advances: b >= a }));`);
  const nodeOut = require('node:child_process')
    .execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim();
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), nodeOut);
});

// Wall (Task 4): the -p bundle subclasses EventEmitter and calls
// setMaxListeners(0) in its constructor; also uses prependListener/eventNames.
// These must match host node's observable behavior.
test('EventEmitter: setMaxListeners/prependListener/eventNames match host node', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-ee-'));
  const f = path.join(dir, 'ee.cjs');
  fs.writeFileSync(f, `const { EventEmitter } = require('events');
class E extends EventEmitter { constructor() { super(); this.setMaxListeners(0); } }
const e = new E();
const order = [];
e.on('x', () => order.push('on'));
e.prependListener('x', () => order.push('prepend'));
e.emit('x');
console.log(JSON.stringify({
  max: e.getMaxListeners(),
  order,
  names: e.eventNames(),
  count: e.listenerCount('x'),
}));`);
  const nodeOut = require('node:child_process')
    .execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim();
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), nodeOut);
});

// Wall (Task 4): the -p bundle references the bare Node global `global`
// (e.g. `if(global.TEST...)`). Under tjs only `globalThis` exists, so the
// loader must alias `global` to `globalThis` (Node semantics: they are the
// same object).
test('global: aliased to globalThis like host node', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-global-'));
  const f = path.join(dir, 'global.cjs');
  fs.writeFileSync(f, `console.log(JSON.stringify({
  type: typeof global,
  sameAsGlobalThis: global === globalThis,
  hasProcess: global.process === process,
}));`);
  const nodeOut = require('node:child_process')
    .execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim();
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), nodeOut);
});

// Wall (Task 4): the -p boot (via its bundled `execa`) calls
// `util.debuglog('execa').enabled`. debuglog must be a function returning a
// callable whose `.enabled` is false when NODE_DEBUG doesn't select the section.
test('util.debuglog: returns callable with .enabled like host node', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-debuglog-'));
  const f = path.join(dir, 'debuglog.cjs');
  fs.writeFileSync(f, `const util = require('util');
const d = util.debuglog('execa');
d('this must not print when section is not in NODE_DEBUG');
console.log(JSON.stringify({
  debuglog: typeof util.debuglog,
  ret: typeof d,
  enabled: d.enabled,
  debug: typeof util.debug,
}));`);
  const nodeOut = require('node:child_process')
    .execFileSync(process.execPath, [f], { encoding: 'utf8', env: { ...process.env, NODE_DEBUG: '' } }).trim();
  const r = runLoader(f, [], { env: { NODE_DEBUG: '' } });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), nodeOut);
});

// Wall (Task 4): the -p boot (via the bundled `debug` package) calls
// `util.deprecate(fn, msg)`. It must return a function that delegates to fn
// (the wrapped return value must pass through).
test('util.deprecate: wraps fn and passes through return value', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-deprecate-'));
  const f = path.join(dir, 'deprecate.cjs');
  fs.writeFileSync(f, `const util = require('util');
const wrapped = util.deprecate((a, b) => a + b, 'old thing');
console.log(JSON.stringify({
  isFn: typeof util.deprecate === 'function',
  retFn: typeof wrapped === 'function',
  called: wrapped(2, 3),
}));`);
  const nodeOut = require('node:child_process')
    .execFileSync(process.execPath, [f], { encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } }).trim();
  const r = runLoader(f, [], { env: { NODE_NO_WARNINGS: '1' } });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), nodeOut);
});

// Wall (Task 4): the -p boot require()s `timers/promises` (and `timers`). The
// promise-timer surface must be real: setTimeout(delay,value) resolves to value
// after the delay; setImmediate(value) resolves to value; setInterval/scheduler
// are present. Assert equality with host node.
test('timers/promises: setTimeout/setImmediate resolve values like host node', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-timers-'));
  const f = path.join(dir, 'timers.cjs');
  fs.writeFileSync(f, `const tp = require('timers/promises');
const timers = require('timers');
(async () => {
  const a = await tp.setTimeout(1, 'delayed');
  const b = await tp.setImmediate('immediate');
  console.log(JSON.stringify({
    a, b,
    setInterval: typeof tp.setInterval,
    scheduler: typeof tp.scheduler,
    cbSetTimeout: typeof timers.setTimeout,
    cbClearTimeout: typeof timers.clearTimeout,
  }));
})();`);
  const nodeOut = require('node:child_process')
    .execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim();
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), nodeOut);
});

// Wall (Task 4): the -p boot's `human-signals` dependency destructures
// `os.constants.signals[NAME]` for every signal it knows — os.constants (and
// its .signals map) must exist, not be undefined. Assert the signals table
// deep-equals host node's on this platform.
test('os.constants.signals: table matches host node', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-ossig-'));
  const f = path.join(dir, 'ossig.cjs');
  fs.writeFileSync(f, `const os = require('node:os');
console.log(JSON.stringify(os.constants.signals));`);
  const nodeOut = require('node:child_process')
    .execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim();
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), JSON.parse(nodeOut));
});

// Wall (Task 4): several -p transport modules require('zlib') and read
// `zlib.constants` at init (destructuring Z_*/BROTLI_* values). The constants
// table must deep-equal host node's; the compression API is present (function)
// but throws if actually invoked (the mock never compresses) — assert both.
test('zlib.constants: table matches host node; compression API present', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-zlib-'));
  const f = path.join(dir, 'zlib.cjs');
  fs.writeFileSync(f, `const z = require('zlib');
console.log(JSON.stringify({
  constants: z.constants,
  createGunzip: typeof z.createGunzip,
  gunzipSync: typeof z.gunzipSync,
}));`);
  const nodeRaw = JSON.parse(require('node:child_process')
    .execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim());
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  const tjs = JSON.parse(r.stdout.trim());
  assert.deepStrictEqual(tjs.constants, nodeRaw.constants);
  assert.strictEqual(tjs.createGunzip, 'function');
  assert.strictEqual(tjs.gunzipSync, 'function');
});

// Wall (Task 4): the -p boot reads `require('perf_hooks').performance` (timing +
// OpenTelemetry). It must be a real performance object: .now() returns a number
// and monotonically advances; .timeOrigin is a number.
test('perf_hooks.performance: now()/timeOrigin behave like host node', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-perf-'));
  const f = path.join(dir, 'perf.cjs');
  fs.writeFileSync(f, `const { performance } = require('perf_hooks');
const a = performance.now();
const b = performance.now();
console.log(JSON.stringify({
  nowNumber: typeof a === 'number',
  monotonic: b >= a,
  timeOrigin: typeof performance.timeOrigin === 'number',
}));`);
  const nodeOut = require('node:child_process')
    .execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim();
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), nodeOut);
});

// Wall (Task 4): the -p boot captures node:dns and dns/promises. lookup of a
// literal IP / 'localhost' must resolve like host node (address + family) — the
// round-trip targets 127.0.0.1.
test('dns.lookup: literal IP + localhost resolve like host node', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-dns-'));
  const f = path.join(dir, 'dns.cjs');
  // Only LITERAL IPs are asserted — 'localhost' resolution is system-dependent
  // (macOS returns ::1 first) and the -p path targets 127.0.0.1 literally.
  fs.writeFileSync(f, `const dns = require('dns');
const dp = require('dns/promises');
(async () => {
  const cbRes = await new Promise((res) => dns.lookup('127.0.0.1', (e, a, fam) => res([a, fam])));
  const pRes = await dp.lookup('127.0.0.1');
  console.log(JSON.stringify({ cbRes, pAddr: pRes.address, pFam: pRes.family }));
})();`);
  const nodeOut = require('node:child_process')
    .execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim();
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), nodeOut);
});

// Wall (Task 4): the -p boot require()s node:tty (interop probe + isatty). Under
// a captured pipe every fd is non-tty, matching host node.
test('node:tty: isatty + stream ctors match host node (piped)', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-tty-'));
  const f = path.join(dir, 'tty.cjs');
  fs.writeFileSync(f, `const tty = require('node:tty');
console.log(JSON.stringify({
  isatty0: tty.isatty(0), isatty1: tty.isatty(1), isatty99: tty.isatty(99),
  WriteStream: typeof tty.WriteStream, ReadStream: typeof tty.ReadStream,
}));`);
  const nodeOut = require('node:child_process')
    .execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim();
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), nodeOut);
});
