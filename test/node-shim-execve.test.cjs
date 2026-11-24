'use strict';
// process.execve and spawnSync stdio:'inherit', as node and Bun have them.
//
// THE BUG (measured on NetBSD/arm64, 2026-11-22): `/tui classic` left the terminal dead. 2.1.330 relaunches itself
// (execReplaceProcess) with `process.execve(cmd, argv, env)` and, when that throws, falls back to
// `spawnSync(cmd, args, {stdio:'inherit'})` + process.exit. node-shim had no process.execve, so the fallback ran,
// and the engine's spawner piped EVERY slot whatever stdio said, replaying the bytes only after exit: the
// relaunched child (fd0 /dev/null, fd1/fd2 pipes) rendered its TUI into a pipe while the parent sat in poll().
//
// The oracle for both halves is host node where node can answer, and Bun (the native the bundle targets) where it
// is the better witness: under a pty a perl probe exec'd from Bun 1.4.4 reports fds 0-2 BLOCKING, no fd above 2
// open, an empty signal mask; node 24/26 hand the same except an O_NONBLOCK leaked on a raw-mode stdin, which the
// engine clears (scripts: libexec/node-shim/modules/process.cjs execve, txiki-sync-spawn.patch js_execve).
//
// THE PTY ROWS LIVE IN test/node-shim-tty-execve.test.cjs (the child owning the terminal, the perl probe of the
// replaced image, the relaunch end to end). They need the node-pty harness, which the node-shim oracle jobs'
// glob does not have on linux (CI 45224603603: "Cannot find module 'node-pty'"), so they sit with node-shim-tty, out
// of that glob, and run where test/ci-gates.cjs places them. Everything here runs on pipes alone.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runLoader, skipUnlessTjs, engineSpawn, LOADER, REPO } = require('./node-shim-helper.cjs');

