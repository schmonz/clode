'use strict';
// THE ENGINE'S TLS TRUST, driven on the built engine (security review of the WebFetch fix, 2026-11-20).
//
//   1. A TLS 1.2 server that signs its ServerKeyExchange with rsa_pss_rsae_sha256 is now accepted
//      (scripts/build-tjs.cjs fixupMbedtlsTls12RsaPss). The relaxation must not accept a FORGED signature: a proxy
//      between the engine and a real server flips one byte of the ServerKeyExchange signature, or one byte of the
//      server_random it signs, and the engine must refuse the handshake. Deterministic: the flipped byte is fixed, and
//      a PSS signature over a changed message or with a changed byte never verifies. The untampered row is the
//      control: it is what fails on an engine without the fix, so the refusals cannot pass by refusing everything.
//   2. The fixup refuses to build when the sig_alg "offered" check no longer follows the check it relaxes.
//   3. txiki-ca-bundle-global.patch: __tjs_x509_parse_error accepts exactly one certificate the engine's parser takes
//      and names why not otherwise (an Ed25519 CA, a corrupt block); __tjs_set_ca_bundle_path reaches tjs.connect('tls')
//      as well as fetch, and a second call throws.
//   4. A built quaude takes both globals off globalThis before any other code runs, and NODE_EXTRA_CA_CERTS keeps the
//      good certificate and warns, in node's words, about the one the engine cannot parse.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const tls = require('node:tls');
const https = require('node:https');
const { execFile, execFileSync, spawnSync } = require('node:child_process');
const { tjsPath } = require('./node-shim-helper.cjs');
const { builtQuaude } = require('./built-binary.cjs');

const REPO = path.resolve(__dirname, '..');
const hasOpenssl = spawnSync('openssl', ['version'], { stdio: 'ignore' }).status === 0;
const ENGINE = tjsPath();
const engineSkip = !ENGINE ? 'no tjs engine (CLODE_TJS, or run scripts/build-tjs.cjs)'
  : !hasOpenssl ? 'no openssl to make the test certificates' : false;

function tmpdir(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tjs-trust-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
function rsaCert(dir, name = 'rsa') {
  const key = path.join(dir, `${name}-key.pem`);
  const cert = path.join(dir, `${name}.pem`);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1',
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'pipe' });
  return { key, cert };
}
function ed25519Cert(dir) {
  const key = path.join(dir, 'ed-key.pem');
  const cert = path.join(dir, 'ed.pem');
  execFileSync('openssl', ['genpkey', '-algorithm', 'ed25519', '-out', key], { stdio: 'pipe' });
  execFileSync('openssl', ['req', '-x509', '-key', key, '-out', cert, '-days', '1', '-subj', '/CN=ed25519 test CA'],
    { stdio: 'pipe' });
  return { key, cert };
}
// Run a script under the engine (`tjs run`), with an environment that names no CA bundle unless `env` does.
function runEngine(dir, src, env = {}) {
  const script = path.join(dir, `s${Math.floor(performance.now() * 1000)}.js`);
  fs.writeFileSync(script, src);
  const base = { ...process.env };
  for (const k of ['TJS_CA_BUNDLE', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS']) delete base[k];
  return new Promise((resolve) => {
    execFile(ENGINE, ['run', script], { env: { ...base, ...env }, timeout: 20000, encoding: 'utf8' },
      (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout).trim(), stderr }));
  });
}

