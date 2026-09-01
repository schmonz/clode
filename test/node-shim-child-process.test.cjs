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
const { runLoader, resolveBin, skipUnlessTjs } = require('./node-shim-helper.cjs');

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

// A KILLED child is not a SUCCESSFUL child. node reports code=null + signal for a
// signal-terminated child, and exitCode=null/signalCode=<sig>; the shim used to
// hand back tjs's raw `exit_status` (0 for a signal kill), so every caller that
// asks the ONE question everyone asks — `code === 0`? — concluded the thing it had
// just killed had succeeded.
//
// This is not academic. It is how a whole day went sideways (2026-07-17): a hung
// attest on haiku-x64 was SIGKILLed by clode's own 20-minute timeout, the shim
// reported exit 0, and clode printed "ATTEST FAILED (exit 0)" — sending the
// investigation after a process that supposedly exited cleanly while printing
// nothing, when the truth was "we killed it". Claude Code's Bash tool kills
// timed-out commands through this same path, so a timed-out command looked
// successful too.
//
// The oracle existed and this case simply was not in it — it only ever tests what
// someone thought to compare.
test('spawn: a SIGKILLed child reports code=null + the signal, like node (not exit 0)', (t) => {
  if (skipUnlessTjs(t)) return;
  const body = `
    const cp = require('node:child_process');
    const c = cp.spawn('/bin/sh', ['-c', 'sleep 30']);
    setTimeout(() => c.kill('SIGKILL'), 300);
    c.on('exit', (code, signal) => {
      console.log(JSON.stringify({ code, signal, exitCode: c.exitCode, signalCode: c.signalCode }));
    });`;
  const f = prog(body);
  const node = JSON.parse(require('node:child_process').execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim());
  // Pin node's own contract too, so a node change is loud rather than silently
  // redefining what the shim must match.
  assert.deepStrictEqual(node, { code: null, signal: 'SIGKILL', exitCode: null, signalCode: 'SIGKILL' });
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), node);
});

// The other half of the same seam: a NORMAL exit must keep reporting its code (and
// a null signal). A fix that mapped every exit to null would pass the test above
// and break everything else.
test('spawn: a normally-exiting child still reports its code + null signal', (t) => {
  if (skipUnlessTjs(t)) return;
  const body = `
    const cp = require('node:child_process');
    const c = cp.spawn('/bin/sh', ['-c', 'exit 3']);
    c.on('exit', (code, signal) => {
      console.log(JSON.stringify({ code, signal, exitCode: c.exitCode, signalCode: c.signalCode }));
    });`;
  const f = prog(body);
  const node = JSON.parse(require('node:child_process').execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim());
  assert.deepStrictEqual(node, { code: 3, signal: null, exitCode: 3, signalCode: null });
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), node);
});

