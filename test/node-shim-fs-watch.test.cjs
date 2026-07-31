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
  const f = prog(`
    const fs = require('node:fs');
    const target = process.argv[2];
    let aCalls = 0, bCalls = 0;
    const a = () => { aCalls++; };
    const b = () => { bCalls++; fs.unwatchFile(target, a); };
    fs.watchFile(target, { interval: 60 }, a);
    fs.watchFile(target, { interval: 60 }, b);
    setTimeout(() => { fs.writeFileSync(target, 'first change'); }, 150);
    setTimeout(() => {
      // a was removed by b's first firing; b should still be watching alone.
      fs.writeFileSync(target, 'second change, much longer this time');
    }, 400);
    setTimeout(() => {
      fs.unwatchFile(target);
      console.log(JSON.stringify({ aCalls, bCalls }));
    }, 700);
  `);
  const dir = path.dirname(f);
  const target = path.join(dir, 'watched.txt');
  fs.writeFileSync(target, 'x');
  const r = runLoader(f, [target], { timeout: 10000 });
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  assert.strictEqual(out.aCalls, 1, `a should fire exactly once (removed after its first call); got ${out.aCalls}`);
  assert.strictEqual(out.bCalls, 2, `b should fire for both changes (never removed); got ${out.bCalls}`);
});

// Regression guard for the "unref'd timer" divergence (modules/fs.cjs,
// fsMod.watchFile / _loopHasOtherWork): this engine exposes no real per-timer
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
