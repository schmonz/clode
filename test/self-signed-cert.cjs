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
  fs.writeFileSync(config, ['[ req ]', 'distinguished_name = dn', 'prompt = no', '[ dn ]', `CN = ${cn}`, ''].join('\n'));
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

module.exports = { selfSignedCert, opensslEnv };