// A FORKED grandchild that outlives a KILLED child and inherits its stdio pipe
// must not keep the runtime alive after the child exits. dash (musl/alpine's
// /bin/sh) runs `sh -c 'sleep 30'` as a CHILD instead of exec-replacing, so
// SIGKILLing the sh left a live orphaned `sleep` holding the pipe; tjs's eager
// stdout drain then blocked on read() with no EOF and the process hung forever
// (the node-shim-oracle SIGKILL hang — musl only, since NetBSD sh exec-replaces,
// leaving no orphan). `sh -c 'sleep 30 & wait'` forces that fork on EVERY platform:
// the sh forks sleep and waits, so SIGKILLing the sh orphans a live sleep on the
// pipe. Node drains + exits (~350ms); the shim must too — a hang surfaces here as
// runLoader's timeout -> status null (verified: fails without the reader-cancel).
test('spawn: a killed child\'s orphaned grandchild on the pipe does not hang the runtime', (t) => {
  if (skipUnlessTjs(t)) return;
  const body = `
    const cp = require('node:child_process');
    const c = cp.spawn('/bin/sh', ['-c', 'sleep 30 & wait']);
    setTimeout(() => c.kill('SIGKILL'), 300);
    c.on('exit', (code, signal) => { console.log(JSON.stringify({ code, signal })); });
    // No process.exit and no stdout consumer: the runtime must still DRAIN + exit.`;
  const f = prog(body);
  // No live-node reference here: with a piped stdout AND a forced-fork orphan, node
  // ITSELF blocks ~30s on some hosts, so it is not a clean timing oracle for this
  // fixture. The value contract (a signal-killed child is code=null + the signal)
  // is already pinned by the SIGKILL test above; this test guards the RUNTIME
  // draining. Without the reader-cancel on child exit, the orphaned sleep holds the
  // pipe, tjs's eager drain never sees EOF, and runLoader times out -> status null.
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, `hung (orphan pipe kept the loop alive)? stderr=${r.stderr}`);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), { code: null, signal: 'SIGKILL' });
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
  // Resolved, not hardcoded: this row said '/usr/bin/printenv', which does not
  // exist on the musl reference container (busybox puts printenv in /bin). It
  // did not fail there — spawnSync reports ENOENT in the RESULT rather than
  // throwing, so both the reference and the shim returned {status:null,out:''}
  // and the differential matched on two identical non-answers. The row was
  // green and vacuous on every alpine run. See resolveBin's comment.
  const printenv = resolveBin('printenv');
  assert.ok(printenv, `no 'printenv' on PATH (${process.env.PATH}) — cannot run the env-passthrough differential`);
  const body = `
    const cp = require('node:child_process');
    const r = cp.spawnSync(${JSON.stringify(printenv)}, ['CLODE_X'], { env: { CLODE_X: 'yes' }, encoding: 'utf8' });
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
  // Resolved, not hardcoded: this row said '/usr/bin/false', which exists on
  // macOS and does NOT exist on the musl reference container (busybox puts
  // false in /bin). There the REFERENCE side died first — cp.spawn's ENOENT
  // arrives as an unhandled 'error' event, so host node exited 1 and
  // execFileSync threw before the shim was ever consulted. Nothing about musl
  // or the shim was involved. See resolveBin's comment.
  const falseBin = resolveBin('false');
  assert.ok(falseBin, `no 'false' on PATH (${process.env.PATH}) — cannot run the nonzero-exit differential`);
  const body = `
    const cp = require('node:child_process');
    const c = cp.spawn(${JSON.stringify(falseBin)}, []);
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

// Numeric-fd stdio redirection (tjs Bash-tool wall): the bundle's Bash tool
// opens a log file via fs.promises.open() and passes the FileHandle's fd as
// child stdio ["pipe", fd, fd] so the subprocess writes stdout/stderr straight
// into the file; it then closes its OWN fd right after spawn, relying on the
// child having inherited its own dup. Under tjs this failed because tjs.spawn
// ignored a numeric fd (child output never reached the file → the tool returned
// empty / errored). Locks the full chain: fs.promises.open -> real fd ->
// spawn inherits the fd -> child writes -> parent reads the file back. Diffed
// against host node (which supports fd stdio natively).
test('spawn: numeric fd in stdio redirects child output to a file (Bash-tool pattern)', (t) => {
  if (skipUnlessTjs(t)) return;
  const body = `
    const cp = require('node:child_process');
    const fs = require('node:fs');
    const path = require('node:path');
    const os = require('node:os');
    (async () => {
      const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cp-fd-')), 'out.txt');
      const fh = await fs.promises.open(log, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND);
      const c = cp.spawn('/bin/echo', ['redirected-to-fd'], { stdio: ['pipe', fh.fd, fh.fd] });
      await fh.close(); // parent drops its fd; child keeps the inherited dup
      c.on('exit', () => {
        // child.stdout must be null (fd redirected, no parent-side pipe)
        console.log(JSON.stringify({ stdoutNull: c.stdout === null, file: fs.readFileSync(log, 'utf8').trim() }));
      });
    })();`;
  const f = prog(body);
  const node = JSON.parse(require('node:child_process').execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim());
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), node);
  assert.strictEqual(node.file, 'redirected-to-fd');
});

