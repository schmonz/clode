'use strict';
// fs.watchFile / unwatchFile / watch, exercised against the real tjs engine.
//
// UPDATED (was a characterization of a non-firing stub): fs.watchFile now
// polls for real (modules/fs.cjs) — the stub's "register but never FIRE
// change events" divergence turned into a live bug once the bundle's
// git-state cache started awaiting a 'change' that could never arrive (an
// `async get(){ for(;;){ ...; await once('change', ...) } }` loop gated on a
// generation counter only a fired watcher callback advances), reliably
// hanging a darwin-ppc `-p` run right after git-remote detection. This file
// now asserts the REAL behavior: listeners actually fire on a real mtime/size
// change, unwatchFile actually stops delivery, multiple listeners on one path
// share a poller and can be removed independently, and — the regression guard
// for the "unref'd timer" divergence documented in modules/fs.cjs — a script
// that registers a watchFile and never calls unwatchFile still lets the
// process EXIT instead of hanging on a poller nothing else needs.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

function prog(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-fswatch-'));
  const f = path.join(dir, 'p.cjs');
  fs.writeFileSync(f, body);
  return f;
}

test('fs.watchFile/unwatchFile/watch are callable with node-shaped handles', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = prog(`
    const fs = require('node:fs');
    const out = {};
    out.watchFile = typeof fs.watchFile;
    out.unwatchFile = typeof fs.unwatchFile;
    out.watch = typeof fs.watch;
    const w = fs.watchFile(__filename, () => {});
    out.w_ref = typeof w.ref;
    out.w_unref = typeof w.unref;
    fs.unwatchFile(__filename);
    const fw = fs.watch(__filename, () => {});
    out.fw_close = typeof fw.close;
    fw.close();
    console.log(JSON.stringify(out));`);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), {
    watchFile: 'function', unwatchFile: 'function', watch: 'function',
    w_ref: 'function', w_unref: 'function', fw_close: 'function',
  });
});

test('fs.watchFile fires the listener with (curr, prev) Stats after a real change', (t) => {
  if (skipUnlessTjs(t)) return;
  // Short interval (well under Node's 5007ms default) so the poll cycle that
  // must observe the mutation completes inside the test's own budget.
  const f = prog(`
    const fs = require('node:fs');
    const target = process.argv[2];
    fs.watchFile(target, { interval: 60 }, (curr, prev) => {
      console.log(JSON.stringify({
        currIsStats: curr.constructor.name,
        prevIsStats: prev.constructor.name,
        mtimeGrew: curr.mtimeMs >= prev.mtimeMs,
        sizeChanged: curr.size !== prev.size,
        currSize: curr.size,
        prevSize: prev.size,
      }));
      fs.unwatchFile(target);
    });
    // Mutate shortly after the baseline poll has had a chance to run once.
    setTimeout(() => { fs.writeFileSync(target, 'a much longer payload than the original'); }, 150);
  `);
  const dir = path.dirname(f);
  const target = path.join(dir, 'watched.txt');
  fs.writeFileSync(target, 'x');
  const r = runLoader(f, [target], { timeout: 10000 });
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  assert.strictEqual(out.currIsStats, 'Stats');
  assert.strictEqual(out.prevIsStats, 'Stats');
  assert.strictEqual(out.sizeChanged, true);
  assert.ok(out.currSize > out.prevSize, `expected growth; prev=${out.prevSize} curr=${out.currSize}`);
});

test('fs.unwatchFile stops delivery: no callbacks fire after unwatch', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = prog(`
    const fs = require('node:fs');
    const target = process.argv[2];
    let calls = 0;
    fs.watchFile(target, { interval: 50 }, () => { calls++; });
    setTimeout(() => {
      fs.unwatchFile(target);
      // Mutate AFTER unwatching — if delivery weren't really stopped this
      // would fire and calls would grow past whatever it was at unwatch time.
      fs.writeFileSync(target, 'mutated after unwatch');
      setTimeout(() => { console.log(JSON.stringify({ calls })); }, 300);
    }, 150);
  `);
  const dir = path.dirname(f);
  const target = path.join(dir, 'watched.txt');
  fs.writeFileSync(target, 'x');
  const r = runLoader(f, [target], { timeout: 10000 });
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  // At most the pre-unwatch change (original write -> baseline is a no-fire,
  // so realistically 0); the load-bearing assertion is that it does NOT keep
  // climbing after the post-unwatch mutation.
  assert.ok(out.calls <= 1, `expected watch to have stopped delivering; calls=${out.calls}`);
});

