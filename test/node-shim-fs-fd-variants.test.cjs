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