// RECIPE G6: node's child_process OMITS an env key whose value is `undefined`
// entirely (verified against host node v26.3.0 by direct differential — see
// g6-env-fix-report.md); it does NOT stringify it. Every other primitive is
// stringified normally, including null ("null"), 0 ("0"), false ("false"),
// and '' (kept as an empty string, key still present). Before the fix, both
// spawn() (object handed to tjs.spawn, native env also stringifies blindly)
// and spawnSync() (`Object.entries(env).map(([k,v]) => \`${k}=${v}\`)`)
// turned an `undefined`-valued key into the literal string "undefined" — the
// G6 repro's `GIT_DIR: undefined` became `GIT_DIR=undefined` in the child,
// and `GIT_DIR=undefined git worktree list --porcelain` fails with
// `fatal: not a git repository: 'undefined'`.
const ENV_TYPES_SNIPPET = (spawnCall) => `
  const cp = require('node:child_process');
  function parseEnvDump(text) {
    const out = {};
    for (const line of text.split('\\n')) {
      if (!line) continue;
      const i = line.indexOf('=');
      if (i < 0) continue;
      out[line.slice(0, i)] = line.slice(i + 1);
    }
    return out;
  }
  const KEYS = ['A_UNDEF', 'B_NULL', 'C_ZERO', 'D_FALSE', 'E_EMPTY', 'KEEP'];
  function summarize(dump) {
    const o = {};
    for (const k of KEYS) {
      o[k + '_present'] = Object.prototype.hasOwnProperty.call(dump, k);
      o[k + '_value'] = dump[k];
    }
    return o;
  }
  const childEnv = {
    PATH: process.env.PATH,
    A_UNDEF: undefined,
    B_NULL: null,
    C_ZERO: 0,
    D_FALSE: false,
    E_EMPTY: '',
    KEEP: 'yes',
  };
  ${spawnCall}
`;

test('spawnSync: env omits undefined-valued keys, stringifies null/0/false/empty (matches node)', (t) => {
  if (skipUnlessTjs(t)) return;
  const body = ENV_TYPES_SNIPPET(`
    const r = cp.spawnSync('/usr/bin/env', [], { env: childEnv, encoding: 'utf8' });
    console.log(JSON.stringify(summarize(parseEnvDump(r.stdout))));`);
  const f = prog(body);
  const node = JSON.parse(require('node:child_process').execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim());
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), node);
});

test('spawn: env omits undefined-valued keys, stringifies null/0/false/empty (matches node)', (t) => {
  if (skipUnlessTjs(t)) return;
  const body = ENV_TYPES_SNIPPET(`
    const c = cp.spawn('/usr/bin/env', [], { env: childEnv });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.on('exit', () => { console.log(JSON.stringify(summarize(parseEnvDump(out)))); });`);
  const f = prog(body);
  const node = JSON.parse(require('node:child_process').execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim());
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), node);
});

