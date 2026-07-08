'use strict';
// child_process characterization: the shim's spawn/spawnSync/execFile family
// must match host node's observable results for the same fixtures. Locks the
// surface bun-shim patches and the bundle's -p path may call. SKIPs without tjs.
//
// spawnSync/execFileSync: real, over the C primitive __tjs_spawn_sync
// (DIVERGENCE B in child_process.cjs's header is now RESOLVED on
// darwin/linux). The sync rows below run each fixture under BOTH host node
// and tjs and diff the observable result, same as the async rows.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

function prog(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-cp-'));
  const f = path.join(dir, 'p.cjs');
  fs.writeFileSync(f, body);
  return f;
}

test('spawnSync: status + stdout + stderr match node', (t) => {
  if (skipUnlessTjs(t)) return;
  const body = `
    const cp = require('node:child_process');
    const r = cp.spawnSync('/bin/sh', ['-c', 'echo out; echo err 1>&2; exit 7'], { encoding: 'utf8' });
    console.log(JSON.stringify({ status: r.status, out: r.stdout, err: r.stderr }));`;
  const f = prog(body);
  const node = JSON.parse(require('node:child_process').execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim());
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), node);
});

test('spawn: writing a command to a persistent shell via child.stdin delivers + EOF closes it (Bash-tool pattern)', (t) => {
  if (skipUnlessTjs(t)) return;
  // Claude Code's Bash tool feeds short commands to a persistent shell via stdin.
  // A tjs C bug (mod_streams.c: sync-complete writes returned JS_TRUE where the JS
  // sink expects a byte-count number → awaited an onwrite that never fires) hung
  // every such write. This spawns a real shell, writes a command, ends stdin, and
  // asserts the command ran and the process closed — i.e. delivery + EOF work.
  const body = `
    const cp = require('node:child_process');
    const c = cp.spawn('/bin/sh', []);
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.on('close', (code) => console.log(JSON.stringify({ code, out: out.trim() })));
    c.stdin.write('echo STDIN-DELIVERED\\n');
    c.stdin.end();`;
  const f = prog(body);
  const r = runLoader(f); // runLoader has a timeout; a hang here fails the test
  assert.strictEqual(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout.trim());
  assert.strictEqual(got.code, 0, 'shell exited cleanly (got EOF)');
  assert.strictEqual(got.out, 'STDIN-DELIVERED', 'the command reached the shell and ran');
});

test('spawn: child.stdin is a Node Writable (on/write/end callable) — the hook-runner pattern', (t) => {
  if (skipUnlessTjs(t)) return;
  // The bundle's hook runner does exactly this to a spawned child's stdin:
  //   stdin.on('error', …); stdin.write(json + '\n', 'utf8'); stdin.end()
  // A raw WHATWG-writable passthrough has none of those methods, so stdin.write
  // was undefined → "not a function" (the interactive SessionStart hook crash).
  const body = `
    const cp = require('node:child_process');
    const c = cp.spawn('/bin/echo', ['ok']);
    const types = { on: typeof c.stdin.on, once: typeof c.stdin.once, write: typeof c.stdin.write, end: typeof c.stdin.end };
    let threw = null;
    try { c.stdin.on('error', () => {}); c.stdin.write('hi\\n', 'utf8'); c.stdin.end(); }
    catch (e) { threw = e.message; }
    c.on('close', () => console.log(JSON.stringify({ types, threw, notNull: c.stdin != null })));`;
  const f = prog(body);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout.trim());
  assert.deepStrictEqual(got.types, { on: 'function', once: 'function', write: 'function', end: 'function' });
  assert.strictEqual(got.threw, null, 'the hook-runner stdin pattern must not throw');
  assert.strictEqual(got.notNull, true);
});

test('spawnSync: stdin input echoes like node (cat)', (t) => {
  if (skipUnlessTjs(t)) return;
  const body = `
    const cp = require('node:child_process');
    const r = cp.spawnSync('/bin/cat', [], { input: 'PING123', encoding: 'utf8' });
    console.log(JSON.stringify({ status: r.status, out: r.stdout }));`;
  const f = prog(body);
  const node = JSON.parse(require('node:child_process').execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim());
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), node);
});