const POSIX = process.platform !== 'win32';

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'shim-execve-')); }
function prog(dir, name, body) { const f = path.join(dir, name); fs.writeFileSync(f, body); return f; }
const lastJson = (out) => JSON.parse(String(out).trim().split('\n').filter((l) => /^[[{]/.test(l)).pop());

// The child reports the identity of its fds 0-2 (dev:ino); with 'inherit' they are the PARENT's own.
const FD_IDENTITY = `const fs=require('fs');const id=(fd)=>{try{const s=fs.fstatSync(fd);return s.dev+':'+s.ino}catch(e){return e.code}};`;

test("spawnSync stdio:'inherit' hands the child the parent's own fds, like node", (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = tmpdir();
  try {
    const f = prog(dir, 'p.cjs', `${FD_IDENTITY}
      const cp = require('node:child_process');
      const child = ${JSON.stringify(`${FD_IDENTITY}process.stdout.write(JSON.stringify({child:[id(0),id(1),id(2)]})+'\\n')`)};
      process.stdout.write(JSON.stringify({ parent: [id(0), id(1), id(2)] }) + '\\n');
      const r = cp.spawnSync(${JSON.stringify(process.execPath)}, ['-e', child], { stdio: 'inherit' });
      process.stdout.write(JSON.stringify({ status: r.status, stdout: r.stdout, stderr: r.stderr }) + '\\n');`);
    const run = (r) => {
      const lines = String(r.stdout).trim().split('\n').map((l) => JSON.parse(l));
      return { parent: lines[0].parent, child: lines[1].child, result: lines[2] };
    };
    const node = run(spawnSync(process.execPath, [f], { encoding: 'utf8' }));
    assert.deepStrictEqual(node.child, node.parent, 'the node reference must show the identity');
    const r = runLoader(f);
    assert.strictEqual(r.status, 0, r.stderr);
    const tjs = run(r);
    assert.deepStrictEqual(tjs.child, tjs.parent,
      "the child's stdio is not the parent's: an inherited slot became a pipe (a relaunched TUI renders into it)");
    assert.deepStrictEqual(tjs.result, node.result);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("spawnSync stdio:'inherit' output is not held to maxBuffer, like node", (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = tmpdir();
  try {
    // 3 MiB to an inherited stdout with the default 1 MiB maxBuffer: node never captures it, so never kills.
    const f = prog(dir, 'p.cjs', `
      const cp = require('node:child_process');
      const r = cp.spawnSync('/bin/sh', ['-c', 'head -c 3145728 /dev/zero'], { stdio: 'inherit' });
      process.stderr.write(JSON.stringify({ status: r.status, signal: r.signal, error: r.error ? r.error.code : null }) + '\\n');`);
    const sink = path.join(dir, 'out.bin');
    const go = (cmd, argv) => {
      const fd = fs.openSync(sink, 'w');
      try { return spawnSync(cmd, argv, { stdio: ['ignore', fd, 'pipe'], encoding: 'utf8', timeout: 60000 }); } finally { fs.closeSync(fd); }
    };
    const node = go(process.execPath, [f]);
    const nodeBytes = fs.statSync(sink).size;
    const [cmd, argv] = engineSpawn(['run', LOADER, f]);
    const r = go(cmd, argv);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(lastJson(r.stderr), lastJson(node.stderr));
    assert.strictEqual(fs.statSync(sink).size, nodeBytes);
    assert.strictEqual(nodeBytes, 3145728);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('process.execve exists where node and Bun have it (a function on POSIX)', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = tmpdir();
  try {
    const f = prog(dir, 'p.cjs', 'console.log(JSON.stringify(typeof process.execve));');
    const node = spawnSync(process.execPath, [f], { encoding: 'utf8' });
    const r = runLoader(f);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(r.stdout.trim(), node.stdout.trim());
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// node's own validation (lib/internal/process/per_thread.js), identical in node 24 and 26, judged against host node.
test("process.execve refuses bad arguments with node's errors", { skip: !POSIX && 'node refuses execve on win32 before validating' }, (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = tmpdir();
  try {
    const f = prog(dir, 'p.cjs', `
      const cases = [
        () => process.execve(1),
        () => process.execve('/bin/echo', 'x'),
        () => process.execve('/bin/echo', ['a\\u0000b']),
        () => process.execve('/bin/echo', [1]),
        () => process.execve('/bin/echo', ['x'], { A: 1 }),
        () => process.execve('/bin/echo', ['x'], 's'),
        () => process.execve('/bin/echo', ['x'], null),
      ];
      const out = cases.map((c) => { try { c(); return 'returned'; } catch (e) { return [e.name, e.code, e.message]; } });
      console.log(JSON.stringify(out));`);
    const node = spawnSync(process.execPath, ['--no-warnings', f], { encoding: 'utf8' });
    assert.strictEqual(node.status, 0, node.stderr);
    const r = runLoader(f);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(lastJson(r.stdout), lastJson(node.stdout));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// A failed execve: node 26 throws its ErrnoException (node 24 aborts the process, so host node 24 cannot be the
// oracle here; the shape is node 26.10's, measured 2026-11-22). The bundle catches it and falls back, so the
// process must carry on intact: stdout still writes.
test("a failed process.execve throws node 26's error and the process carries on", { skip: !POSIX && 'POSIX' }, (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = tmpdir();
  try {
    const f = prog(dir, 'p.cjs', `
      const shape = (fn) => { try { fn(); return 'returned'; } catch (e) {
        return { name: e.name, code: e.code, errno: e.errno, syscall: e.syscall, path: e.path, message: e.message, keys: Object.keys(e).sort() }; } };
      const out = { enoent: shape(() => process.execve('/nonexistent/x', ['x'])), eacces: shape(() => process.execve(${JSON.stringify(dir)}, ['x'])) };
      console.log(JSON.stringify(out));
      console.log('STILL-ALIVE');`);
    const r = runLoader(f);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /STILL-ALIVE/);
    const got = lastJson(r.stdout);
    const keys = ['code', 'errno', 'path', 'syscall'];
    const { message, ...rest } = got.enoent;
    assert.deepStrictEqual(rest, { name: 'Error', code: 'ENOENT', errno: os.constants.errno.ENOENT, syscall: 'execve',
      path: '/nonexistent/x', keys });
    // "<CODE>, <the libc's strerror> '<file>'": node 26 says "ENOENT, No such file or directory '/nonexistent'".
    assert.match(message, /^ENOENT, No such file or directory '\/nonexistent\/x'$/i);
    assert.strictEqual(got.eacces.code, 'EACCES');
    assert.strictEqual(got.eacces.errno, os.constants.errno.EACCES);
    assert.match(got.eacces.message, new RegExp(`^EACCES, [^']+ '${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'$`));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// THE STALE ENGINE (test/fixtures/stale-engine-prelude.js: the last release's spawner, which pipes every slot, and no
// __tjs_execve): process.execve is refused by name and logged, and an inherited child's bytes are still replayed.
test('an engine without __tjs_execve refuses process.execve by name; an old spawner still replays inherit', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = tmpdir();
  try {
    const prelude = fs.readFileSync(path.join(REPO, 'test', 'fixtures', 'stale-engine-prelude.js'), 'utf8');
    const f = prog(dir, 'stale.cjs', `${prelude}
      require('child_process').spawnSync('/bin/sh', ['-c', 'echo REPLAYED-OUT'], { stdio: 'inherit' });
      let out; try { process.execve('/bin/echo', ['echo', 'x']); out = 'returned'; } catch (e) { out = e.code + ': ' + e.message; }
      console.log(JSON.stringify(out));`);
    const log = path.join(dir, 'floor.log');
    const r = runLoader(f, [], { env: { CLODE_ENGINE_FLOOR_LOG: log } });
    assert.strictEqual(r.status, 0, String(r.stderr));
    assert.match(r.stdout, /REPLAYED-OUT/);
    const msg = 'node-shim: this engine has no __tjs_execve (it predates process.execve in txiki-sync-spawn.patch), '
      + 'so process.execve cannot replace the process; rebuild it: ./build.sh --only engine.compile';
    assert.strictEqual(JSON.parse(r.stdout.trim().split('\n').pop()), `ERR_CLODE_ENGINE_FLOOR: ${msg}`);
    assert.strictEqual(fs.readFileSync(log, 'utf8').split('\n')[0], msg, 'the replay is a route, not a refusal: only execve logs');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
