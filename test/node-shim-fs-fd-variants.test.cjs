'use strict';
// Task 2 (phase 2 API gaps): fd-flavored fs variants. The shim already
// provides chmodSync/statSync/createReadStream BY PATH; this locks the
// fd-flavored spellings the golden gap map (test/shim-surface/golden.json)
// listed as missing: fs.fchmodSync, fs.fstat (callback), fs.ReadStream.
// Same class of bug as the FileHandle.chmod gap that broke Edit (memory
// shim-filehandle-chmod-gap): under quickjs a missing method throws a bare,
// unnamed TypeError, and a false `instanceof fs.ReadStream` silently takes
// the else-branch rather than erroring at all.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

function writeProg(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-fd-variants-'));
  const f = path.join(dir, 'p.cjs');
  fs.writeFileSync(f, body);
  return f;
}

test('fs.fchmodSync changes mode via an fd, like chmodSync by path', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = writeProg(`
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    const target = path.join(os.tmpdir(), 'fchmod-' + Date.now());
    fs.writeFileSync(target, 'x');
    const fd = fs.openSync(target, 'r+');
    fs.fchmodSync(fd, 0o600);
    fs.closeSync(fd);
    const mode = (fs.statSync(target).mode & 0o777).toString(8);
    fs.unlinkSync(target);
    console.log(JSON.stringify({ mode }));
  `);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), { mode: '600' });
});

test('fs.fchmodSync on an unrecorded/bad fd fails loud, not silently', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = writeProg(`
    const fs = require('node:fs');
    let threw = false;
    try { fs.fchmodSync(999999, 0o600); } catch (e) { threw = e instanceof Error && !!e.message; }
    console.log(JSON.stringify({ threw }));
  `);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), { threw: true });
});

test('fs.fstatSync returns the same size as statSync (already-present symmetric pair)', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = writeProg(`
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    const target = path.join(os.tmpdir(), 'fstat-' + Date.now());
    fs.writeFileSync(target, 'hello');
    const fd = fs.openSync(target, 'r');
    const size = fs.fstatSync(fd).size;
    const match = size === fs.statSync(target).size;
    fs.closeSync(fd); fs.unlinkSync(target);
    console.log(JSON.stringify({ size, match }));
  `);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), { size: 5, match: true });
});

test('fs.fstat(fd, cb) delivers (err, stats) like host node, err null on success', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = writeProg(`
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    const target = path.join(os.tmpdir(), 'fstatcb-' + Date.now());
    fs.writeFileSync(target, 'hello world');
    const fd = fs.openSync(target, 'r');
    fs.fstat(fd, (err, stats) => {
      fs.closeSync(fd); fs.unlinkSync(target);
      console.log(JSON.stringify({ errIsNull: err === null, size: stats.size, isFile: stats.isFile() }));
    });
  `);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), { errIsNull: true, size: 11, isFile: true });
});

test('fs.fstat(fd, cb) delivers an error for a bad fd, not a throw or hang', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = writeProg(`
    const fs = require('node:fs');
    fs.fstat(999999, (err, stats) => {
      console.log(JSON.stringify({ hasErr: err instanceof Error, statsUndefined: stats === undefined }));
    });
  `);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), { hasErr: true, statsUndefined: true });
});

test('fs.ReadStream is the real class createReadStream returns (instanceof true)', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = writeProg(`
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    const target = path.join(os.tmpdir(), 'rs-' + Date.now());
    fs.writeFileSync(target, 'abc');
    const s = fs.createReadStream(target);
    const isInstance = s instanceof fs.ReadStream;
    const isCtor = typeof fs.ReadStream === 'function';
    s.on('data', () => {});
    s.on('end', () => {
      fs.unlinkSync(target);
      console.log(JSON.stringify({ isInstance, isCtor }));
    });
  `);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), { isInstance: true, isCtor: true });
});

