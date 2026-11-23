'use strict';
// A throwaway self-signed certificate, made by openssl in a directory the caller owns, so no key is committed. ONE
// implementation for every test that needs one (mock-anthropic-helper's tls mock, webfetch's target, the shim's https
// rows, tjs-tls-trust).
//
// PORTABLE BY CONSTRUCTION: `openssl req` reads a config file, and its compiled-in default path does not exist on every
// host (NetBSD's base openssl looks for /etc/openssl/openssl.cnf, which a stock install does not have: "Can't open
// /etc/openssl/openssl.cnf", found by the netbsd-arm64 local VM run, 2026-11-21). So every call writes a minimal config
// beside the key and hands it over twice: `-config` for req, and OPENSSL_CONF for anything openssl loads it for.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// -> { key, cert, config }: paths in `dir`. `san` is the subjectAltName value; `key` an existing private key to sign
// with (else a new RSA 2048 one); `name` prefixes the files, so one directory can hold several.
function selfSignedCert(dir, { cn = '127.0.0.1', san = 'IP:127.0.0.1', days = 1, key = null, name = 'self-signed', stdio = 'pipe' } = {}) {
  const config = path.join(dir, `${name}-openssl.cnf`);
  fs.writeFileSync(config, ['[ req ]', 'distinguished_name = dn', 'prompt = no', 'x509_extensions = v3_ca', '[ dn ]', `CN = ${cn}`,
    // what a stock openssl.cnf's v3_ca gave every cert before: a self-signed cert that is its own CA (a client given it
    // as `ca` trusts it as an anchor), with key identifiers
    '[ v3_ca ]', 'subjectKeyIdentifier = hash', 'authorityKeyIdentifier = keyid:always,issuer', 'basicConstraints = critical,CA:TRUE', ''].join('\n'));
  const env = { ...process.env, OPENSSL_CONF: config };
  const out = { key: key || path.join(dir, `${name}-key.pem`), cert: path.join(dir, `${name}.pem`), config };
  execFileSync('openssl', ['req', '-config', config, '-x509', ...(key ? ['-key', key] : ['-newkey', 'rsa:2048', '-nodes', '-keyout', out.key]),
    '-out', out.cert, '-days', String(days), '-subj', `/CN=${cn}`, ...(san ? ['-addext', `subjectAltName=${san}`] : [])], { stdio, env });
  return out;
}

// openssl with that same minimal config (a key generation, say), for a caller that runs openssl itself.
function opensslEnv(dir) {
  const config = path.join(dir, 'openssl-env.cnf');
  if (!fs.existsSync(config)) fs.writeFileSync(config, ['[ req ]', 'distinguished_name = dn', '[ dn ]', ''].join('\n'));
  return { ...process.env, OPENSSL_CONF: config };
}

// testPki(dir) -> the certificates a TLS-verification test needs, each { cert, key } (paths), made with the same
// portable config discipline as selfSignedCert:
//   ca, ca2       two unrelated self-signed CAs ("Test CA", "Test CA2")
//   inter         an intermediate CA signed by ca
//   leaf          DNS:localhost + IP:127.0.0.1, signed by ca
//   leafInter     the same names, signed by inter (serve it with inter.cert appended: a two-certificate chain)
//   selfLeaf      the same names, self-signed and NOT a CA
//   client        a client-auth certificate signed by ca (mTLS)
//   expired       like leaf but valid only in 2020; null when this openssl lacks -not_before/-not_after (< 3.4)
function testPki(dir) {
  const config = path.join(dir, 'pki-openssl.cnf');
  fs.writeFileSync(config, ['[ req ]', 'distinguished_name = dn', 'prompt = no', '[ dn ]', 'CN = x',
    '[ v3_ca ]', 'basicConstraints = critical,CA:TRUE', 'keyUsage = critical,keyCertSign,cRLSign', 'subjectKeyIdentifier = hash',
    '[ leaf ]', 'basicConstraints = CA:FALSE', 'subjectAltName = DNS:localhost,IP:127.0.0.1', 'extendedKeyUsage = serverAuth',
    '[ client ]', 'basicConstraints = CA:FALSE', 'extendedKeyUsage = clientAuth', ''].join('\n'));
  const env = { ...process.env, OPENSSL_CONF: config };
  const ossl = (...a) => execFileSync('openssl', a, { env, stdio: 'pipe' });
  const p = (n) => path.join(dir, n);
  // one fixed serial per certificate name: unique within this PKI, which is all a verifier asks of an issuer
  const serial = (n) => 1000 + ['inter', 'leaf', 'leafInter', 'client', 'expired'].indexOf(n);
  const made = (n) => ({ cert: p(`${n}.pem`), key: p(`${n}-key.pem`) });
  const root = (n, cn) => ossl('req', '-config', config, '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', p(`${n}-key.pem`),
    '-out', p(`${n}.pem`), '-days', '2', '-subj', `/CN=${cn}`, '-extensions', 'v3_ca');
  const csr = (n, cn) => ossl('req', '-config', config, '-newkey', 'rsa:2048', '-nodes', '-keyout', p(`${n}-key.pem`), '-out', p(`${n}.csr`), '-subj', `/CN=${cn}`);
  const sign = (n, issuer, ext, ...when) => ossl('x509', '-req', '-in', p(`${n}.csr`), '-CA', p(`${issuer}.pem`), '-CAkey', p(`${issuer}-key.pem`),
    '-set_serial', String(serial(n)), '-out', p(`${n}.pem`), ...(when.length ? when : ['-days', '2']), '-extfile', config, '-extensions', ext);
  root('ca', 'Test CA'); root('ca2', 'Test CA2');
  csr('inter', 'Test Intermediate'); sign('inter', 'ca', 'v3_ca');
  csr('leaf', 'localhost'); sign('leaf', 'ca', 'leaf');
  csr('leafInter', 'localhost'); sign('leafInter', 'inter', 'leaf');
  csr('client', 'test client'); sign('client', 'ca', 'client');
  ossl('req', '-config', config, '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', p('selfLeaf-key.pem'), '-out', p('selfLeaf.pem'),
    '-days', '2', '-subj', '/CN=localhost', '-extensions', 'leaf');
  let expired = null;
  try {
    csr('expired', 'localhost'); sign('expired', 'ca', 'leaf', '-not_before', '20200101000000Z', '-not_after', '20200102000000Z');
    expired = made('expired');
  } catch { /* openssl < 3.4: no -not_before; the caller skips that row, loudly */ }
  return { ca: made('ca'), ca2: made('ca2'), inter: made('inter'), leaf: made('leaf'), leafInter: made('leafInter'),
    selfLeaf: made('selfLeaf'), client: made('client'), expired };
}

module.exports = { selfSignedCert, opensslEnv, testPki };