// RECIPE G6: a failed spawn with 'pipe' stdio must still hand back REAL,
// already-ended stdout/stderr/stdin streams — never null — exactly as host
// node does (verified against node v24.18.1: c.stdout/stderr fire 'end' then
// 'close', readable=false, destroyed=true; c.stdin fires 'close',
// writable=false, destroyed=true; exitCode/signalCode land at the same
// (-2, null) the 'close' event carries). The shim used to hard-null every
// stdio slot on a launch failure regardless of what stdio was requested, so a
// caller that unconditionally does `child.stdout.on('end', …)` (execa's
// stream collectors do exactly this) got nothing back — a dangling
// listener/promise that never settled and kept the event loop alive after a
// bare, unresolvable command name failed to spawn (the RECIPE G6 hang).
test("spawn launch failure with pipe stdio: stdout/stderr fire 'end'+'close', stdin fires 'close', exitCode/signalCode set (matches node)", (t) => {
  if (skipUnlessTjs(t)) return;
  const body = `
    const cp = require('node:child_process');
    const seq = [];
    const c = cp.spawn('this-binary-does-not-exist-xyz', ['--version'], { stdio: ['pipe', 'pipe', 'pipe'] });
    c.on('error', (e) => seq.push(['error', e.code]));
    c.on('close', (code, sig) => seq.push(['close', code, sig]));
    c.stdout.on('end', () => seq.push(['stdout-end']));
    c.stdout.on('close', () => seq.push(['stdout-close']));
    c.stderr.on('end', () => seq.push(['stderr-end']));
    c.stderr.on('close', () => seq.push(['stderr-close']));
    c.stdin.on('close', () => seq.push(['stdin-close']));
    setTimeout(() => {
      console.log(JSON.stringify({
        seq,
        stdoutReadable: c.stdout.readable, stdoutDestroyed: c.stdout.destroyed,
        stdinWritable: c.stdin.writable, stdinDestroyed: c.stdin.destroyed,
        exitCode: c.exitCode, signalCode: c.signalCode,
      }));
    }, 250);`;
  const f = prog(body);
  const node = JSON.parse(require('node:child_process').execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim());
  // Sanity-anchor the oracle: every event node fires must be present, streams
  // ended/destroyed, exitCode/signalCode carrying the close code.
  assert.deepStrictEqual(node.exitCode, -2);
  assert.deepStrictEqual(node.signalCode, null);
  assert.strictEqual(node.stdoutReadable, false);
  assert.strictEqual(node.stdoutDestroyed, true);
  assert.strictEqual(node.stdinWritable, false);
  assert.strictEqual(node.stdinDestroyed, true);
  const EXPECTED_EVENTS = ['error', 'close', 'stdout-end', 'stdout-close', 'stderr-end', 'stderr-close', 'stdin-close'];
  for (const ev of EXPECTED_EVENTS) {
    assert.ok(node.seq.some((e) => e[0] === ev), `node oracle missing ${ev}`);
  }
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  const shim = JSON.parse(r.stdout.trim());
  // The flags/exitCode/signalCode must match EXACTLY.
  assert.strictEqual(shim.stdoutReadable, node.stdoutReadable);
  assert.strictEqual(shim.stdoutDestroyed, node.stdoutDestroyed);
  assert.strictEqual(shim.stdinWritable, node.stdinWritable);
  assert.strictEqual(shim.stdinDestroyed, node.stdinDestroyed);
  assert.strictEqual(shim.exitCode, node.exitCode);
  assert.strictEqual(shim.signalCode, node.signalCode);
  // The EVENT SET must match exactly — every event node fires, the shim must
  // also fire, and no extras. Exact INTERLEAVING is deliberately not asserted:
  // it is a microtask-scheduling implementation detail (this file's own
  // stream.cjs documents an analogous "load-sensitive" ordering flake), not an
  // observable contract any real caller depends on.
  const eventNames = (s) => s.seq.map((e) => e[0]).sort();
  assert.deepStrictEqual(eventNames(shim), eventNames(node));
  // What IS a real contract: 'error' must precede 'close' on the child, and
  // each stream's 'end' must precede its own 'close' — callers chain cleanup
  // off these orderings.
  const idx = (s, name) => s.seq.findIndex((e) => e[0] === name);
  for (const s of [shim, node]) {
    assert.ok(idx(s, 'error') < idx(s, 'close'), 'error must precede close');
    assert.ok(idx(s, 'stdout-end') < idx(s, 'stdout-close'), 'stdout end must precede stdout close');
    assert.ok(idx(s, 'stderr-end') < idx(s, 'stderr-close'), 'stderr end must precede stderr close');
  }
});