test('two listeners on one path both fire; removing one leaves the other working', (t) => {
  if (skipUnlessTjs(t)) return;
  // EVENT-DRIVEN, NOT DEADLINE-DRIVEN. The original version wrote at 150ms and
  // 400ms and reported at 700ms with a 60ms poll interval. That measures the
  // BOX, not the shim: on the emulated big-endian oracle under a full release
  // matrix (44 concurrent jobs) the second change had not been observed by
  // 700ms, so bCalls was 1 and the release was blocked by a green product.
  // Sequencing each step on the PREVIOUS observation makes the assertion true
  // on any speed of hardware while testing exactly the same semantics.
  const f = prog(`
    const fs = require('node:fs');
    const target = process.argv[2];
    let aCalls = 0, bCalls = 0, reported = false, guard = null;
    const report = (why) => {
      if (reported) return;
      reported = true;
      if (guard !== null) clearTimeout(guard);
      fs.unwatchFile(target);
      console.log(JSON.stringify({ aCalls, bCalls, why }));
    };
    const a = () => { aCalls++; };
    const b = () => {
      bCalls++;
      if (bCalls === 1) {
        // a is removed by b's FIRST firing; b must keep watching alone.
        fs.unwatchFile(target, a);
        // Only now trigger the second change, so the two detections cannot
        // collapse into one poll window on a slow box.
        setTimeout(() => {
          fs.writeFileSync(target, 'second change, much longer this time');
        }, 0);
      } else {
        report('saw-both');
      }
    };
    fs.watchFile(target, { interval: 60 }, a);
    fs.watchFile(target, { interval: 60 }, b);
    setTimeout(() => { fs.writeFileSync(target, 'first change'); }, 50);
    // Safety net so a pathologically slow box reports the REAL counts and fails
    // the assertion below with a readable message, instead of tripping
    // runLoader's spawn timeout and reporting nothing at all.
    guard = setTimeout(() => report('deadline'), 8000);
  `);
  const dir = path.dirname(f);
  const target = path.join(dir, 'watched.txt');
  fs.writeFileSync(target, 'x');
  const r = runLoader(f, [target], { timeout: 10000 });
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  assert.strictEqual(out.why, 'saw-both',
    `the second change was never observed before the 8s safety deadline; got ${JSON.stringify(out)}`);
  assert.strictEqual(out.aCalls, 1, `a should fire exactly once (removed after its first call); got ${out.aCalls}`);
  assert.strictEqual(out.bCalls, 2, `b should fire for both changes (never removed); got ${out.bCalls}`);
});