// A TLS-1.2-only server that signs with rsa_pss_rsae_sha256, behind a proxy that can tamper with its first flight.
// mode 'good' passes everything; 'sig' flips the last byte of the ServerKeyExchange (inside its signature); 'random'
// flips a byte of the ServerHello's server_random, which the ServerKeyExchange signature covers. The proxy buffers
// the server's records until the whole first flight (through ServerHelloDone) is in, so the byte it flips is fixed.
async function pssTarget(t, dir, mode) {
  const { key, cert } = rsaCert(dir);
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert), maxVersion: 'TLSv1.2',
    sigalgs: 'rsa_pss_rsae_sha256' }, (req, res) => res.end('PSS-OK'));
  server.on('tlsClientError', () => {});
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const state = { flipped: false };
  const proxy = net.createServer((c) => {
    const u = net.connect(server.address().port, '127.0.0.1');
    c.pipe(u);
    let buf = Buffer.alloc(0);
    let passthru = mode === 'good';
    u.on('data', (d) => {
      if (passthru) { c.write(d); return; }
      buf = Buffer.concat([buf, d]);
      // Handshake bytes, each mapped back to its offset in buf (records may split a message).
      const map = [];
      let off = 0;
      while (off + 5 <= buf.length) {
        const len = buf.readUInt16BE(off + 3);
        if (off + 5 + len > buf.length) break;
        if (buf[off] === 22) for (let i = 0; i < len; i++) map.push(off + 5 + i);
        off += 5 + len;
      }
      const hs = Buffer.from(map.map((i) => buf[i]));
      for (let h = 0; h + 4 <= hs.length;) {
        const type = hs[h];
        const len = hs.readUIntBE(h + 1, 3);
        if (h + 4 + len > hs.length) return; // the rest of this message is still to come
        if (mode === 'random' && type === 2 && !state.flipped) { buf[map[h + 4 + 2 + 5]] ^= 0x01; state.flipped = true; }
        if (mode === 'sig' && type === 12 && !state.flipped) { buf[map[h + 4 + len - 1]] ^= 0x01; state.flipped = true; }
        if (type === 14) { passthru = true; c.write(buf); buf = Buffer.alloc(0); return; }
        h += 4 + len;
      }
    });
    u.on('end', () => c.end());
    u.on('error', () => c.destroy());
    c.on('error', () => u.destroy());
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  t.after(() => { proxy.close(); server.close(); });
  return { port: proxy.address().port, cert, state };
}
const FETCH = (port) => `try { const r = await fetch('https://127.0.0.1:${port}/'); console.log('BODY ' + await r.text()); }
catch (e) { console.log('REFUSED ' + ((e && e.message) || e)); }`;

for (const [mode, expect] of [['good', 'BODY PSS-OK'], ['sig', /^REFUSED /], ['random', /^REFUSED /]]) {
  const what = { good: 'the untampered handshake (the control) is accepted',
    sig: 'a byte-flipped ServerKeyExchange signature is REFUSED',
    random: 'a byte-flipped server_random, which the signature covers, is REFUSED' }[mode];
  test(`TLS 1.2 rsa_pss_rsae_sha256: ${what}`, { skip: engineSkip || (process.platform === 'win32' && 'POSIX rig') }, async (t) => {
    const dir = tmpdir(t);
    const target = await pssTarget(t, dir, mode);
    const out = await runEngine(dir, FETCH(target.port), { TJS_CA_BUNDLE: target.cert });
    if (typeof expect === 'string') assert.strictEqual(out.stdout, expect, out.stderr);
    else assert.match(out.stdout, expect, out.stderr);
    assert.strictEqual(target.state.flipped, mode !== 'good', 'the tamper rig flipped exactly the byte it meant to');
  });
}

// The fixup, run on a fixture of the mbedtls 3.6.6 text it edits.
const SUPPORT = `    if (!mbedtls_ssl_sig_alg_is_supported(ssl, sig_alg)) {
        MBEDTLS_SSL_DEBUG_MSG(1,
                              ("Server used unsupported value in SigAlg extension 0x%04x",
                               sig_alg));
        return MBEDTLS_SSL_ALERT_MSG_ILLEGAL_PARAMETER;
    }

`;
const OFFERED = `    /*
     * Check if the signature algorithm is acceptable
     */
    if (!mbedtls_ssl_sig_alg_is_offered(ssl, sig_alg)) {
        MBEDTLS_SSL_DEBUG_MSG(1, ("Server used SigAlg value 0x%04x that was not offered", sig_alg));
        return MBEDTLS_SSL_ALERT_MSG_ILLEGAL_PARAMETER;
    }

`;
const TAIL = `    MBEDTLS_SSL_DEBUG_MSG(2, ("Server used SignatureAlgorithm %d", sig_alg & 0x00FF));

    return 0;
}
`;
function loadFixup() {
  const src = fs.readFileSync(path.join(REPO, 'scripts/build-tjs.cjs'), 'utf8');
  const m = /\nfunction fixupMbedtlsTls12RsaPss\(dir\) \{\n[\s\S]*?\n\}\n/.exec(src);
  assert.ok(m, 'fixupMbedtlsTls12RsaPss is in scripts/build-tjs.cjs');
  return new Function('fs', 'path', 'console', `${m[0]}\nreturn fixupMbedtlsTls12RsaPss;`)(fs, path, { log() {} });
}
function onFixture(t, text) {
  const dir = tmpdir(t);
  const f = path.join(dir, 'deps/mbedtls/library/ssl_tls12_client.c');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, `static int f(void)\n{\n${text}`);
  return { dir, read: () => fs.readFileSync(f, 'utf8') };
}
test('fixupMbedtlsTls12RsaPss relaxes the support check only while the offered check still follows it', (t) => {
  const fixup = loadFixup();
  const ok = onFixture(t, SUPPORT + OFFERED + TAIL);
  fixup(ok.dir);
  assert.match(ok.read(), /clode: rsa_pss_rsae_\* in TLS 1\.2/);
  fixup(ok.dir); // applied again: still checked, still fine
  for (const [why, text] of [['the offered check is gone', SUPPORT + TAIL],
    ['the offered check moved before it', OFFERED + SUPPORT + TAIL],
    ['the offered check moved after the return', SUPPORT + TAIL + OFFERED]]) {
    const bad = onFixture(t, text);
    assert.throws(() => fixup(bad.dir), /offered check no longer follows/, why);
    assert.doesNotMatch(bad.read(), /clode: rsa_pss_rsae_/, `${why}: the file is left alone`);
  }
  // Already applied, then upstream drops the offered check: refused too.
  const later = onFixture(t, SUPPORT + OFFERED + TAIL);
  fixup(later.dir);
  fs.writeFileSync(path.join(later.dir, 'deps/mbedtls/library/ssl_tls12_client.c'), later.read().replace(/    \/\*\n     \* Check if[\s\S]*?not offered[\s\S]*?\n    \}\n/, ''));
  assert.throws(() => fixup(later.dir), /offered check no longer follows/);
});