test('spawnSync: env passthrough matches node (printenv)', (t) => {
  if (skipUnlessTjs(t)) return;
  const body = `
    const cp = require('node:child_process');
    const r = cp.spawnSync('/usr/bin/printenv', ['CLODE_X'], { env: { CLODE_X: 'yes' }, encoding: 'utf8' });
    console.log(JSON.stringify({ status: r.status, out: (r.stdout||'').trim() }));`;
  const f = prog(body);
  const node = JSON.parse(require('node:child_process').execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim());
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), node);
});

test('spawnSync: cwd matches node (pwd)', (t) => {
  if (skipUnlessTjs(t)) return;
  const body = `
    const cp = require('node:child_process');
    const os = require('node:os');
    const r = cp.spawnSync('/bin/pwd', [], { cwd: os.tmpdir(), encoding: 'utf8' });
    // normalize the macOS /private symlink both sides for a stable compare
    console.log(JSON.stringify({ status: r.status, endsWithTmp: /tmp\\/?$/.test((r.stdout||'').trim()) }));`;
  const f = prog(body);
  const node = JSON.parse(require('node:child_process').execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim());
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), node);
});

test('execFileSync: returns stdout string like node', (t) => {
  if (skipUnlessTjs(t)) return;
  const body = `
    const cp = require('node:child_process');
    console.log(cp.execFileSync('/bin/echo', ['xyz'], { encoding: 'utf8' }).trim());`;
  const f = prog(body);
  // Diff against the host-node oracle like the sibling rows, not a hardcoded literal.
  const node = require('node:child_process').execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim();
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), node);
});

test('execFileSync: nonzero exit throws with status like node', (t) => {
  if (skipUnlessTjs(t)) return;
  const body = `
    const cp = require('node:child_process');
    try { cp.execFileSync('/bin/sh', ['-c', 'exit 5']); console.log('NO_THROW'); }
    catch (e) { console.log(JSON.stringify({ status: e.status })); }`;
  const f = prog(body);
  const node = require('node:child_process').execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim();
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), node);
});

test('spawnSync: ENOENT result shape matches node (full object, not just status)', (t) => {
  if (skipUnlessTjs(t)) return;
  // Node returns the launch failure as a RESULT (never throws): pid 0,
  // status/signal null, stdout/stderr undefined (dropped by JSON), output null,
  // error.code ENOENT. Diff the whole node-visible shape against the oracle.
  const body = `
    const cp = require('node:child_process');
    const r = cp.spawnSync('/no/such/binary_xyz', [], {});
    console.log(JSON.stringify({
      pid: r.pid, status: r.status, signal: r.signal,
      stdout: r.stdout, stderr: r.stderr, output: r.output,
      code: r.error && r.error.code,
    }));`;
  const f = prog(body);
  const node = JSON.parse(require('node:child_process').execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim());
  // Anchor the oracle so a node behavior change is loud, not silently absorbed.
  assert.deepStrictEqual(node, { pid: 0, status: null, signal: null, output: null, code: 'ENOENT' });
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), node);
});

