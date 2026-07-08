'use strict';
// Characterization for stream.finished (top-level callback form) added in the
// phase-3 API coverage batch: fires once with null on terminal state and with
// the error on 'error'; returns a cleanup fn. tjs-under-loader vs host node.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

test('stream.finished: null on end, error on error, callable cleanup', (t) => {
  if (skipUnlessTjs(t)) return;
  const prog = `
const { Readable, finished } = require('node:stream');
(async () => {
  const o = [];
  await new Promise((res) => {
    const r = Readable.from(['a','b','c']);
    const cleanup = finished(r, (err) => { o.push(['end', err ? 'err' : 'ok', typeof cleanup]); res(); });
    r.on('data', () => {});
  });
  await new Promise((res) => {
    const r = new Readable({ read(){} });
    finished(r, (err) => { o.push(['error', err ? err.message : 'noerr']); res(); });
    r.destroy(new Error('boom'));
  });
  console.log(JSON.stringify(o));
})();
`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-fin-'));
  const f = path.join(dir, 'p.cjs');
  fs.writeFileSync(f, prog);
  const nodeOut = execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim();
  assert.strictEqual(nodeOut, JSON.stringify([['end', 'ok', 'function'], ['error', 'boom']]), `host drifted: ${nodeOut}`);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), nodeOut, `tjs != node:\ntjs=${r.stdout}\nnode=${nodeOut}`);
});