// Regression guard for the "unref'd timer" divergence (modules/fs.cjs,
// fsMod.watchFile / _otherWorkPending): this engine exposes no real per-timer
// ref/unref to JS, so a naive poller (plain setInterval, never cleared) would
// pin the event loop forever — proven manually against the raw engine (a bare
// `setInterval(fn, 50)` with nothing else scheduled has to be killed; it never
// lets the process exit). A watchFile registration that is never unwatched
// must still let a finished script exit, or a genuinely idle `-p` run would
// hang forever the moment it touches a watched config file.
test('a watchFile registration that is never unwatched still lets the process exit', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = prog(`
    const fs = require('node:fs');
    const target = process.argv[2];
    fs.watchFile(target, { interval: 50 }, () => {});
    console.log('registered, falling off the end of the script now');
    // Deliberately: no unwatchFile, no process.exit(). If the poller pins the
    // loop, runLoader's spawnSync times out (status stays null) instead of
    // returning a real 0.
  `);
  const dir = path.dirname(f);
  const target = path.join(dir, 'watched.txt');
  fs.writeFileSync(target, 'x');
  const t0 = Date.now();
  const r = runLoader(f, [target], { timeout: 10000 });
  const elapsed = Date.now() - t0;
  assert.strictEqual(r.status, 0, `expected a clean exit, not a hang; stderr=${r.stderr} elapsed=${elapsed}ms`);
  assert.match(r.stdout, /registered, falling off the end/);
  // Generous ceiling: proves this is "the loop noticed it was otherwise idle
  // and let go", not "runLoader's own timeout fired and killed it" (which
  // would also report a non-null status in some environments, but check the
  // wall-clock too so a silent regression to timeout-shaped behavior can't
  // hide behind a coincidental exit code).
  assert.ok(elapsed < 9000, `expected a prompt exit well under the 10s timeout; took ${elapsed}ms`);
});

// Directly exercises the __shimTimerLiveCount() mechanism that replaced
// __tjs_dump_handles() parsing (loader.cjs's "live-timer count" + modules/fs.cjs's
// _otherWorkPending()): the poller must correctly tell the difference between
// "nothing else is happening" (stop, see the test above) and "something else
// with a live JS timer is still pending" (keep polling for it), using only its
// own counter — no debug introspection. Two unrelated setTimeouts, with no
// connection to the watcher at all, keep the loop alive for a while; the
// watcher must keep firing 'change' for as long as they're pending (proving
// _otherWorkPending() correctly saw them and re-armed), and the process must
// still exit promptly once they're both done and nothing else was ever
// unwatched (proving the poller then correctly stops on its own, exactly like
// the no-other-work case, rather than the counter getting stuck non-zero).
test('a watchFile registration outlives unrelated pending timers, then still lets the process exit', (t) => {
  if (skipUnlessTjs(t)) return;
  // Same deadline-vs-event fix as the two-listener test above: the original
  // wrote at 250ms and reported at a FIXED 400ms, which on the emulated
  // big-endian oracle reported calls=0 simply because the poller had not
  // ticked yet. The unrelated timers are now a CHAIN that keeps the loop alive
  // (which is the property under test) and reports as soon as the change has
  // actually been observed.
  const f = prog(`
    const fs = require('node:fs');
    const target = process.argv[2];
    let calls = 0, reported = false, guard = null;
    const report = (phase) => {
      if (reported) return;
      reported = true;
      if (guard !== null) clearTimeout(guard);
      console.log(JSON.stringify({ calls, phase }));
    };
    fs.watchFile(target, { interval: 60 }, () => { calls++; });
    // Neither of these touches the watcher; they exist purely to keep the
    // loop alive via ordinary (counted) timers while the poller ticks
    // underneath them with its own, separately-scheduled raw timer.
    setTimeout(() => {
      fs.writeFileSync(target, 'changed while an unrelated timer was still pending');
    }, 100);
    // A chain of ORDINARY timers — still "unrelated pending work" from the
    // poller's perspective, exactly as a single setTimeout was, but it waits
    // for the observation instead of guessing how long it takes.
    let ticks = 0;
    const tick = () => {
      if (calls >= 1) { report('unrelated-timers-done'); return; }
      if (++ticks > 120) { report('gave-up'); return; }
      setTimeout(tick, 50);
    };
    setTimeout(tick, 150);
    guard = setTimeout(() => report('deadline'), 8000);
    // Deliberately: no unwatchFile, no process.exit() after that. If
    // __shimTimerLiveCount() ever got stuck above zero (e.g. a fired
    // one-shot failing to uncount itself), this would hang exactly like the
    // no-other-work regression test above, just later.
  `);
  const dir = path.dirname(f);
  const target = path.join(dir, 'watched.txt');
  fs.writeFileSync(target, 'x');
  const t0 = Date.now();
  const r = runLoader(f, [target], { timeout: 10000 });
  const elapsed = Date.now() - t0;
  assert.strictEqual(r.status, 0, `expected a clean exit, not a hang; stderr=${r.stderr} elapsed=${elapsed}ms`);
  const out = JSON.parse(r.stdout.trim());
  assert.strictEqual(out.phase, 'unrelated-timers-done',
    `watcher never observed the change while unrelated timers were pending; got ${JSON.stringify(out)}`);
  assert.ok(out.calls >= 1, `watcher should have kept delivering while an unrelated timer was pending; calls=${out.calls}`);
  // Must not have exited before the unrelated timers' work was done (proves the
  // poller kept re-arming instead of self-cancelling early). Floored at the
  // first unrelated timer rather than the old fixed 400ms report deadline,
  // which no longer exists — reaching phase 'unrelated-timers-done' at all now
  // proves the sequencing that the wall-clock number used to stand in for.
  assert.ok(elapsed >= 100, `expected to still be running past the 100ms unrelated timer; elapsed=${elapsed}ms`);
  // ...but must still exit promptly afterward (proves the poller then
  // correctly resumes self-cancelling, same as the no-other-work case).
  assert.ok(elapsed < 9000, `expected a prompt exit once nothing else was pending; elapsed=${elapsed}ms`);
});

