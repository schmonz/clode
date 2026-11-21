'use strict';
// test/self-signed-cert.cjs on a host whose openssl has NO config at its compiled-in path: the NetBSD shape (base
// openssl looks for /etc/openssl/openssl.cnf, absent on a stock install; the netbsd-arm64 local VM run, 2026-11-21,
// failed webfetch's selfSigned cell on exactly that). OPENSSL_CONF at a nonexistent file reproduces it on any host.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { selfSignedCert } = require('./self-signed-cert.cjs');

const MISSING = path.join(os.tmpdir(), 'clode-no-such-dir', 'openssl.cnf');
const withMissingConf = (fn) => {
  const was = process.env.OPENSSL_CONF;
  process.env.OPENSSL_CONF = MISSING;
  try { return fn(); } finally { if (was === undefined) delete process.env.OPENSSL_CONF; else process.env.OPENSSL_CONF = was; }
};

test('selfSignedCert makes a CA:TRUE cert with its SAN when openssl\'s own config file does not exist', (t) => {
  if (spawnSync('openssl', ['version']).status !== 0) { t.skip('no openssl on PATH'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-ssc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // CONTROL: the bare call the helper replaced fails in this environment, so the environment is the NetBSD shape
  const bare = withMissingConf(() => spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'),
    '-out', path.join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=x'], { encoding: 'utf8', env: process.env }));
  assert.notStrictEqual(bare.status, 0, `bare openssl req succeeded with OPENSSL_CONF=${MISSING}: the control does not reproduce the bug`);
  const out = withMissingConf(() => selfSignedCert(dir, { cn: 'localhost', san: 'DNS:localhost,IP:127.0.0.1' }));
  const text = spawnSync('openssl', ['x509', '-in', out.cert, '-noout', '-text'], { encoding: 'utf8' }).stdout;
  assert.match(text, /Basic Constraints: critical\s+CA:TRUE/);
  assert.match(text, /DNS:localhost, IP Address:127\.0\.0\.1/);
  assert.match(text, /Subject: CN\s*=\s*localhost/);
});