test('a directly-constructed fs.ReadStream still streams data (not a lookalike stub)', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = writeProg(`
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    const target = path.join(os.tmpdir(), 'rs-direct-' + Date.now());
    fs.writeFileSync(target, 'direct-construct-payload');
    const s = new fs.ReadStream(target, 'utf8');
    let chunks = '';
    s.on('data', (c) => { chunks += c; });
    s.on('end', () => {
      fs.unlinkSync(target);
      console.log(JSON.stringify({ chunks }));
    });
  `);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), { chunks: 'direct-construct-payload' });
});

// Code-review finding: closeSync/close must delete their fdPaths entry in a
// `finally`, not just after a successful FSS.close — otherwise a throwing
// close (a caller bug this codebase already anticipates: createWriteStream's
// closeFd() wraps its own close in try/catch for exactly "already closed")
// leaves the map entry stale, and a LATER fd-producing path that reuses that
// fd number would make fchmodSync silently chmod the WRONG file.
//
// To make FSS.close genuinely throw while the fd is STILL on record in
// fdPaths (a plain double-closeSync doesn't do this — the entry is already
// gone after the first, successful close, so the second call's throw doesn't
// exercise the cleanup-under-throw path at all), this closes the underlying
// OS fd directly via the same globalThis.__tjs_fs_sync primitive fs.cjs
// itself calls, bypassing the shim's map bookkeeping. The subsequent
// fs.closeSync(fd) then genuinely throws EBADF from FSS.close with the entry
// still present — the exact scenario the `finally` fixes. Verified this test
// fails without the fix: reverting closeSync to `FSS.close(fd);
// fdPaths.delete(fd);` (no finally) made fchmodSync afterward SUCCEED
// silently against the stale path instead of throwing EBADF.
test('closeSync cleans up fdPaths even when the underlying close throws', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = writeProg(`
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    const target = path.join(os.tmpdir(), 'closefinally-' + Date.now());
    fs.writeFileSync(target, 'x');
    const fd = fs.openSync(target, 'r'); // enters fdPaths
    globalThis.__tjs_fs_sync.close(fd);  // closes the OS fd behind the shim's back
    let closeThrew = false, closeCode = '';
    try { fs.closeSync(fd); } catch (e) { closeThrew = true; closeCode = e && e.code; }
    let fchmodThrew = false, fchmodCode = '';
    try { fs.fchmodSync(fd, 0o600); } catch (e) { fchmodThrew = true; fchmodCode = e && e.code; }
    fs.unlinkSync(target);
    console.log(JSON.stringify({ closeThrew, closeCode, fchmodThrew, fchmodCode }));
  `);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  // Confirms this genuinely exercised the throwing-close path, not a no-op.
  assert.strictEqual(out.closeThrew, true, 'expected the second close to actually throw');
  assert.strictEqual(out.closeCode, 'EBADF');
  // The real assertion: the stale entry must be gone, so fchmodSync fails
  // loud instead of silently chmod'ing whatever path used to be on record.
  assert.strictEqual(out.fchmodThrew, true, 'fdPaths entry survived a throwing close — stale-path chmod risk');
  assert.strictEqual(out.fchmodCode, 'EBADF');
});

// Same fix, callback-style close (fsMod.close at fs.cjs:~740) — a separate
// code path from closeSync, called out separately in review.
test('fs.close(fd, cb) cleans up fdPaths even when the underlying close throws', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = writeProg(`
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    const target = path.join(os.tmpdir(), 'closecbfinally-' + Date.now());
    fs.writeFileSync(target, 'x');
    const fd = fs.openSync(target, 'r');
    globalThis.__tjs_fs_sync.close(fd);
    fs.close(fd, (closeErr) => {
      let fchmodThrew = false, fchmodCode = '';
      try { fs.fchmodSync(fd, 0o600); } catch (e) { fchmodThrew = true; fchmodCode = e && e.code; }
      fs.unlinkSync(target);
      console.log(JSON.stringify({
        closeErrCode: closeErr && closeErr.code,
        fchmodThrew, fchmodCode,
      }));
    });
  `);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  assert.strictEqual(out.closeErrCode, 'EBADF', 'expected the close callback to actually receive an error');
  assert.strictEqual(out.fchmodThrew, true, 'fdPaths entry survived a throwing close — stale-path chmod risk');
  assert.strictEqual(out.fchmodCode, 'EBADF');
});
