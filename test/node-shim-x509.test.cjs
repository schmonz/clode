'use strict';
// node-shim's crypto.X509Certificate against host node, on the same certificates.
//
// WHY. The shim had no X509Certificate, and 2.1.330 builds its CA trust by hashing every bundled root
// (`new X509Certificate(pem).raw`): a live NetBSD/arm64 quaude --debug-file log (2026-11-23) read
// `[ERROR] CA certs: A bundled root does not parse: TypeError: not a function` 16 times at every start. Native logs
// nothing. libexec/node-shim/internal/x509.cjs serves the members the certificate's own bytes answer; the rest are
// walls by name (its header), which the last row here pins.
//
// THE ORACLE is host node over: host node's own root store (tls.rootCertificates), the shim's bundled roots
// (libexec/node-shim/modules/tls-cacert.pem, what the bundle hashes under quaude), a fresh openssl self-signed
// certificate (a leaf-shaped one with no CA flag too), DER bytes, a TRUSTED CERTIFICATE block, and the malformed
// inputs whose errors the bundle catches.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tls = require('node:tls');
const { execFileSync } = require('node:child_process');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');
const { selfSignedCert, opensslEnv } = require('./self-signed-cert.cjs');

const SHIM_ROOTS = path.join(__dirname, '..', 'libexec', 'node-shim', 'modules', 'tls-cacert.pem');
const MEMBERS = ['serialNumber', 'fingerprint256', 'validFrom', 'validTo', 'validFromDate', 'validToDate', 'ca'];

const PROGRAM = `
const fs = require('fs');
const { X509Certificate } = require('crypto');
const D = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const show = (v) => v instanceof Date ? 'Date ' + v.toISOString() : v;
const out = {};
for (const [name, input] of Object.entries(D.inputs)) {
  const arg = input.kind === 'hex' ? Buffer.from(input.v, 'hex') : input.kind === 'u8' ? new Uint8Array(Buffer.from(input.v, 'hex')) : input.kind === 'num' ? input.v : input.v;
  try {
    const c = new X509Certificate(arg);
    const r = { raw: c.raw.toString('hex'), isBuffer: Buffer.isBuffer(c.raw), toString: c.toString(), toJSON: c.toJSON() };
    for (const m of D.members) r[m] = show(c[m]);
    out[name] = r;
  } catch (e) { out[name] = { threw: { name: e.name, code: e.code, message: e.message, library: e.library, reason: e.reason } }; }
}
fs.writeFileSync(process.argv[3], JSON.stringify(out));
`;

function splitPem(text) { return text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----\n?/g) || []; }

