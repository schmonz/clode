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

// Wall (Task 4, -p round-trip): process.exitCode defaults to UNDEFINED in node
// (not 0). The bundle guards `if (process.exitCode !== undefined) { /* graceful
// shutdown */ return }` right after startup — a default of 0 made that guard
// fire and silently ABORT the action before the Messages POST.
test('process.exitCode defaults to undefined (matches node), not 0', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-exitcode-'));
  // Node's own default: a plain node run of the same fixture reports the same.
  const nodeF = path.join(dir, 'nd.cjs');
  fs.writeFileSync(nodeF, `console.log(JSON.stringify({ isUndef: process.exitCode === undefined, notVoid: process.exitCode !== undefined }));`);
  const node = JSON.parse(require('node:child_process').execFileSync(process.execPath, [nodeF], { encoding: 'utf8' }).trim());
  assert.deepStrictEqual(node, { isUndef: true, notVoid: false }, 'node baseline');

  // The shim must match: default undefined (so the bundle's graceful-shutdown
  // guard `process.exitCode !== undefined` does NOT fire), AND remain settable
  // as a property (the value reads back).
  const f = path.join(dir, 'p.cjs');
  fs.writeFileSync(f, `
    const out = { isUndef: process.exitCode === undefined, notVoid: process.exitCode !== undefined };
    process.exitCode = 3;               // still settable as a property
    out.afterSet = process.exitCode;
    console.log(JSON.stringify(out));`);
  // Node EXITS WITH process.exitCode on a natural exit, so this fixture exits 3.
  // This assertion used to demand status 0, which codified a real shim bug: the
  // loader ignored process.exitCode entirely, so a bundle signalling failure that
  // way reported SUCCESS to its caller (CI included). Compare against node's own
  // exit code for the identical fixture rather than a hardcoded number, so the
  // two can never drift apart again.
  let nodeStatus = 0;
  try {
    require('node:child_process').execFileSync(process.execPath, [f], { encoding: 'utf8' });
  } catch (e) { nodeStatus = e.status; }
  assert.strictEqual(nodeStatus, 3, 'node baseline: a natural exit uses process.exitCode');
  const r = runLoader(f);
  assert.strictEqual(r.status, nodeStatus, `shim must exit with process.exitCode like node: ${r.stderr}`);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), { isUndef: true, notVoid: false, afterSet: 3 });
});

// Wall (Task 4): events.setMaxListeners is a MODULE-LEVEL function (Node 15+),
// distinct from the EventEmitter instance method. The bundle's AbortController
// helper calls `require('events').setMaxListeners(n, signal)` on an AbortSignal;
// a missing module function threw `TypeError: not a function` and crashed session
// loading before the round-trip.
test('events.setMaxListeners (module-level) is callable on emitters + AbortSignal', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-setmax-'));
  const f = path.join(dir, 'p.cjs');
  fs.writeFileSync(f, `
    const events = require('node:events');
    const out = { type: typeof events.setMaxListeners };
    const ee = new events.EventEmitter();
    events.setMaxListeners(15, ee);
    out.ee = ee.getMaxListeners();
    // On an AbortSignal (EventTarget): must not throw.
    const ac = new AbortController();
    events.setMaxListeners(20, ac.signal);
    out.signalOk = true;
    // No targets: sets the default.
    events.setMaxListeners(9);
    out.def = events.EventEmitter.defaultMaxListeners;
    console.log(JSON.stringify(out));`);
  const node = JSON.parse(require('node:child_process').execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim());
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), node);
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

// Wall (tjs tool-use): $Ty, the bundle's tool runner, calls
// `process.memoryUsage()` immediately before every tool's e.call() to record
// an rss/heap/external baseline for tengu_tool_use_success analytics. tjs has
// no memory API, so without the shim the property is undefined and the call
// throws TypeError "not a function"; QuickJS collapses that onto the async
// runner frame, surfacing to the model as "Error calling tool (X): not a
// function" — EVERY agentic tool call fails before the tool runs. Node's
// contract: an object with numeric rss/heapTotal/heapUsed/external/arrayBuffers
// (bytes), plus a memoryUsage.rss() fast-path function. cpuUsage() is used on
// an adjacent stall-diagnostics path and must also exist.
test('process.memoryUsage()/cpuUsage(): numeric fields, does not throw', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-mem-'));
  const f = path.join(dir, 'mem.cjs');
  fs.writeFileSync(f, `const m = process.memoryUsage();
const c = process.cpuUsage();
console.log(JSON.stringify({
  isObj: m && typeof m === 'object',
  fields: ['rss','heapTotal','heapUsed','external','arrayBuffers'].every((k) => typeof m[k] === 'number'),
  rssFn: typeof process.memoryUsage.rss === 'function' && typeof process.memoryUsage.rss() === 'number',
  cpu: c && typeof c.user === 'number' && typeof c.system === 'number',
}));`);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), { isObj: true, fields: true, rssFn: true, cpu: true });
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