// 'ignore' stdio: node leaves stdout/stderr/stdin null on a launch failure
// (no pipe was ever requested) — matches the shim's pre-existing behavior,
// locked here so the pipe-stdio fix above doesn't regress it.
test('spawn launch failure with ignore stdio: stdout/stderr/stdin stay null (matches node)', (t) => {
  if (skipUnlessTjs(t)) return;
  const body = `
    const cp = require('node:child_process');
    const c = cp.spawn('this-binary-does-not-exist-xyz', ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
    c.on('error', () => {});
    c.on('close', (code, sig) => {
      console.log(JSON.stringify({
        stdout: c.stdout, stderr: c.stderr, stdin: c.stdin,
        exitCode: c.exitCode, signalCode: c.signalCode,
      }));
    });`;
  const f = prog(body);
  const node = JSON.parse(require('node:child_process').execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim());
  assert.deepStrictEqual(node, { stdout: null, stderr: null, stdin: null, exitCode: -2, signalCode: null });
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), node);
});

// The actual RECIPE G6 regression: a program that spawns a bare,
// unresolvable command with pipe stdio, listens only for 'close' (the
// execa-style idiom), and never calls process.exit() must still DRAIN and
// exit — the dangling stdout/stderr/stdin streams from the failed launch must
// not keep the event loop alive. Before the fix this hung until runLoader's
// timeout (spawnSync's status/signal come back null on a timeout kill, never
// 0); after the fix the process drains promptly with exit code 0.
test('spawn launch failure: process DRAINS without process.exit (no dangling handle keeps the loop alive)', (t) => {
  if (skipUnlessTjs(t)) return;
  const body = `
    const cp = require('node:child_process');
    const c = cp.spawn('this-binary-does-not-exist-xyz', ['--version'], { stdio: ['pipe', 'pipe', 'pipe'] });
    c.on('error', () => {});
    c.stdout.on('data', () => {});
    c.stderr.on('data', () => {});
    c.on('close', () => { console.log('drained'); });`;
  const f = prog(body);
  const r = runLoader(f, [], { timeout: 8000 });
  assert.strictEqual(r.status, 0, `expected a clean drain, got status=${r.status} stderr=${r.stderr}`);
  assert.strictEqual(r.stdout.trim(), 'drained');
});

// RECIPE G6 root cause (a real, separately-verified leak — see
// child_process.cjs's wait().then handler comment): a child spawned with
// stdio:'pipe' whose caller never writes to / ends its stdin (the common
// shape for the bundle's git/sh context-gathering spawns, which have nothing
// to send) left the PARENT's end of that pipe's native handle open forever
// after the child exited — nothing in this file ever called the underlying
// stream's close()/abort() algorithm unless the caller did. Verified via the
// engine's own __tjs_dump_handles() introspection (not a hang-based test:
// a handful of such leaked handles do not, by themselves, block the tjs
// event loop from draining — confirmed empirically with up to 22 concurrent/
// sequential unclosed-stdin spawns exiting cleanly — but they are a real,
// unbounded-with-spawn-count resource leak matching what a live-process
// `lsof`/handle-dump diff on the actual G6 repro showed: ~15+ leaked
// `pipe ... ref=1 active=0` handles, one per 'pipe'-stdin spawn whose stdin
// went untouched).
test('spawn: an untouched pipe stdin does not leak its native handle after the child exits', (t) => {
  if (skipUnlessTjs(t)) return;
  const body = `
    const cp = require('node:child_process');
    function countPipes(dump) { return (dump.match(/^pipe /gm) || []).length; }
    async function spawnOne(i) {
      return new Promise((resolve) => {
        const c = cp.spawn('/bin/echo', ['hi', String(i)], { stdio: ['pipe', 'pipe', 'pipe'] });
        c.stdout.on('data', () => {});
        c.stderr.on('data', () => {});
        c.on('close', () => resolve());
        // deliberately never touch c.stdin, matching the bundle's git/sh spawns
      });
    }
    (async () => {
      const before = countPipes(globalThis.__tjs_dump_handles());
      for (let i = 0; i < 16; i++) { await spawnOne(i); }
      await new Promise((r) => setTimeout(r, 200));
      const after = countPipes(globalThis.__tjs_dump_handles());
      console.log(JSON.stringify({ before, after }));
    })();`;
  const f = prog(body);
  const r = runLoader(f, [], { timeout: 15000 });
  assert.strictEqual(r.status, 0, r.stderr);
  const { before, after } = JSON.parse(r.stdout.trim());
  assert.strictEqual(before, 0, 'unexpected pre-existing pipe handles');
  assert.strictEqual(after, 0, `expected no leaked pipe handles, found ${after}`);
});

