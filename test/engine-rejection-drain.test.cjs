'use strict';
// ENGINE REGRESSION: the deferred unhandled-rejection drain must survive a handler
// that settles OTHER pending rejections, and an uncaught microtask must not die in
// silence. Both are spike/quickjs/patches/txiki-unhandledrejection-drain.patch.
//
// WHAT WAS WRONG. tjs__execute_jobs() walked qrt->pending_rejections with
// list_for_each_safe() and dispatched the 'unhandledrejection' event INSIDE the
// loop. list_for_each_safe caches `next` before the body runs — but the body runs
// JAVASCRIPT, and that JavaScript can attach a handler to another pending rejected
// promise, at which point the rejection tracker js_free()s that entry. The cached
// `next` is then a dangling pointer and the process takes SIGSEGV. Six lines of
// ordinary JavaScript reach it, and Claude Code's own unhandledRejection handler
// does exactly this shape of thing: the 2.1.278 TUI crashed here the moment its
// render started working.
//
// The second half: a job that throws stops the runtime, and in any application
// with exit/beforeunload listeners the exception is cleared by the first internal
// catch those listeners perform — so TJS_Run's closing JS_HasException() check
// found nothing and the program simply ENDED, status 0, stderr empty. That silence
// is what a missing host API looks like from the outside, and it is why "the TUI
// paints nothing" took a four-hour hunt instead of reading one line.
//
// These drive the ENGINE directly (no loader): the defect is in the C, and routing
// through the shim would only add ways for the test to pass for the wrong reason.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { skipUnlessTjs, tjsPath } = require('./node-shim-helper.cjs');

function runEngine(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rejdrain-'));
  const f = path.join(dir, 'fx.js');
  fs.writeFileSync(f, body);
  try {
    return spawnSync(tjsPath(), ['run', f], { encoding: 'utf8', timeout: 30000 });
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// The control IS the repro: without the patch this segfaults (measured: signal
// SIGSEGV, exit 139 through a shell). A pass means the loop survived and the
// timer after it still ran.
test('an unhandledrejection handler may settle OTHER pending rejections (no UAF)', (t) => {
  if (skipUnlessTjs(t)) return;
  const r = runEngine(`
    const ps = [];
    for (let i = 0; i < 8; i++) ps.push(Promise.reject(new Error('r' + i)));
    globalThis.addEventListener('unhandledrejection', (e) => {
      e.preventDefault();
      for (const p of ps) p.catch(() => {});
    });
    setTimeout(() => { console.log('SURVIVED'); }, 50);
  `);
  assert.strictEqual(r.signal, null,
    `the engine died with ${r.signal} draining pending rejections — the detach-then-dispatch `
    + `fix in txiki-unhandledrejection-drain.patch is missing or regressed. stderr: ${r.stderr}`);
  assert.strictEqual(r.status, 0, `exit ${r.status}; stderr: ${r.stderr}`);
  assert.match(r.stdout, /SURVIVED/, 'the loop did not continue past the drain');
});

// A handler that does nothing must still work, and must not fire for a rejection
// that was settled before the drain ran — the drain order is unchanged by the fix.
test('a rejection settled before the drain never reaches the handler', (t) => {
  if (skipUnlessTjs(t)) return;
  const r = runEngine(`
    let fired = 0;
    globalThis.addEventListener('unhandledrejection', (e) => { e.preventDefault(); fired++; });
    Promise.reject(new Error('caught right away')).catch(() => {});
    Promise.reject(new Error('nobody catches this one'));
    setTimeout(() => { console.log('FIRED ' + fired); }, 50);
  `);
  assert.strictEqual(r.signal, null, `died with ${r.signal}: ${r.stderr}`);
  assert.match(r.stdout, /FIRED 1/, `expected exactly one event; stdout=${r.stdout} stderr=${r.stderr}`);
});

test('an uncaught microtask exception is PRINTED even when a listener clears it', (t) => {
  if (skipUnlessTjs(t)) return;
  // THE REAL CONDITION, not a simplification of it. On a bare script the engine
  // already reported this from TJS_Run's closing JS_HasException() check. An
  // application does not look like a bare script: its exit/beforeunload listeners
  // run JavaScript, and the first `try/catch` any of them performs calls
  // JS_GetException() and clears the pending exception out from under that check.
  // The two listeners below are that, minimised — and on the UNPATCHED engine this
  // fixture prints NOTHING AT ALL and exits 0, which is exactly what a quaude built
  // from an upstream needing a host API we lack did on both darwin-arm64 and
  // netbsd-arm64: boot escapes, then gone.
  const r = runEngine(`
    globalThis.addEventListener('unload', () => { try { null.x; } catch (e) { /* clears it */ } });
    globalThis.addEventListener('beforeunload', () => { try { null.x; } catch (e) { /* same */ } });
    queueMicrotask(() => { throw new Error('SENTINEL-microtask-throw'); });
    setTimeout(() => { console.log('unreachable'); }, 50);
  `);
  assert.match(r.stderr, /SENTINEL-microtask-throw/,
    'a job that stops the runtime must say why on stderr — that silence is the bug');
  assert.doesNotMatch(r.stdout, /unreachable/, 'the runtime should have stopped');
});

test('printing the exception does not change the exit status the engine reported', (t) => {
  if (skipUnlessTjs(t)) return;
  // The dump is non-consuming (tjs_dump_error1 + JS_Throw back), so a bare script —
  // where the exception DOES survive to TJS_Run — still exits 1. A gate that read
  // this status must not silently go green because we started printing earlier.
  const r = runEngine(`
    queueMicrotask(() => { throw new Error('SENTINEL-bare-throw'); });
    setTimeout(() => { console.log('unreachable'); }, 50);
  `);
  assert.strictEqual(r.signal, null, `died with ${r.signal}: ${r.stderr}`);
  assert.strictEqual(r.status, 1, `expected exit 1, got ${r.status}; stderr: ${r.stderr}`);
  assert.match(r.stderr, /SENTINEL-bare-throw/);
});
