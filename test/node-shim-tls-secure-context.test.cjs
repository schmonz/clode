'use strict';
// tls.createSecureContext({ ca }) under quaude answers as node does. 2.1.330's CA-trust builder asks it whether the
// NODE_EXTRA_CA_CERTS file loads (`createSecureContext({ca:[file]})`) and ignores the file when it throws; the shim's
// wall always threw, so a private CA never reached WebFetch's trust list and a built quaude failed
// test/fidelity/webfetch.test.cjs with "X509 - Certificate verification failed". Node does not parse `ca` here (any
// string or bytes are accepted, measured on node 24), so neither does the shim; only the type is checked. One program,
// run under node and under quaude's engine, every row equal.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

const PROGRAM = `
const tls = require('tls');
const pem = '-----BEGIN CERTIFICATE-----\\nMIIBszCCAVmgAwIBAgIUQ2xvZGUgc2hpbSB0ZXN0IGNlcnQ=\\n-----END CERTIFICATE-----\\n';
const cases = [
  ['array of one', { ca: [pem] }], ['string', { ca: pem }], ['buffer', { ca: Buffer.from(pem) }],
  ['uint8array', { ca: new Uint8Array(Buffer.from(pem)) }], ['two in one', { ca: [pem + pem] }], ['empty', { ca: [''] }],
  ['garbage', { ca: ['garbage'] }], ['a key, not a cert', { ca: ['-----BEGIN PRIVATE KEY-----\\nAA==\\n-----END PRIVATE KEY-----\\n'] }],
  ['undefined ca', { ca: undefined }], ['no options', undefined], ['empty options', {}],
  ['number', { ca: 42 }], ['number in array', { ca: [pem, 42] }], ['object in array', { ca: [{}] }], ['null in array', { ca: [null] }],
  ['options a string', 'nope'], ['options null', null],
];
const out = [];
for (const [name, opts] of cases) {
  try {
    const c = tls.createSecureContext(opts);
    out.push([name, 'ok', typeof c, typeof (c && c.context)]);
  } catch (e) { out.push([name, 'threw', e.name, e.code, e.message]); }
}
console.log(JSON.stringify(out));
`;

test('tls.createSecureContext({ca}) answers every case as node does', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tls-secctx-'));
  try {
    const entry = path.join(dir, 'p.cjs');
    fs.writeFileSync(entry, PROGRAM);
    const want = JSON.parse(execFileSync(process.execPath, [entry], { encoding: 'utf8' }));
    const r = runLoader(entry);
    assert.strictEqual(r.status, 0, String(r.stderr));
    const got = JSON.parse(String(r.stdout).trim().split('\n').pop());
    assert.strictEqual(got.length, want.length);
    for (let i = 0; i < want.length; i++) assert.deepStrictEqual(got[i], want[i], `row ${i}: ${want[i][0]}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an option the shim cannot honour still meets the wall, never a silent accept', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tls-secctx-wall-'));
  try {
    const entry = path.join(dir, 'p.cjs');
    fs.writeFileSync(entry, `try { require('tls').createSecureContext({ cert: 'x' }); console.log('accepted'); } catch (e) { console.log(e.message); }`);
    const r = runLoader(entry);
    assert.match(String(r.stdout), /node-shim: tls\.createSecureContext\(\{cert\}\) not implemented/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