test('spawnSync: timeout kills and reports like node (signal is a NAME, not a number)', (t) => {
  if (skipUnlessTjs(t)) return;
  const body = `
    const cp = require('node:child_process');
    const r = cp.spawnSync('/bin/sleep', ['5'], { timeout: 300 });
    console.log(JSON.stringify({
      statusNull: r.status === null,
      signal: r.signal,                 // must be a STRING name, never a raw int
      signalType: typeof r.signal,
      code: r.error && r.error.code,
    }));`;
  const f = prog(body);
  const node = JSON.parse(require('node:child_process').execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim());
  // Oracle anchor: node reports status null, signal STRING "SIGTERM", ETIMEDOUT.
  assert.strictEqual(node.statusNull, true);
  assert.strictEqual(node.signalType, 'string');
  assert.strictEqual(node.signal, 'SIGTERM');
  assert.strictEqual(node.code, 'ETIMEDOUT');
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  // Shape that MUST match node: status null on timeout, error code ETIMEDOUT,
  // and — the CRITICAL fix — signal reported as a STRING NAME, not the OS int.
  assert.strictEqual(out.statusNull, node.statusNull);
  assert.strictEqual(out.signalType, 'string', `signal must be a name string, got ${JSON.stringify(out.signal)} (${out.signalType})`);
  assert.strictEqual(out.code, node.code);
  // DIVERGENCE (characterized, not diffed): the C primitive always SIGKILLs on
  // timeout, so the shim reports "SIGKILL" where node's timeout default is
  // "SIGTERM" (see mod_spawn_sync.c / child_process.cjs spawnSync comment). We
  // assert the shim's actual value so the divergence is pinned, and confirm it
  // genuinely differs from node's here.
  assert.strictEqual(out.signal, 'SIGKILL');
  assert.notStrictEqual(out.signal, node.signal);
});

// DIVERGENCE characterization (tjs-only — deliberately NOT diffed against node,
// the two differ BY DESIGN). The C primitive conflates a maxBuffer overrun with
// a timeout: both trip the same `timedOut` flag and SIGKILL the child. So the
// shim surfaces an over-maxBuffer child via the SAME ETIMEDOUT-shaped error it
// uses for a real timeout — NOT node's RangeError ERR_CHILD_PROCESS_STDIO_MAXBUFFER.
// This row pins that documented behavior so a future change to the conflation is loud.
test('spawnSync: maxBuffer overrun surfaces as the timeout error (tjs DIVERGENCE, not node RangeError)', (t) => {
  if (skipUnlessTjs(t)) return;
  const body = `
    const cp = require('node:child_process');
    // Emit 10 bytes with a 4-byte cap -> overrun. In node this would be a
    // RangeError (ERR_CHILD_PROCESS_STDIO_MAXBUFFER); under the shim it comes
    // back as the conflated timeout error with code ETIMEDOUT.
    const r = cp.spawnSync('/bin/sh', ['-c', 'printf HELLOWORLD'], { maxBuffer: 4 });
    console.log(JSON.stringify({
      hasError: !!r.error,
      code: r.error && r.error.code,
      statusNull: r.status === null,
    }));`;
  const f = prog(body);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  assert.strictEqual(out.hasError, true, 'overrun must set r.error under the shim');
  assert.strictEqual(out.code, 'ETIMEDOUT', 'overrun is surfaced via the conflated timeout error');
  assert.strictEqual(out.statusNull, true, 'a killed (overrun) child reports status null');
});

test('spawn: exit event + piped stdout resolve like node', (t) => {
  if (skipUnlessTjs(t)) return;
  const body = `
    const cp = require('node:child_process');
    const c = cp.spawn('/bin/echo', ['streamed']);
    let out = '';
    c.stdout.on('data', (d) => { out += d.toString(); });
    c.on('exit', (code) => { console.log(JSON.stringify({ code, out: out.trim() })); });`;
  const f = prog(body);
  const node = JSON.parse(require('node:child_process').execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim());
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), node);
});

test('spawn: nonzero exit code matches node', (t) => {
  if (skipUnlessTjs(t)) return;
  const body = `
    const cp = require('node:child_process');
    const c = cp.spawn('/usr/bin/false', []);
    c.on('exit', (code) => { console.log(JSON.stringify({ code })); });`;
  const f = prog(body);
  const node = JSON.parse(require('node:child_process').execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim());
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), node);
});

test('spawn: ENOENT surfaces as an async error event, never a sync throw', (t) => {
  if (skipUnlessTjs(t)) return;
  const body = `
    const cp = require('node:child_process');
    let threw = false;
    try {
      const c = cp.spawn('/no/such/binary-xyz', []);
      c.on('error', (e) => { console.log(JSON.stringify({ threw, code: e.code })); });
      c.on('exit', () => { console.log(JSON.stringify({ threw, unexpectedExit: true })); });
    } catch (e) { threw = true; console.log(JSON.stringify({ threw, code: e.code })); }`;
  const f = prog(body);
  const node = JSON.parse(require('node:child_process').execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim());
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), node);
});

