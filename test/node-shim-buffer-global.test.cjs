'use strict';
// The bundle's global Buffer is feross `buffer` when installed: identity with
// require('buffer').Buffer, and Buffer.from(ArrayBuffer) is a VIEW (writes to
// the view mutate the source) — buffer-lite copied. SKIPs unless the feross
// package resolves from NODE_PATH (the dep store).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runLoader, skipUnlessTjs, REPO } = require('./node-shim-helper.cjs');

function ferossPath() {
  for (const root of (process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean)) {
    if (fs.existsSync(path.join(root, 'buffer', 'package.json'))) return root;
  }
  const local = path.join(REPO, 'node_modules');
  return fs.existsSync(path.join(local, 'buffer', 'package.json')) ? local : null;
}

test('global Buffer is feross (view semantics) and === node:buffer.Buffer', (t) => {
  if (skipUnlessTjs(t)) return;
  const root = ferossPath();
  if (!root) { t.skip('feross buffer not installed (npm install / populate the dep store)'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-bufg-'));
  const f = path.join(dir, 'p.cjs');
  fs.writeFileSync(f, `
    const ab = new ArrayBuffer(3);
    const b = Buffer.from(ab);        // feross: a VIEW over ab
    b[0] = 65;
    console.log(JSON.stringify({
      sameId: Buffer === require('node:buffer').Buffer,
      isView: new Uint8Array(ab)[0] === 65,
      hex: Buffer.from('hi').toString('hex'),
    }));`);
  const r = runLoader(f, [], { env: { NODE_PATH: root } });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), { sameId: true, isView: true, hex: '6869' });
});