// A caller that DOES write to and properly end() child.stdin must be
// completely unaffected by the child-exit cleanup (no double-close error, no
// missing 'finish'/'close' events) — the cleanup must be a no-op once the
// caller has already ended stdin itself.
test('spawn: an explicitly-ended pipe stdin still fires finish/close normally (cleanup is a no-op)', (t) => {
  if (skipUnlessTjs(t)) return;
  const body = `
    const cp = require('node:child_process');
    const c = cp.spawn('/bin/cat', [], { stdio: ['pipe', 'pipe', 'pipe'] });
    const seq = [];
    c.stdin.on('finish', () => seq.push('finish'));
    c.stdin.on('close', () => seq.push('close'));
    c.stdin.write('hello');
    c.stdin.end();
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.on('close', () => {
      setTimeout(() => console.log(JSON.stringify({ seq, out })), 200);
    });`;
  const f = prog(body);
  const r = runLoader(f, [], { timeout: 10000 });
  assert.strictEqual(r.status, 0, r.stderr);
  const { seq, out } = JSON.parse(r.stdout.trim());
  assert.deepStrictEqual(seq, ['finish', 'close']);
  assert.strictEqual(out, 'hello');
});

// BUG (found while root-causing RECIPE G6): cp.execFile('security',
// ['find-generic-password', ...]) came back with an EMPTY stderr under the
// shim while host node's real `security` call reports real diagnostic text
// (e.g. "security: SecKeychainSearchCopyNext: The specified item could not
// be found in the keychain.\n", 92 bytes). The exit code (44,
// errSecItemNotFound) propagated correctly — only the stderr CONTENT was
// lost. This matters because the bundle's keychain code inspects a failed
// `security` call's stderr for diagnostics (see e.g. the `security -i`
// write-probe path in cli.cjs, which builds a user-facing error message from
// `(result.stderr||result.stdout||'').trim()`); a silently-empty stderr
// turns a diagnosable failure into a mystery.
//
// ROOT CAUSE: this is NOT a generic spawn/stream-draining bug — a plain
// `/bin/sh -c 'echo err 1>&2; exit N'` round-tripped through spawn/execFile/
// exec/execSync/execFileSync correctly in isolation (verified). The loss is
// scoped entirely to this file's own quaude "headless-macOS keychain
// emulation" feature (`_kcHandleFile`/`_kcFakeChild`/`_kcSyncResult` above):
// when the real keychain is unreachable (headless/locked — the exact RECIPE
// G6 scenario), EVERY `security find-generic-password`/`add-generic-
// password`/`delete-generic-password`/`show-keychain-info` call is answered
// entirely in JS by `_kcHandleFile`, whose emulated response never carried a
// stderr string at all — `_kcFakeChild`/`_kcSyncResult` always built an
// EMPTY stderr stream/buffer, regardless of what real `security` would have
// said. Since spawn/spawnSync/exec/execFile/execSync/execFileSync all route
// through the SAME `_kcMaybe()` interception (see spawn()/spawnSync() above),
// every one of them shared the loss — confirmed below.
//
// These tests force 'emulate' mode DETERMINISTICALLY (independent of whether
// this actual host's login keychain happens to be reachable) by giving the
// child a PATH with no `security` binary on it: `_kcDetect()`'s own probe
// calls (`_kcRealSec` -> `spawnSync('security', ...)`) then ENOENT, so
// `_kcProbe()` returns 'emulate' regardless of the real host's keychain
// state — verified this reliably reproduces the bug (and reliably no longer
// does, once fixed) independent of whether the box running the test has an
// interactive login session.
const KC_DECOY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-kc-decoy-'));
const KC_HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-kc-home-'));
fs.mkdirSync(path.join(KC_HOME_DIR, '.claude'), { recursive: true }); // _kcSave()/_credWrite() need the dir to pre-exist
const KC_FORCE_EMULATE_ENV = { PATH: KC_DECOY_DIR, HOME: KC_HOME_DIR };