// Host-node parity for the FULL launch-failure lifecycle: on a spawn ENOENT
// node fires BOTH 'error' AND 'close' (order: error then close), 'close' with
// (code,signal)=(-2,null), and does NOT fire 'exit'. A caller using the
// 'close'-listener idiom must not hang. The fixture records the ordered event
// sequence and ends with a bounded self-timer that prints whatever fired — so
// if 'close' never came (a hang under the shim), the sequence would differ
// from node's and the deepStrictEqual would fail rather than the test timing
// out silently.
test("spawn launch failure: fires 'error' THEN 'close' (no 'exit'), args match node", (t) => {
  if (skipUnlessTjs(t)) return;
  const body = `
    const cp = require('node:child_process');
    const seq = [];
    const c = cp.spawn('/no/such/binary-xyz', []);
    c.on('error', (e) => { seq.push(['error', e.code]); });
    c.on('exit', (code, sig) => { seq.push(['exit', code, sig]); });
    c.on('close', (code, sig) => { seq.push(['close', code, sig]); });
    setTimeout(() => { console.log(JSON.stringify(seq)); }, 250);`;
  const f = prog(body);
  const node = JSON.parse(require('node:child_process').execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim());
  // Sanity-anchor the oracle: node must show error then close(-2,null), no exit.
  assert.deepStrictEqual(node, [['error', 'ENOENT'], ['close', -2, null]]);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), node);
});

test('execFile (async, callback): stdout + exit code match node', (t) => {
  if (skipUnlessTjs(t)) return;
  const body = `
    const cp = require('node:child_process');
    cp.execFile('/bin/echo', ['xyz'], { encoding: 'utf8' }, (err, stdout, stderr) => {
      console.log(JSON.stringify({ err: err ? err.code || err.message : null, stdout: stdout.trim(), stderr }));
    });`;
  const f = prog(body);
  const node = JSON.parse(require('node:child_process').execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim());
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), node);
});

test('exec (async, shell): stdout matches node', (t) => {
  if (skipUnlessTjs(t)) return;
  const body = `
    const cp = require('node:child_process');
    cp.exec('echo shelled', { encoding: 'utf8' }, (err, stdout, stderr) => {
      console.log(JSON.stringify({ err: err ? err.code || err.message : null, stdout: stdout.trim(), stderr }));
    });`;
  const f = prog(body);
  const node = JSON.parse(require('node:child_process').execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim());
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), node);
});

// Wall (Task 4, -p round-trip): the bundle spawns single command STRINGS with
// { shell: true } — `ps aux | grep …` (a pipeline) for IDE detection and the
// session-start hook. Without shell support the shim ENOENTs on a literal
// "ps ... | grep ..." path. With shell:true it must route through /bin/sh -c and
// produce node's observable stdout/exit.
test('spawn: shell:true runs a pipeline command string like node', (t) => {
  if (skipUnlessTjs(t)) return;
  const body = `
    const cp = require('node:child_process');
    const c = cp.spawn('echo piped | cat', { shell: true });
    let out = '';
    c.stdout.on('data', (d) => { out += d.toString(); });
    c.on('exit', (code) => { console.log(JSON.stringify({ code, out: out.trim() })); });`;
  const f = prog(body);
  const node = JSON.parse(require('node:child_process').execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim());
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), node);
});

