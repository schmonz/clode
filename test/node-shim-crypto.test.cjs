'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

const PROG = `
const crypto = require('node:crypto');
const out = [];
out.push(crypto.createHash('sha256').update('').digest('hex'));
out.push(crypto.createHash('sha256').update('clode').digest('hex'));
out.push(crypto.createHash('sha256').update('cl').update('ode').digest('hex'));
out.push(/^[0-9a-f-]{36}$/.test(crypto.randomUUID()));
out.push(crypto.randomBytes(16).length);
out.push(Buffer.from('hi').toString('hex'));
out.push(Buffer.from('68690a', 'hex').toString('utf8'));
out.push(Buffer.concat([Buffer.from('a'), Buffer.from('b')]).toString());
out.push(Buffer.from('hello').slice(1, 3).toString());
out.push(Buffer.from('aGk=', 'base64').toString());
out.push(Buffer.byteLength('héllo'));
out.push(Buffer.isBuffer(Buffer.alloc(2)), Buffer.alloc(2)[0]);
console.log(JSON.stringify(out));
`;

test('crypto + buffer-lite characterization vs host node', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-crypto-'));
  const f = path.join(dir, 'prog.cjs');
  fs.writeFileSync(f, PROG);
  const nodeOut = require('node:child_process')
    .execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim();
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), nodeOut);
});