test('__tjs_x509_parse_error accepts one parseable certificate and names why not otherwise', { skip: engineSkip }, async (t) => {
  const dir = tmpdir(t);
  const rsa = fs.readFileSync(rsaCert(dir).cert, 'utf8');
  const ed = fs.readFileSync(ed25519Cert(dir).cert, 'utf8');
  const corrupt = rsa.replace(/\n([A-Za-z0-9+/]{20})/, '\n!!!!$1');
  const out = await runEngine(dir, `const f = globalThis.__tjs_x509_parse_error;
const rows = ${JSON.stringify({ rsa, ed, corrupt, two: rsa + rsa, none: 'not a pem' })};
const r = {}; for (const k of Object.keys(rows)) r[k] = f(rows[k]) ?? null;
console.log(JSON.stringify(r));`);
  const r = JSON.parse(out.stdout);
  assert.strictEqual(r.rsa, null, 'an RSA certificate is accepted');
  assert.match(r.ed, /^mbedtls -0x[0-9a-f]{4}: /, 'an Ed25519 certificate, which the engine cannot use, is named');
  assert.match(r.corrupt, /^mbedtls -0x[0-9a-f]{4}: /, 'a corrupt block is named');
  assert.match(r.two, /expected one certificate, found 2/);
  assert.match(r.none, /^mbedtls -0x[0-9a-f]{4}: /);
});

