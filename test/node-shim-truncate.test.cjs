'use strict';
// Discovery-pass find (2026-07-23): the shim's fs had NO truncate at all, while
// the bundle uses fs.promises.truncate(path, len) (shrinking large Bash-output
// files) and FileHandle.truncate(len) (file restore/edit paths) — 4 real call
// sites. Under quaude those threw a code-less "not a function". Oracle: truncate
// a file three ways under the loader and diff against host node's own result.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

const BODY = `
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'trunc-'));
  const out = {};
  const a = path.join(d, 'a'); fs.writeFileSync(a, 'abcdef'); fs.truncateSync(a, 3); out.truncateSync = fs.readFileSync(a, 'utf8');
  const e = path.join(d, 'e'); fs.writeFileSync(e, 'xy'); fs.truncateSync(e, 5); out.extend = fs.readFileSync(e).length;   // pad to 5
  (async () => {
    const b = path.join(d, 'b'); fs.writeFileSync(b, 'ABCDEFGH'); await fs.promises.truncate(b, 4); out.promises = fs.readFileSync(b, 'utf8');
    const c = path.join(d, 'c'); fs.writeFileSync(c, '12345678'); const h = await fs.promises.open(c, 'r+'); await h.truncate(2); await h.close(); out.fileHandle = fs.readFileSync(c, 'utf8');
    console.log(JSON.stringify(out));
  })();`;

function prog(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-trunc-'));
  const f = path.join(dir, 'p.cjs');
  fs.writeFileSync(f, body);
  return f;
}

test('fs truncate (sync, promises, FileHandle) matches host node', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = prog(BODY);
  const node = JSON.parse(execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim());
  assert.deepStrictEqual(node, { truncateSync: 'abc', extend: 5, promises: 'ABCD', fileHandle: '12' }, 'host node baseline');
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout.trim());
  assert.deepStrictEqual(got, node, 'quaude must match node for all three truncate paths');
});