// The ground-truth message: what THIS host's real `security` binary actually
// says for an item-not-found lookup — captured live (not hardcoded), so a
// version-to-version wording change on the real tool is loud, not silently
// stale.
//
// EXPLICIT OPT-IN (task-10 fix round 1): this calls the REAL `security` binary
// through the test host's OWN unshimmed child_process — unconditionally on any
// darwin run, previously gated only on platform + "did the call answer". That
// is read-only against a nonexistent account (`nobody-xyz`) and macOS's
// "could not find a keychain to store" alert is specific to the WRITE path
// (`_kcDetect()`'s add-generic-password probe, gated by CLODE_KC_MODE
// elsewhere), so this call itself was never expected to produce a dialog — but
// "probably silent" is a prediction about someone else's machine, which is
// exactly the kind of claim this task exists to stop making and start gating
// instead. Same explicit-opt-in shape as CLODE_LIVE_RENDER (test/quaude-build
// .test.cjs, test/e2e-doctor-parity.test.cjs, etc.) for the live-render TUI
// tests that also touch the real Keychain: unset by default, LOUD skip naming
// the variable when absent, never a silent pass. The oracle itself is
// untouched — still available to anyone who opts in.
const CLODE_LIVE_KC_ORACLE = process.env.CLODE_LIVE_KC_ORACLE === '1';
function realSecurityNotFoundStderr() {
  try {
    require('node:child_process').execFileSync(
      'security', ['find-generic-password', '-a', 'nobody-xyz', '-w', '-s', 'no-such-service-xyz'],
      { encoding: 'utf8' });
    return null; // unexpectedly succeeded — no oracle to diff against
  } catch (e) {
    return typeof e.stderr === 'string' && e.stderr.length ? e.stderr : null;
  }
}

function skipUnlessRealSecurity(t) {
  if (skipUnlessTjs(t)) return true;
  if (!CLODE_LIVE_KC_ORACLE) { t.skip('live real-security(1) oracle opt-in only (set CLODE_LIVE_KC_ORACLE=1)'); return true; }
  if (process.platform !== 'darwin') { t.skip('security(1) is darwin-only'); return true; }
  if (!realSecurityNotFoundStderr()) { t.skip('no real security(1) oracle on this host'); return true; }
  return false;
}

test('execFile: keychain-emulation "not found" carries real stderr text (not empty)', (t) => {
  if (skipUnlessRealSecurity(t)) return;
  const oracle = realSecurityNotFoundStderr();
  const body = `
    const cp = require('node:child_process');
    cp.execFile('security', ['find-generic-password','-a','nobody-xyz','-w','-s','no-such-service-xyz'], { encoding: 'utf8' }, (err, stdout, stderr) => {
      console.log(JSON.stringify({ code: err && err.code, stdout, stderr }));
    });`;
  const f = prog(body);
  const r = runLoader(f, [], { env: KC_FORCE_EMULATE_ENV });
  assert.strictEqual(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout.trim());
  assert.strictEqual(got.code, 44);
  assert.strictEqual(got.stdout, '');
  assert.strictEqual(got.stderr, oracle, 'stderr must match what real security(1) says for this failure');
});