// Wall (2.1.238): the bundle now does `new Map(Object.entries(os.constants.errno))`
// at module init. os.constants carried ONLY .signals, so errno was undefined and
// Object.entries(undefined) threw "Cannot convert undefined or null to object" —
// an unhandledRejection that killed the boot outright. Every build against 2.1.238
// produced a quaude that could not start; the build smoke caught it as
// "did not complete the mock round-trip".
//
// Like signals, this table is PER-PLATFORM: the name set is fixed (node builds it
// from a static list) but 47 of the 79 VALUES differ across darwin/linux/netbsd
// (EAGAIN is 35 on darwin/netbsd and 11 on linux). So a single hardcoded table is
// wrong on most targets — hence the engine exposes __tjs_errno from its own
// <errno.h>, exactly as __tjs_signals does. Asserting deep-equality against host
// node keeps that honest on whatever platform this suite runs.
test('os.constants.errno: table matches host node', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-oserrno-'));
  const f = path.join(dir, 'oserrno.cjs');
  fs.writeFileSync(f, `const os = require('node:os');
console.log(JSON.stringify(os.constants.errno));`);
  const nodeOut = require('node:child_process')
    .execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim();
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), JSON.parse(nodeOut));
});

// The exact expression the 2.1.238 bundle evaluates at module init. Guards the
// crash shape itself, not just the table: this threw before the fix.
test('os.constants.errno: Object.entries() round-trips (the 2.1.238 crash)', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-oserrno2-'));
  const f = path.join(dir, 'oserrno2.cjs');
  fs.writeFileSync(f, `const os = require('os');
const m = new Map(Object.entries(os.constants.errno));
console.log(JSON.stringify({ size: m.size > 0, enoent: m.get('ENOENT') }));`);
  const nodeOut = require('node:child_process')
    .execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim();
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), JSON.parse(nodeOut));
});

// The DOM event polyfills hand back wrong SHAPES rather than throwing, which is
// how both bugs in this family survived: a consumer gets a plausible-looking wrong
// answer instead of an error. MessageEvent stored the whole init dict in .data
// (killing MCP over SSE); CustomEvent.detail returned Boolean(detail), so every
// payload became true/false. The neighbouring getters (bubbles, cancelable,
// composed) really are booleans, so that coercion was copy-pasted one line too far.
test('CustomEvent.detail returns the value, like node (not its truthiness)', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-custevt-'));
  const f = path.join(dir, 'ce.cjs');
  fs.writeFileSync(f, `console.log(JSON.stringify({
    obj: new CustomEvent('x', { detail: { a: 1 } }).detail,
    str: new CustomEvent('y', { detail: 'str' }).detail,
    zero: new CustomEvent('n', { detail: 0 }).detail,
    none: new CustomEvent('z').detail,
  }));`);
  const nodeOut = require('node:child_process')
    .execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim();
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), JSON.parse(nodeOut));
  // Pre-fix this was {obj:true,str:true,zero:false,none:false}. `zero` is the
  // sharpest of the four: a falsy but meaningful payload.
  assert.strictEqual(JSON.parse(r.stdout.trim()).zero, 0);
});

// node does `module.exports = EventEmitter`: the events module IS the class, with
// helpers hung off it. Exporting a namespace object instead broke the very common
//     const EventEmitter = require('events');
//     class Foo extends EventEmitter {}
// with "parent class must be constructor" — which is why npm `ws` could not load
// at all (websocket.js and websocket-server.js both write exactly that), and so
// why quaude falls back to the engine's native WebSocket while naude and Claude
// use ws. The destructuring form kept working throughout, which is how it hid.
test('events: the module IS the EventEmitter class, extendable like node', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-events-shape-'));
  const f = path.join(dir, 'ev.cjs');
  fs.writeFileSync(f, `const EventEmitter = require('events');
class Sub extends EventEmitter {}            // the form that used to throw
const s = new Sub();
let got = null;
s.on('ping', (v) => { got = v; });
s.emit('ping', 42);
const { EventEmitter: Destructured } = require('events');
console.log(JSON.stringify({
  typeofModule: typeof EventEmitter,
  name: EventEmitter.name,
  selfRef: Destructured === EventEmitter,   // node: true
  subclassWorks: got,
  isInstance: s instanceof EventEmitter,
  hasOnce: typeof require('events').once,
}));`);
  const nodeOut = require('node:child_process')
    .execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim();
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), JSON.parse(nodeOut));
  assert.strictEqual(JSON.parse(nodeOut).typeofModule, 'function');
});