test('__tjs_set_ca_bundle_path reaches tjs.connect(\'tls\') too, and a second call throws', { skip: engineSkip }, async (t) => {
  const dir = tmpdir(t);
  const { key, cert } = rsaCert(dir);
  const server = tls.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (s) => s.end('x'));
  server.on('tlsClientError', () => {});
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const connect = `try { await tjs.connect('tls', '127.0.0.1', ${server.address().port}); console.log('CONNECTED'); }
catch (e) { console.log('REFUSED ' + ((e && e.message) || e)); }`;
  // The control: without the bundle, the self-signed server is not trusted.
  assert.match((await runEngine(dir, connect)).stdout, /^REFUSED /);
  const out = await runEngine(dir, `globalThis.__tjs_set_ca_bundle_path(${JSON.stringify(cert)});
let again; try { globalThis.__tjs_set_ca_bundle_path(${JSON.stringify(cert)}); again = 'no throw'; } catch (e) { again = e.message; }
${connect}
console.log('AGAIN ' + again);`);
  assert.match(out.stdout, /^CONNECTED$/m, out.stderr);
  assert.match(out.stdout, /^AGAIN the CA bundle path is already set/m);
});

test('a built quaude takes the CA globals off globalThis before any other code, and keeps only parseable extra certs', async (t) => {
  const q = builtQuaude();
  if (q.skip) { t.skip(q.skip); return; }
  if (!hasOpenssl || process.platform === 'win32') { t.skip('no openssl / POSIX probe'); return; }
  const dir = tmpdir(t);
  const extra = path.join(dir, 'extra.pem');
  const body = (pem) => pem.split('-----')[2].replace(/\s+/g, '');
  const rsaPem = fs.readFileSync(rsaCert(dir).cert, 'utf8');
  const edPem = fs.readFileSync(ed25519Cert(dir).cert, 'utf8');
  fs.writeFileSync(extra, rsaPem + edPem);
  const probe = path.join(dir, 'probe.cjs');
  const probeOut = path.join(dir, 'probe.json');
  fs.writeFileSync(probe, `require('fs').writeFileSync(${JSON.stringify(probeOut)}, JSON.stringify({
  set: typeof globalThis.__tjs_set_ca_bundle_path, parse: typeof globalThis.__tjs_x509_parse_error,
  inGlobal: ['__tjs_set_ca_bundle_path', '__tjs_x509_parse_error'].filter((k) => k in globalThis) }));\n`);
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  const r = spawnSync(q.path, ['--version'], { encoding: 'utf8', timeout: 60000, env: { ...process.env, HOME: home,
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CLODE_CACHE: path.join(dir, 'cache'), CLODE_PROBE: probe,
    NODE_EXTRA_CA_CERTS: extra } });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(probeOut, 'utf8')), { set: 'undefined', parse: 'undefined', inGlobal: [] });
  const warnings = r.stderr.split('\n').filter((l) => l.startsWith('Warning: Ignoring extra certs'));
  assert.strictEqual(warnings.length, 1, r.stderr);
  assert.match(warnings[0], new RegExp(`^Warning: Ignoring extra certs from \`${extra.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\`, load failed: mbedtls -0x`));
  const guard = path.join(dir, 'cache', 'guard');
  const bundles = fs.readdirSync(guard).filter((n) => /^ca-[0-9a-f]+\.pem$/.test(n));
  assert.strictEqual(bundles.length, 1, 'the good certificate was kept, in a bundle in the private directory');
  const bundle = fs.readFileSync(path.join(guard, bundles[0]), 'utf8').replace(/\s+/g, '');
  assert.ok(bundle.includes(body(rsaPem)), 'the RSA certificate is in it');
  assert.ok(!bundle.includes(body(edPem)), 'the Ed25519 CA is not');
  assert.ok(bundle.split('BEGINCERTIFICATE').length > 50, 'the roots are in it');
});
