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

// TIMER-UNREF-STILL-FIRES. An unref'd timer does not keep the process alive, but
// while something ELSE does, node still fires it. The shim used to STOP the real
// timer on unref() (the engine gave it no per-timer uv_unref), so it never fired
// at all. The tests above could not see that: each one either has nothing else
// keeping the loop alive, or re-refs the timer. That divergence held a TUI turn's
// answer unpainted until the next keystroke (NetBSD tui-probe D1, 7 of 8 runs):
// the bundle's nonblocking stdout writer retries an EAGAIN from an unref'd timer.
// Fixed through the engine's __tjs_timer_setref (txiki-timer-ref-global.patch).
test('timers: an unref()d timer still fires while other work keeps the loop alive (matches node)', (t) => {
  if (skipUnlessTjs(t)) return;
  const body = `
    const out = [];
    const u = setTimeout(() => { out.push('unref-timeout'); }, 30);
    u.unref();
    let n = 0;
    const iv = setInterval(() => { if (++n === 2) { out.push('unref-interval'); clearInterval(iv); } }, 20);
    iv.unref();
    const r = setTimeout(() => {}, 60000);
    r.unref();
    r.refresh(); // still unref'd after a refresh, as in node: it must not pin the exit below
    setTimeout(() => { console.log(JSON.stringify(out.sort())); }, 400); // the ref'd work
  `;
  const f = prog(body);
  const node = require('node:child_process').execFileSync(process.execPath, [f], { encoding: 'utf8', timeout: 5000 }).trim();
  assert.strictEqual(node, '["unref-interval","unref-timeout"]'); // the reference: both fire, and nothing pins exit
  const r = runLoader(f, [], { timeout: 8000 });
  assert.strictEqual(r.status, 0, `status=${r.status} stderr=${r.stderr}`);
  assert.strictEqual(r.stdout.trim(), node);
});

// The bundle's shape, end to end (2.1.283's chunk-14ycq111, the TUI's nonblocking
// stdout): writeSync to an O_NONBLOCK descriptor, a write that meets EAGAIN queued,
// and the queue drained ONLY by `setTimeout(retry, ms).unref()`. A FIFO stands in
// for the terminal: its reader starts late, so the first writes fill it. The reader
// must get every byte while the writer is still alive (its ref'd keepalive is the
// TUI's stdin). Before the fix the retry never ran and the tail never arrived.
test('timers: a nonblocking writer\'s unref()d EAGAIN retry drains its queue while the loop is alive (matches node)', async (t) => {
  if (skipUnlessTjs(t)) return;
  if (process.platform === 'win32') { t.skip('no mkfifo(1) on Windows; the unref test above covers the timer itself there'); return; }
  const { spawn, spawnSync } = require('node:child_process');
  const { engineSpawn, LOADER } = require('./node-shim-helper.cjs');
  const writer = prog(`
    const fs = require('fs');
    const fd = fs.openSync(process.argv[2], fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
    const queue = [Buffer.concat([Buffer.alloc(1 << 20, 0x61), Buffer.from('END\\n')])];
    const write = (b) => { try { return fs.writeSync(fd, b); } catch (e) { if (e.code === 'EAGAIN') return 0; throw e; } };
    let retries = 0;
    function drain() {
      while (queue.length) {
        const b = queue[0];
        const n = write(b);
        if (n === 0) { retries++; setTimeout(drain, 5).unref(); return; }
        if (n < b.length) queue[0] = b.subarray(n); else queue.shift();
      }
      process.stderr.write('drained after ' + retries + ' retries\\n');
    }
    drain();
    setTimeout(() => {}, 5000); // the TUI's stdin: other work keeping the loop alive
  `);
  const runOne = (cmd, argv) => new Promise((resolve) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-fifo-'));
    const fifo = path.join(dir, 'tty');
    const mk = spawnSync('mkfifo', [fifo]);
    assert.strictEqual(mk.status, 0, `mkfifo: ${mk.stderr}`);
    const rfd = fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK); // the writer's open needs a reader
    const child = spawn(cmd, [...argv, fifo], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    let got = 0, tail = '', endAt = null, exited = false;
    const buf = Buffer.alloc(65536);
    const t0 = Date.now();
    const closed = new Promise((ok) => child.on('close', () => { exited = true; ok(); }));
    const poll = setInterval(() => {
      if (Date.now() - t0 < 300) return; // the late reader: the writer has already met EAGAIN
      for (;;) {
        let n;
        try { n = fs.readSync(rfd, buf, 0, buf.length, null); } catch (e) { if (e.code === 'EAGAIN') break; throw e; }
        if (n === 0) break;
        got += n;
        tail = (tail + buf.toString('latin1', 0, n)).slice(-8);
        if (endAt === null && tail.endsWith('END\n')) endAt = { ms: Date.now() - t0, writerAlive: !exited };
      }
      if (exited || endAt) {
        clearInterval(poll);
        child.kill(); // a writer that drained has nothing left to do but wait out its keepalive
        closed.then(() => { fs.closeSync(rfd); fs.rmSync(dir, { recursive: true, force: true }); resolve({ got, endAt, stderr }); });
      }
    }, 20);
  });
  const node = await runOne(process.execPath, [writer]);
  assert.ok(node.endAt && node.endAt.writerAlive, `reference: node must drain while alive; got ${JSON.stringify(node)}`);
  const [cmd, argv] = engineSpawn(['run', LOADER, writer]);
  const shim = await runOne(cmd, argv);
  assert.ok(shim.endAt && shim.endAt.writerAlive,
    `every byte (${(1 << 20) + 4}) should reach the reader while the writer is alive, as under node; got ${JSON.stringify(shim)}`);
  assert.strictEqual(shim.got, node.got);
});