// THE ACTUAL RECIPE G6 SHAPE, end to end. The two tests above prove the
// poller idle-stops when there is genuinely no other work, and keeps polling
// while unrelated REF'D timers are pending. Neither reproduces G6: the real
// hang needed a watchFile poller ALONGSIDE a pile of UNREF'D timers — the
// extracted bundle's own pattern (~19 `setTimeout(fn, 600000).unref()`-shaped
// telemetry/housekeeping timers during boot). Before the liveTimerCount fix
// (loader.cjs ref()/unref()), an unref'd timer stopped its real underlying
// timer but stayed counted in __shimTimerLiveCount() forever, so
// _otherWorkPending() (modules/fs.cjs) never went false, the poller's
// idle-stop branch never ran, and it re-armed itself on a REF'D raw timer
// every interval — permanently. That pinned the loop even though NOTHING in
// the script was still doing real work: this is the exact mechanism, not an
// analogy. CLODE_SHIM_TRACE=1 lets this assert the poller actually took the
// idle-stop branch, not merely that the process happened to exit before the
// timeout.
test('a watchFile poller idle-stops (and the process exits) even with a pile of unref\'d timers pending (RECIPE G6)', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = prog(`
    const fs = require('node:fs');
    const target = process.argv[2];
    // Bundle-shaped: many long-delay timers, immediately unref'd — exactly
    // like the extracted bundle's telemetry/housekeeping timers at boot.
    for (let i = 0; i < 19; i++) setTimeout(() => {}, 600000).unref();
    fs.watchFile(target, { interval: 50 }, () => {});
    console.log('registered, falling off the end of the script now');
    // Deliberately: no unwatchFile, no process.exit(), none of the 19 timers
    // ever ref()'d or cleared. If liveTimerCount ever miscounts an unref'd
    // timer as live, the poller can never idle-stop and this hangs exactly
    // like the "never unwatched" test above, just now with company.
  `);
  const dir = path.dirname(f);
  const target = path.join(dir, 'watched.txt');
  fs.writeFileSync(target, 'x');
  const t0 = Date.now();
  const r = runLoader(f, [target], { timeout: 10000, env: { CLODE_SHIM_TRACE: '1' } });
  const elapsed = Date.now() - t0;
  assert.strictEqual(r.status, 0, `expected a clean exit, not a hang; stderr=${r.stderr} elapsed=${elapsed}ms`);
  assert.match(r.stdout, /registered, falling off the end/);
  assert.match(r.stderr, /\[watchfile\] idle-stop/,
    `expected the poller to actually take its idle-stop branch (not merely exit before the timeout); stderr=${r.stderr}`);
  assert.ok(elapsed < 9000, `expected a prompt exit well under the 10s timeout; took ${elapsed}ms`);
});