test('exec (shell form): keychain-emulation "not found" carries real stderr text', (t) => {
  if (skipUnlessRealSecurity(t)) return;
  const oracle = realSecurityNotFoundStderr();
  const body = `
    const cp = require('node:child_process');
    cp.exec('security find-generic-password -a nobody-xyz -w -s no-such-service-xyz', { encoding: 'utf8' }, (err, stdout, stderr) => {
      console.log(JSON.stringify({ code: err && err.code, stdout, stderr }));
    });`;
  const f = prog(body);
  const r = runLoader(f, [], { env: KC_FORCE_EMULATE_ENV });
  assert.strictEqual(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout.trim());
  assert.strictEqual(got.code, 44);
  assert.strictEqual(got.stderr, oracle);
});

test('execSync: keychain-emulation "not found" throws with real stderr text', (t) => {
  if (skipUnlessRealSecurity(t)) return;
  const oracle = realSecurityNotFoundStderr();
  const body = `
    const cp = require('node:child_process');
    try {
      cp.execSync('security find-generic-password -a nobody-xyz -w -s no-such-service-xyz', { encoding: 'utf8' });
      console.log(JSON.stringify({ threw: false }));
    } catch (e) {
      console.log(JSON.stringify({ threw: true, status: e.status, stderr: e.stderr }));
    }`;
  const f = prog(body);
  const r = runLoader(f, [], { env: KC_FORCE_EMULATE_ENV });
  assert.strictEqual(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout.trim());
  assert.deepStrictEqual(got, { threw: true, status: 44, stderr: oracle });
});

test('execFileSync: keychain-emulation "not found" throws with real stderr text', (t) => {
  if (skipUnlessRealSecurity(t)) return;
  const oracle = realSecurityNotFoundStderr();
  const body = `
    const cp = require('node:child_process');
    try {
      cp.execFileSync('security', ['find-generic-password','-a','nobody-xyz','-w','-s','no-such-service-xyz'], { encoding: 'utf8' });
      console.log(JSON.stringify({ threw: false }));
    } catch (e) {
      console.log(JSON.stringify({ threw: true, status: e.status, stderr: e.stderr }));
    }`;
  const f = prog(body);
  const r = runLoader(f, [], { env: KC_FORCE_EMULATE_ENV });
  assert.strictEqual(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout.trim());
  assert.deepStrictEqual(got, { threw: true, status: 44, stderr: oracle });
});

test('spawnSync: keychain-emulation "not found" carries real stderr text', (t) => {
  if (skipUnlessRealSecurity(t)) return;
  const oracle = realSecurityNotFoundStderr();
  const body = `
    const cp = require('node:child_process');
    const r = cp.spawnSync('security', ['find-generic-password','-a','nobody-xyz','-w','-s','no-such-service-xyz'], { encoding: 'utf8' });
    console.log(JSON.stringify({ status: r.status, stdout: r.stdout, stderr: r.stderr }));`;
  const f = prog(body);
  const r = runLoader(f, [], { env: KC_FORCE_EMULATE_ENV });
  assert.strictEqual(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout.trim());
  assert.strictEqual(got.status, 44);
  assert.strictEqual(got.stdout, '');
  assert.strictEqual(got.stderr, oracle);
});

// A SUCCESSFUL emulated call (add/find/delete on a service the emulation DB
// actually has) never had real `security` stderr to lose in the first
// place — real `security` prints nothing on success either. Pin that the
// fix does not fabricate stderr noise on the happy path.
test('execFileSync: keychain-emulation success (add + find) has empty stderr, like a real success', (t) => {
  if (skipUnlessRealSecurity(t)) return;
  const body = `
    const cp = require('node:child_process');
    cp.execFileSync('security', ['add-generic-password','-a','clode-test-acct','-s','clode-test-svc-xyz','-w','clode-test-pw'], { encoding: 'utf8' });
    const out = cp.execFileSync('security', ['find-generic-password','-a','clode-test-acct','-w','-s','clode-test-svc-xyz'], { encoding: 'utf8' });
    console.log(JSON.stringify({ out: out.trim() }));`;
  const f = prog(body);
  const r = runLoader(f, [], { env: KC_FORCE_EMULATE_ENV });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), { out: 'clode-test-pw' });
});
