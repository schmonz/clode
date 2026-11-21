'use strict';
// fs.utimesSync / fs.lutimesSync set the times BEFORE they return, as node does. Until 2026-11-21 node-shim
// started the engine's ASYNC tjs.utime and returned, so a stat right after one could read the OLD times. The
// differential caught it only under the full suite's load (BACKLOG, the 2.1.330 entry, item 16). This catches it
// in one tick: set the times, then stat at once, before anything async can run. Host node is the oracle; the
// same program runs under tjs + node-shim. Red on an engine without txiki-sync-utime.patch: there the call is
// refused by name (ERR_CLODE_ENGINE_FLOOR), and the old async shim read the old mtime.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runLoader, skipUnlessTjs, REPO } = require('./node-shim-helper.cjs');

// argv: <fs module> <scratch dir>. Every set and its read sit in ONE synchronous run: no await, no timer.
const PROG = `
const fsx = require(process.argv[2]);
const base = process.argv[3];
const f = base + '/file.txt', l = base + '/link', d = base + '/dir';
fsx.writeFileSync(f, 'x');
fsx.mkdirSync(d);
fsx.symlinkSync(f, l);
const t = (s) => ({ mtimeMs: s.mtimeMs, atimeMs: s.atimeMs });
const err = (fn) => { try { fn(); return 'no throw'; } catch (e) { return { code: e.code, syscall: e.syscall, errno: e.errno, message: e.message.split(base).join('<base>') }; } };
const out = {};
fsx.utimesSync(f, 1000, 1000);
out.seconds = t(fsx.statSync(f));
fsx.utimesSync(f, new Date(1700000000500), 1700000000.5);
out.dateAndFraction = t(fsx.statSync(f));
fsx.utimesSync(d, 3000, 4000);
out.dir = t(fsx.statSync(d));
fsx.lutimesSync(l, 2000, 2000);
out.linkItself = t(fsx.lstatSync(l));
out.targetUntouched = t(fsx.statSync(f));
fsx.utimesSync(l, 5000, 6000);
out.throughLink = t(fsx.statSync(f));
out.missing = err(() => fsx.utimesSync(base + '/nope', 1, 1));
out.lmissing = err(() => fsx.lutimesSync(base + '/nope', 1, 1));
console.log(JSON.stringify(out));
`;

function scratch() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shim-utime-sync-')));
}

test('utimesSync and lutimesSync have set the times when they return, as node has (same tick)', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = scratch();
  try {
    const prog = path.join(dir, 'prog.cjs');
    fs.writeFileSync(prog, PROG);
    fs.mkdirSync(path.join(dir, 'n'));
    fs.mkdirSync(path.join(dir, 'q'));
    const n = spawnSync(process.execPath, [prog, 'fs', path.join(dir, 'n')], { encoding: 'utf8' });
    assert.strictEqual(n.status, 0, n.stderr);
    const want = JSON.parse(n.stdout);
    // the oracle's own floor: node sets the times it was given, so a same-tick read is a real test
    assert.deepStrictEqual(want.seconds, { mtimeMs: 1000000, atimeMs: 1000000 });
    assert.strictEqual(want.missing.code, 'ENOENT');
    const q = runLoader(prog, ['fs', path.join(dir, 'q')]);
    assert.strictEqual(q.status, 0, q.stderr);
    assert.deepStrictEqual(JSON.parse(q.stdout), want);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The stale engine (test/fixtures/stale-engine-prelude.js: the last release's __tjs_fs_sync, which has no utime)
// is refused by name: no silent async fallback, and the refusal reaches CLODE_ENGINE_FLOOR_LOG for the gates.
test('an engine without the sync utime is refused by name, and the refusal is logged', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = scratch();
  try {
    const prelude = fs.readFileSync(path.join(REPO, 'test', 'fixtures', 'stale-engine-prelude.js'), 'utf8');
    const prog = path.join(dir, 'stale.cjs');
    fs.writeFileSync(prog, `${prelude}
const fsx = require(process.argv[2]);
const f = process.argv[3] + '/file.txt';
fsx.writeFileSync(f, 'x');
const r = {};
for (const op of ['utimesSync', 'lutimesSync']) { try { fsx[op](f, 1000, 1000); r[op] = 'returned'; } catch (e) { r[op] = e.code + ': ' + e.message; } }
console.log(JSON.stringify(r));
`);
    const log = path.join(dir, 'floor.log');
    const r = runLoader(prog, [path.join(REPO, 'libexec/node-shim/modules/fs.cjs'), dir], { env: { CLODE_ENGINE_FLOOR_LOG: log } });
    assert.strictEqual(r.status, 0, r.stderr);
    const got = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.match(got.utimesSync, /^ERR_CLODE_ENGINE_FLOOR: node-shim: this engine has no synchronous utime \(it predates txiki-sync-utime\.patch\)/);
    assert.match(got.lutimesSync, /^ERR_CLODE_ENGINE_FLOOR: node-shim: this engine has no synchronous lutime /);
    const logged = fs.readFileSync(log, 'utf8');
    assert.match(logged, /no synchronous utime/);
    assert.match(logged, /no synchronous lutime/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