// JOB ZERO: we have to be able to tell when a module does not load.
//
// A module whose evaluation throws was left in the shim's cache, so the SECOND
// require handed back the exports assigned before the throw and reported success.
// node removes it, so the retry re-executes and throws again.
//
// That is worse than the original failure. Code with a try/catch around a require
// — which the bundle has in several places — takes the failure path once and then
// gets a broken object it believes is good. It also misled the investigation that
// found it: a probe reported ws/lib/websocket.js as loading fine immediately after
// it had thrown, because ws/lib/stream.js had already required it and left the
// corpse in the cache.
//
// The fixture assigns exports BEFORE throwing on purpose — a cache bug is only
// visible if there is something plausible to hand back.
test('a module that throws stays uncached: the second require throws too', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-throwmod-'));
  const f = path.join(dir, 'probe.cjs');
  fs.writeFileSync(f, `const p = ${JSON.stringify(path.join(__dirname, 'fixtures/throwing-module.cjs'))};
const out = [];
for (const attempt of [1, 2]) {
  try { const m = require(p); out.push('attempt' + attempt + '=OK(keys:' + Object.keys(m).join(',') + ')'); }
  catch (e) { out.push('attempt' + attempt + '=THREW(' + e.message + ')'); }
}
console.log(JSON.stringify(out));`);
  const nodeOut = require('node:child_process')
    .execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim();
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), JSON.parse(nodeOut));
  // Pre-fix the shim gave ["...THREW...","attempt2=OK(keys:partial)"] — the
  // partial exports, presented as a successful load.
  assert.deepStrictEqual(JSON.parse(nodeOut), [
    'attempt1=THREW(boom during evaluation)',
    'attempt2=THREW(boom during evaluation)',
  ]);
});

// The failure has to be OBSERVABLE, not merely correct: a require that fails
// inside somebody's try/catch is invisible by construction, so the loader records
// every one. This is the signal that a module did not load.
test('a failed require is recorded where something can see it', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-failrec-'));
  const f = path.join(dir, 'probe.cjs');
  fs.writeFileSync(f, `const p = ${JSON.stringify(path.join(__dirname, 'fixtures/throwing-module.cjs'))};
try { require(p); } catch { /* swallowed, exactly like the bundle does */ }
const failed = globalThis.__tjs_failed_requires || [];
console.log(JSON.stringify({
  count: failed.length,
  endsWith: failed.length ? failed[0].file.endsWith('throwing-module.cjs') : false,
  message: failed.length ? failed[0].message : null,
}));`);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout.trim());
  assert.strictEqual(got.count, 1, 'a swallowed require failure must still be recorded');
  assert.strictEqual(got.endsWith, true);
  assert.strictEqual(got.message, 'boom during evaluation');
});

// Wall (Task 4): several -p transport modules require('zlib') and read
// `zlib.constants` at init (destructuring Z_*/BROTLI_* values). The constants
// table must deep-equal host node's; the compression API is present (function)
// but throws if actually invoked (the mock never compresses) — assert both.
test('zlib.constants: table matches host node; compression API present', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-zlib-'));
  const f = path.join(dir, 'zlib.cjs');
  // Stringify non-finite numbers explicitly. Comparing both sides through plain
  // JSON made this assertion BLIND to the one value that was actually wrong:
  // node's Z_MAX_CHUNK is Infinity, JSON turns that into null, and the shim's
  // table — itself snapshotted through JSON — had literally stored null. Both
  // sides serialized to null and the row passed while the surfaces differed
  // (number vs object). A fidelity check routed through a lossy encoding cannot
  // see what the encoding loses.
  fs.writeFileSync(f, `const z = require('zlib');
const enc = (o) => JSON.stringify(o, (k, v) =>
  typeof v === 'number' && !Number.isFinite(v) ? '#nonfinite:' + String(v) : v);
console.log(enc({
  constants: z.constants,
  createGunzip: typeof z.createGunzip,
  gunzipSync: typeof z.gunzipSync,
}));`);
  const nodeRaw = JSON.parse(require('node:child_process')
    .execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim());
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  const tjs = JSON.parse(r.stdout.trim());
  // ZLIB_VERNUM IDENTIFIES A BUILD, NOT A BEHAVIOUR, and comparing it couples this row
  // to whichever zlib the host node happens to bundle. Node 24.18.1 -> 24.19.0 moved it
  // 0x1310 -> 0x1321 and reddened both oracle jobs on a commit whose only change was
  // dependency bumps. Nothing about the shim got worse.
  //
  // Checked before excluding it, rather than assumed: the 2.1.246 bundle references
  // ZLIB_VERNUM in ZERO of its 1,409 modules, so no upstream behaviour depends on the
  // value. Reporting node's number instead of our own would be claiming a zlib we do not
  // link — a lie that would also break again at the next bump.
  //
  // Everything else in the table is still compared exactly, including the Z_MAX_CHUNK
  // non-finite case this row was originally written to catch.
  const VERSION_IDENTIFIERS = ['ZLIB_VERNUM'];
  const strip = (o) => { const c = { ...o }; for (const k of VERSION_IDENTIFIERS) delete c[k]; return c; };
  assert.deepStrictEqual(strip(tjs.constants), strip(nodeRaw.constants));
  // Both sides must still HAVE it, and ours must be a plausible zlib version word —
  // dropping the key entirely, or reporting nonsense, is a different bug than drifting.
  for (const k of VERSION_IDENTIFIERS) {
    assert.strictEqual(typeof tjs.constants[k], 'number', `shim lost ${k}`);
    assert.strictEqual(typeof nodeRaw.constants[k], 'number', `host node lost ${k}`);
    assert.ok(tjs.constants[k] >= 0x1200 && tjs.constants[k] <= 0x2000,
      `${k}=${tjs.constants[k]} is not a plausible zlib version word`);
  }
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
