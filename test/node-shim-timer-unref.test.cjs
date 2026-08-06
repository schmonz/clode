'use strict';
// Engine-level bug: AbortSignal.timeout(ms) created a REF'D timer, so it held
// the event loop open for the full timeout even with nothing else pending —
// node unrefs this internal timer (a bare `AbortSignal.timeout(10000)` exits
// immediately on node). Reproduces on BARE tjs (no node-shim involved): tjs's
// setTimeout returns a plain int64 id with no handle object for `.unref()` to
// live on, so patches/txiki-timer-unref.patch adds core.unrefTimer(id)/
// refTimer(id) (src/timers.c, id-keyed uv_unref/uv_ref on the underlying
// uv_timer_t) and has abort-controller.js call it on its internal timer.
// Fixed at the engine layer, so these run the bare engine directly
// (engineSpawn) rather than through libexec/node-shim/loader.cjs.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { skipUnlessTjs, engineSpawn } = require('./node-shim-helper.cjs');

function writeProg(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'timer-unref-'));
  const f = path.join(dir, 'p.js');
  fs.writeFileSync(f, body);
  return f;
}

function runBare(file, timeoutMs) {
  const [cmd, argv] = engineSpawn(['run', file]);
  const t0 = Date.now();
  const r = spawnSync(cmd, argv, { encoding: 'utf8', timeout: timeoutMs });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', elapsedMs: Date.now() - t0 };
}

test('AbortSignal.timeout(ms) alone does not pin the event loop (bare tjs)', (t) => {
  if (skipUnlessTjs(t)) return;
  // Nothing else scheduled: if the timer is ref'd, this blocks ~10s (the old
  // bug, reproduced on bare tjs pre-fix: 10-11s). Fixed, it should exit near
  // -instantly. Generous 5s ceiling: well under the 10s bug symptom, comfortably
  // above noise on a loaded CI box.
  const f = writeProg(`
    const s = AbortSignal.timeout(10000);
    console.log('created');
  `);
  const r = runBare(f, 15000);
  assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /created/);
  assert.ok(r.elapsedMs < 5000, `expected exit well under 5000ms, took ${r.elapsedMs}ms`);
});

test('AbortSignal.timeout(ms) still fires: fetch aborts with a timeout-shaped reason near ms, not a late network error', (t) => {
  if (skipUnlessTjs(t)) return;
  // Unref-ing the internal timer must not change WHEN it fires or break the
  // abort wiring. Regression guard for the naive shim-level fix that was tried
  // and rejected: it broke the fetch, which failed with a bare TypeError at
  // ~15s (an unrelated network-stack timeout) instead of the abort at ~1.2s.
  // 10.255.255.1 is a non-routable LAN address (ARP goes unanswered), so the
  // TCP connect is reliably still pending well past 1.2s in any environment.
  const f = writeProg(`
    const t0 = Date.now();
    fetch('http://10.255.255.1:9999/', { method: 'HEAD', signal: AbortSignal.timeout(1200) })
      .then(() => { console.log('UNEXPECTED_SUCCESS'); })
      .catch((e) => {
        console.log('ELAPSED_MS', Date.now() - t0);
        console.log('NAME', e && e.name);
        console.log('CTOR', e && e.constructor && e.constructor.name);
      });
  `);
  const r = runBare(f, 15000);
  assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
  assert.doesNotMatch(r.stdout, /UNEXPECTED_SUCCESS/);
  const elapsedMatch = r.stdout.match(/ELAPSED_MS (\d+)/);
  assert.ok(elapsedMatch, `expected ELAPSED_MS in stdout, got: ${r.stdout} / stderr: ${r.stderr}`);
  const elapsed = Number(elapsedMatch[1]);
  // Must abort near the 1200ms deadline, NOT ride out to some unrelated
  // network-stack timeout (the naive-fix failure mode landed at ~15000ms).
  assert.ok(elapsed >= 1000 && elapsed < 5000, `expected abort near 1200ms, got ${elapsed}ms`);
  // TimeoutError specifically, not "either shape": AbortError here means fetch
  // discarded the signal's reason (patches/txiki-fetch-abort-reason.patch).
  assert.match(r.stdout, /NAME TimeoutError/);
});

// patches/txiki-fetch-abort-reason.patch. fetch.js hardcoded
// `new DOMException('Aborted', 'AbortError')` at all FOUR of its abort sites,
// so every abort reason was flattened to AbortError: AbortSignal.timeout()
// surfaced as AbortError instead of TimeoutError, and a custom
// controller.abort(reason) never reached the caller at all. Per spec (and
// node) an aborted fetch rejects with the signal's OWN reason. ws-stream.js in
// the same tree already did `signal.reason ?? ...`; fetch.js did not.
test('an aborted fetch rejects with the signal\'s OWN reason, not a flattened AbortError', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = writeProg(`
    const c = new AbortController();
    setTimeout(() => c.abort(new Error('custom-boom')), 300);
    fetch('http://10.255.255.1:9999/', { method: 'HEAD', signal: c.signal })
      .then(() => { console.log('UNEXPECTED_SUCCESS'); })
      .catch((e) => { console.log('NAME', e && e.name); console.log('MSG', e && e.message); });
  `);
  const r = runBare(f, 15000);
  assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
  assert.doesNotMatch(r.stdout, /UNEXPECTED_SUCCESS/);
  // The custom reason must arrive intact. Pre-fix this was `AbortError` with
  // message 'Aborted' — the caller could not tell WHY it was aborted.
  assert.match(r.stdout, /NAME Error/);
  assert.match(r.stdout, /MSG custom-boom/);
});

test('an abort with no reason still falls back to AbortError (matches node)', (t) => {
  if (skipUnlessTjs(t)) return;
  // The fallback half of the same fix: signal.reason is undefined for a bare
  // abort(), and node reports AbortError there. Guards against "just use
  // signal.reason" regressing the no-reason case to undefined.
  const f = writeProg(`
    const c = new AbortController();
    c.abort();
    fetch('http://10.255.255.1:9999/', { method: 'HEAD', signal: c.signal })
      .then(() => { console.log('UNEXPECTED_SUCCESS'); })
      .catch((e) => { console.log('NAME', e && e.name); });
  `);
  const r = runBare(f, 15000);
  assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
  assert.doesNotMatch(r.stdout, /UNEXPECTED_SUCCESS/);
  assert.match(r.stdout, /NAME AbortError/);
});
