'use strict';
// Characterizes that the GLOBAL timer functions return Node-shaped Timeout /
// Immediate HANDLES (ref/unref/hasRef/refresh + numeric coercion) rather than
// txiki's bare NUMBER. The extracted bundle pervasively uses the Node idiom
// `setTimeout(...).unref()` (e.g. its DataDog telemetry-flush timer) — on a bare
// number that throws `TypeError: not a function`, which silently bails the -p
// action before the Messages round-trip. Matched against host node for the same
// fixture. SKIPs without tjs.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

function prog(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-timers-'));
  const f = path.join(dir, 'p.cjs');
  fs.writeFileSync(f, body);
  return f;
}

const BODY = `
  const t = setTimeout(() => {}, 10000);
  const out = {
    unref: typeof t.unref, ref: typeof t.ref, hasRef: typeof t.hasRef, refresh: typeof t.refresh,
    unrefReturnsSelf: t.unref() === t,
    hasRefAfterUnref: t.hasRef(),
    hasRefAfterRef: (t.ref(), t.hasRef()),
    coerces: (typeof Number(t) === 'number' && !Number.isNaN(Number(t))),
  };
  clearTimeout(t);
  const iv = setInterval(() => {}, 10000);
  out.ivUnref = typeof iv.unref;
  clearInterval(iv);
  const im = setImmediate(() => {});
  out.imUnref = typeof im.unref;
  clearImmediate(im);
  console.log(JSON.stringify(out));
`;

test('timers: setTimeout/setInterval/setImmediate return Node-shaped handles', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = prog(BODY);
  const node = JSON.parse(require('node:child_process').execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim());
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), node);
});

test('timers: clearTimeout accepts the handle and cancels the timer', (t) => {
  if (skipUnlessTjs(t)) return;
  // If clearTimeout(handle) fails to cancel (e.g. it can't map the handle back
  // to txiki's numeric id), the callback fires and prints FIRED.
  const f = prog(`
    const t = setTimeout(() => { console.log('FIRED'); }, 50);
    clearTimeout(t);
    setTimeout(() => { console.log('DONE'); }, 200);
  `);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), 'DONE');
});

// RECIPE G6 root cause: txiki's timer module has NO native per-timer
// uv_ref/uv_unref (unlike streams/TLS, which do — mod_streams.c/mod_tls.c).
// unref() used to be a pure JS-side flag flip with no effect on the real
// underlying timer, so a genuinely `.unref()`'d long-delay timer (the
// bundle's telemetry-flush pattern: `setTimeout(fn, 600000).unref()`) kept
// the real event loop alive regardless — the process could not exit until
// that real delay elapsed, however long it was. Host node, by contrast, lets
// the process exit immediately once nothing else is pending. This is the
// direct mechanism behind the RECIPE G6 hang (traced live: the bundle calls
// unref() on both setTimeout and setInterval handles extensively during a
// `-p` boot).
test('timers: a genuinely unref()d long timer does not block process exit (matches node)', (t) => {
  if (skipUnlessTjs(t)) return;
  const body = `
    const t = setTimeout(() => { console.log('SHOULD NEVER FIRE'); }, 600000);
    t.unref();
    console.log('done');
  `;
  const f = prog(body);
  const node = require('node:child_process').execFileSync(process.execPath, [f], { encoding: 'utf8', timeout: 5000 }).trim();
  assert.strictEqual(node, 'done'); // sanity-anchor: node itself must not hang or fire
  const r = runLoader(f, [], { timeout: 8000 });
  assert.strictEqual(r.status, 0, `expected a clean drain, got status=${r.status} stderr=${r.stderr}`);
  assert.strictEqual(r.stdout.trim(), 'done');
});

// Same mechanism, setInterval — the bundle also unref()s recurring timers.
test('timers: a genuinely unref()d interval does not block process exit (matches node)', (t) => {
  if (skipUnlessTjs(t)) return;
  const body = `
    const iv = setInterval(() => { console.log('SHOULD NEVER FIRE'); }, 600000);
    iv.unref();
    console.log('done');
  `;
  const f = prog(body);
  const node = require('node:child_process').execFileSync(process.execPath, [f], { encoding: 'utf8', timeout: 5000 }).trim();
  assert.strictEqual(node, 'done');
  const r = runLoader(f, [], { timeout: 8000 });
  assert.strictEqual(r.status, 0, `expected a clean drain, got status=${r.status} stderr=${r.stderr}`);
  assert.strictEqual(r.stdout.trim(), 'done');
});