function run(engine, data) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x509-'));
  try {
    const entry = path.join(dir, 'p.cjs'), inFile = path.join(dir, 'in.json'), outFile = path.join(dir, 'out.json');
    fs.writeFileSync(entry, PROGRAM);
    fs.writeFileSync(inFile, JSON.stringify(data));
    if (engine === 'node') execFileSync(process.execPath, [entry, inFile, outFile]);
    else {
      const r = runLoader(entry, [inFile, outFile], { timeout: 120000 });
      assert.strictEqual(r.status, 0, String(r.stderr));
    }
    return JSON.parse(fs.readFileSync(outFile, 'utf8'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('crypto.X509Certificate answers as host node does, on every root either side trusts and the edge inputs', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x509-certs-'));
  try {
    const inputs = {};
    tls.rootCertificates.forEach((pem, i) => { inputs[`node-root-${i}`] = { kind: 'str', v: pem }; });
    splitPem(fs.readFileSync(SHIM_ROOTS, 'utf8')).forEach((pem, i) => { inputs[`shim-root-${i}`] = { kind: 'str', v: pem }; });
    const ca = fs.readFileSync(selfSignedCert(dir, { name: 'ca' }).cert, 'utf8');
    inputs.selfSigned = { kind: 'str', v: ca };
    // a leaf: no basicConstraints at all (no v3_ca section), a SAN, a 20-byte serial
    const leafCnf = path.join(dir, 'leaf.cnf');
    fs.writeFileSync(leafCnf, '[ req ]\ndistinguished_name = dn\nprompt = no\n[ dn ]\nCN = leaf\n');
    const leafPem = path.join(dir, 'leaf.pem');
    execFileSync('openssl', ['req', '-config', leafCnf, '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
      '-keyout', path.join(dir, 'leaf-key.pem'), '-out', leafPem, '-days', '400', '-subj', '/CN=leaf',
      '-addext', 'subjectAltName=DNS:example.test', '-addext', 'keyUsage=digitalSignature'], { stdio: 'pipe', env: { ...process.env, ...opensslEnv(dir) } });
    const leaf = fs.readFileSync(leafPem, 'utf8');
    inputs.leaf = { kind: 'str', v: leaf };
    const der = Buffer.from(leaf.replace(/-----[A-Z ]+-----|\s/g, ''), 'base64');
    inputs.derBuffer = { kind: 'hex', v: der.toString('hex') };
    inputs.derUint8Array = { kind: 'u8', v: der.toString('hex') };
    inputs.pemBuffer = { kind: 'hex', v: Buffer.from(ca).toString('hex') };
    inputs.trusted = { kind: 'str', v: ca.replace(/CERTIFICATE/g, 'TRUSTED CERTIFICATE') };
    inputs.secondBlock = { kind: 'str', v: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n' + leaf };
    inputs.leadingText = { kind: 'str', v: 'Subject: whatever\n' + leaf };
    inputs.trailingDer = { kind: 'hex', v: Buffer.concat([der, Buffer.from('0000', 'hex')]).toString('hex') };
    inputs.garbage = { kind: 'str', v: 'x' };
    inputs.notCertDer = { kind: 'hex', v: '3003020101' };
    inputs.badPemBody = { kind: 'str', v: '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n' };
    inputs.cutPemBody = { kind: 'str', v: '-----BEGIN CERTIFICATE-----\n' + der.subarray(0, 200).toString('base64') + '\n-----END CERTIFICATE-----\n' };
    inputs.number = { kind: 'num', v: 5 };
    const data = { inputs, members: MEMBERS };
    const node = run('node', data);
    const quaude = run('quaude', data);
    assert.ok(Object.keys(node).filter((k) => k.startsWith('shim-root-')).length > 100, 'the shim\'s bundled roots were read');
    const differs = Object.keys(inputs).flatMap((name) => {
      const q = quaude[name] || {}, n = node[name] || {};
      return [...new Set([...Object.keys(q), ...Object.keys(n)])].filter((k) => JSON.stringify(q[k]) !== JSON.stringify(n[k]))
        .map((k) => `${name}.${k}: quaude ${JSON.stringify(q[k]).slice(0, 160)} node ${JSON.stringify(n[k]).slice(0, 160)}`);
    });
    assert.deepStrictEqual(differs, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// What the bundle hashes: `new X509Certificate(pem).raw` for each of tls.rootCertificates, under quaude's own tls.
test('every root quaude\'s tls.rootCertificates hands the bundle parses, and raw is its DER', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x509-roots-'));
  try {
    const entry = path.join(dir, 'p.cjs');
    fs.writeFileSync(entry, `const { X509Certificate, createHash } = require('crypto');
const roots = require('tls').rootCertificates;
const bad = [];
for (const pem of roots) {
  try {
    const raw = new X509Certificate(pem).raw;
    const der = Buffer.from(pem.slice(pem.indexOf('-----', 5) + 5, pem.lastIndexOf('-----END')).replace(/[^A-Za-z0-9+/]/g, ''), 'base64');
    if (!raw.equals(der)) bad.push('raw differs');
  } catch (e) { bad.push(String(e)); }
}
console.log(JSON.stringify({ n: roots.length, bad }));`);
    const r = runLoader(entry);
    assert.strictEqual(r.status, 0, String(r.stderr));
    const got = JSON.parse(String(r.stdout).trim().split('\n').pop());
    assert.ok(got.n > 100, `only ${got.n} roots`);
    assert.deepStrictEqual(got.bad, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// The walls are walls: each throws a branded error, never undefined (which a caller could read as "no subject").
test('the members the shim does not serve throw by name', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x509-walls-'));
  try {
    const entry = path.join(dir, 'p.cjs');
    fs.writeFileSync(entry, `const { X509Certificate } = require('crypto');
const c = new X509Certificate(require('tls').rootCertificates[0]);
const out = {};
for (const m of ['subject', 'issuer', 'subjectAltName', 'infoAccess', 'keyUsage', 'issuerCertificate', 'fingerprint', 'fingerprint512',
  'signatureAlgorithm', 'signatureAlgorithmOid', 'publicKey']) { try { out[m] = 'answered ' + c[m]; } catch (e) { out[m] = e.message; } }
for (const m of ['checkHost', 'checkEmail', 'checkIP', 'checkIssued', 'checkPrivateKey', 'verify', 'toLegacyObject']) { try { out[m] = 'answered ' + c[m](c); } catch (e) { out[m] = e.message; } }
console.log(JSON.stringify(out));`);
    const r = runLoader(entry);
    assert.strictEqual(r.status, 0, String(r.stderr));
    const got = JSON.parse(String(r.stdout).trim().split('\n').pop());
    for (const [m, msg] of Object.entries(got)) assert.match(msg, new RegExp(`^node-shim: crypto\\.X509Certificate ${m}(\\(\\))? not implemented`), m);
    assert.strictEqual(Object.keys(got).length, 18);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