// Wall (Task 4): execa-style cleanup calls child.stdout.destroy() on the error
// path; the child stream wrappers must expose destroy() (emits 'close') so that
// cleanup doesn't throw `TypeError: not a function`.
test('spawn: child.stdout.destroy() is a function and emits close', (t) => {
  if (skipUnlessTjs(t)) return;
  const body = `
    const cp = require('node:child_process');
    const c = cp.spawn('/bin/echo', ['x']);
    const typ = typeof c.stdout.destroy;
    c.stdout.on('close', () => console.log(JSON.stringify({ typ, closed: true })));
    c.on('exit', () => c.stdout.destroy());`;
  const f = prog(body);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), { typ: 'function', closed: true });
});

// Task 4b wall (the tjs-subscription-boot fix): execa/get-stream's collector
// (the staged bundle's `aLt`, confirmed by grepping the extracted cli.cjs)
// requires child.stdout to support pipe(), [Symbol.asyncIterator](), AND
// on('data') without dropping chunks — a bare EventEmitter (the old
// wrapReadable) had only on('data')/'end', so execa silently collected
// NOTHING from a spawned `security` read and the bundle read back "Not
// logged in" even on a real subscription. These three rows characterize all
// three consumption methods the shim's async child.stdout/stderr must now
// support, each diffed against the host-node oracle for the same fixture.
test('spawn: child.stdout.pipe(writable) collects data like node (execa/get-stream style)', (t) => {
  if (skipUnlessTjs(t)) return;
  const body = `
    const cp = require('node:child_process');
    const { Writable } = require('node:stream');
    const c = cp.spawn('/bin/echo', ['piped-data']);
    let out = '';
    const w = new Writable({ write(chunk, enc, cb) { out += chunk.toString(); cb(); } });
    w.on('finish', () => console.log(JSON.stringify({ out: out.trim() })));
    c.stdout.pipe(w);
    c.on('exit', () => c.stdout.on('end', () => w.end()));`;
  const f = prog(body);
  const node = JSON.parse(require('node:child_process').execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim());
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), node);
  assert.strictEqual(node.out, 'piped-data');
});

test('spawn: for await (const c of child.stdout) collects data like node (execa/get-stream style)', (t) => {
  if (skipUnlessTjs(t)) return;
  const body = `
    const cp = require('node:child_process');
    (async () => {
      const c = cp.spawn('/bin/echo', ['iterated-data']);
      let out = '';
      for await (const chunk of c.stdout) out += chunk.toString();
      console.log(JSON.stringify({ out: out.trim() }));
    })();`;
  const f = prog(body);
  const node = JSON.parse(require('node:child_process').execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim());
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), node);
  assert.strictEqual(node.out, 'iterated-data');
});

// Buffer-until-consumed: the consumer attaches its 'data' listener a
// MICROTASK after spawn() returns, not synchronously. A real child's stdout
// arrives via genuine async I/O (well beyond a microtask), so a late-attached
// listener must not miss it — the old wrapReadable emitted 'data' eagerly to
// whoever happened to be listening at read time, no buffering; this pins that
// the shim does not drop a chunk race like that.
test('spawn: child.stdout data is not dropped when the consumer attaches a tick late', (t) => {
  if (skipUnlessTjs(t)) return;
  const body = `
    const cp = require('node:child_process');
    const c = cp.spawn('/bin/echo', ['late-attach']);
    queueMicrotask(() => {
      let out = '';
      c.stdout.on('data', (d) => { out += d.toString(); });
      c.on('exit', () => console.log(JSON.stringify({ out: out.trim() })));
    });`;
  const f = prog(body);
  const node = JSON.parse(require('node:child_process').execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim());
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), node);
  assert.strictEqual(node.out, 'late-attach');
});

test('bun-shim-style feature detection now patches (real functions, not {})', (t) => {
  if (skipUnlessTjs(t)) return;
  const body = `
    const cp = require('node:child_process');
    const patched = [];
    for (const m of ['execFile','execFileSync','spawn','spawnSync','exec','execSync']) {
      const orig = cp[m];
      if (typeof orig !== 'function') continue;
      patched.push(m);
    }
    console.log(JSON.stringify(patched.sort()));`;
  const f = prog(body);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()),
    ['exec', 'execFile', 'execFileSync', 'execSync', 'spawn', 'spawnSync']);
});