// ref() must undo unref(): re-arming the timer so it genuinely fires again
// (and once more pins the process alive until it does) if called again
// before the original delay would have elapsed. Uses a short delay so the
// test itself completes quickly.
test('timers: ref() after unref() re-arms the timer so it still fires and pins exit (matches node)', (t) => {
  if (skipUnlessTjs(t)) return;
  const body = `
    const t = setTimeout(() => { console.log('fired'); }, 100);
    t.unref();
    t.ref();
  `;
  const f = prog(body);
  const node = require('node:child_process').execFileSync(process.execPath, [f], { encoding: 'utf8', timeout: 5000 }).trim();
  assert.strictEqual(node, 'fired'); // sanity-anchor: ref() must resurrect it in real node too
  const r = runLoader(f, [], { timeout: 5000 });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), 'fired');
});

// A REF'D (default) long timer must still behave as a real, live handle —
// this fix must not accidentally make ordinary (non-unref'd) timers stop
// pinning the process, which would be a correctness regression in the
// opposite direction.
test('timers: a ref\'d (non-unref\'d) timer still fires and still pins the process (unchanged)', (t) => {
  if (skipUnlessTjs(t)) return;
  const body = `
    setTimeout(() => { console.log('fired'); }, 100);
  `;
  const f = prog(body);
  const node = require('node:child_process').execFileSync(process.execPath, [f], { encoding: 'utf8', timeout: 5000 }).trim();
  assert.strictEqual(node, 'fired');
  const r = runLoader(f, [], { timeout: 5000 });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), 'fired');
});

// RECIPE G6, second half of the root cause. The tests above prove unref()
// stops the real underlying raw timer (fixed in c01e795) — but that alone
// does not prove unref() stops the handle counting toward
// __shimTimerLiveCount(). It did not: unref() cleared `armed` (the real timer)
// but left `live` (the liveTimerCount contribution) true, so an unref'd timer
// stayed counted as outstanding work forever. Nothing in the tests above can
// observe that miscounting, because __shimTimerLiveCount() has no consumer
// in a script with no fs.watchFile poller — the bundle-shaped repro needs
// BOTH ~19 unref'd background timers AND a live watchFile poller reading the
// count (see node-shim-fs-watch.test.cjs for that integration shape). This is
// the tightest possible unit check on the count itself: it must reach exactly
// zero once every live timer has been unref'd, matching the mental model
// "unref'd == does not keep the process alive == not outstanding work."
test('timers: __shimTimerLiveCount() reaches 0 once every timer is unref()d (RECIPE G6)', (t) => {
  if (skipUnlessTjs(t)) return;
  const body = `
    // Mirrors the extracted bundle's own shape: ~19 background setTimeout/
    // setInterval handles created and immediately unref'd during boot.
    const handles = [];
    for (let i = 0; i < 19; i++) handles.push(setTimeout(() => {}, 600000));
    for (let i = 0; i < 19; i++) handles[i].unref();
    console.log(JSON.stringify({ count: globalThis.__shimTimerLiveCount() }));
  `;
  const f = prog(body);
  const r = runLoader(f, [], { timeout: 5000 });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), { count: 0 },
    `expected 0 live timers after unref()ing all of them; stdout=${r.stdout}`);
});

// Symmetric half: ref() after unref() must undo the decrement too, or a
// resurrected timer would silently stop contributing to the count it's
// supposed to be pinning again.
test('timers: ref() after unref() restores __shimTimerLiveCount() (RECIPE G6)', (t) => {
  if (skipUnlessTjs(t)) return;
  const body = `
    const a = setTimeout(() => {}, 600000);
    const b = setTimeout(() => {}, 600000);
    a.unref(); b.unref();
    const afterUnref = globalThis.__shimTimerLiveCount();
    a.ref();
    const afterRef = globalThis.__shimTimerLiveCount();
    // Cleanup: unref both again so this script itself exits promptly rather
    // than waiting out the 600s delay it just re-armed on 'a'.
    a.unref(); b.unref();
    console.log(JSON.stringify({ afterUnref, afterRef }));
  `;
  const f = prog(body);
  const r = runLoader(f, [], { timeout: 5000 });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), { afterUnref: 0, afterRef: 1 },
    `expected count 0 after unref()ing both, back to 1 after ref()ing one; stdout=${r.stdout}`);
});
