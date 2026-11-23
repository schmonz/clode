'use strict';
// Every TLS option a caller gives a client is HONOURED or REFUSED BY NAME, never ignored (2026-11-23).
//
// WHAT WAS SILENT, measured against host node and native Claude Code 2.1.330 (Bun 1.4.4):
//   - axios (npm 1.15.2) with `httpsAgent: new https.Agent({ ca })` answered 200 from a server that ca does not cover,
//     where node fails UNABLE_TO_GET_ISSUER_CERT_LOCALLY: the engine's global XMLHttpRequest made axios pick its xhr
//     adapter, which takes no agent. Node and native Bun have no XMLHttpRequest; the node-shim now has none either.
//   - Bun's fetch/WebSocket `tls` option ({ ca, cert, key, passphrase } on EVERY request the bundle makes: its CA
//     list, which BLOCKS four roots the engine trusts, and the CLAUDE_CODE_CLIENT_CERT identity) was read by neither
//     engine. Now the engine's default trust is settable (tls.setDefaultCACertificates -> txiki-default-ca.patch, which
//     the bundle calls with that same list), a tls.ca equal to it is honoured, and anything else is refused by name.
//   - node:https honoured ca/cert/key/servername/rejectUnauthorized already, but ignored crl, sigalgs, ecdhCurve,
//     session... (now refused), joined an array `cert` with ',' (corrupting it), let a request's ca beat its agent's
//     (node: the agent's wins), and answered ECONNFAILED for every verification failure (now node's codes, from the
//     verify detail txiki-tls-verify-detail.patch puts on the handshake error).
//
// THE RATCHET: the two censuses below. The list of options is NODE'S (read out of the host node's own source) and
// BUN'S (recorded from native's own fetch: test/fixtures/bun-tls-option-reads-native.json); a name in either list
// that the shim neither honours nor refuses goes red, so the next option a runtime grows cannot be silently ignored.
// Hermetic: a self-minted CA (test/self-signed-cert.cjs testPki) and local servers; no network.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { testPki } = require('./self-signed-cert.cjs');
const { runLoader, skipUnlessTjs, REPO } = require('./node-shim-helper.cjs');
const { defineGuard, guardTests } = require('./guard.cjs');

const FIXTURES = path.join(__dirname, 'fixtures');
const HTTP = path.join(REPO, 'libexec/node-shim/modules/http.cjs');
const BUN_SHIM = path.join(REPO, 'libexec/bun-shim.cjs');

function haveOpenssl(t) {
  if (spawnSync('openssl', ['version'], { encoding: 'utf8' }).status === 0) return true;
  t.skip('no openssl on PATH; cannot mint the test certificates');
  return false;
}

// Mint the PKI and start the origin (host node, the oracle's fixed point): -> { pki, ports, stop }.
async function startOrigins() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tls-options-'));
  const pki = testPki(dir);
  const proc = spawn(process.execPath, [path.join(FIXTURES, 'tls-options-origin.cjs'), JSON.stringify(pki)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d; });
  const ports = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`origin printed no PORTS line:\n${stderr}`)), 15000);
    proc.stdout.on('data', (d) => {
      buf += d;
      const m = /PORTS (\{.*\})/.exec(buf);
      if (m) { clearTimeout(timer); resolve(JSON.parse(m[1])); }
    });
    proc.on('close', (code) => { clearTimeout(timer); reject(new Error(`origin exited (${code}):\n${stderr}`)); });
  });
  return { dir, pki, ports, stop: () => { proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

// ---- node:https, differentially ----------------------------------------------------------------------------------
test('https client: verification, trust and client certificates answer as host node does', async (t) => {
  if (skipUnlessTjs(t) || !haveOpenssl(t)) return;
  const o = await startOrigins();
  try {
    const env = { PROBE_PKI: JSON.stringify(o.pki), PROBE_PORTS: JSON.stringify(o.ports) };
    const probe = path.join(FIXTURES, 'tls-options-probe.cjs');
    const n = spawnSync(process.execPath, [probe], { encoding: 'utf8', timeout: 60000, env: { ...process.env, ...env } });
    assert.strictEqual(n.status, 0, `host node oracle failed:\n${n.stderr}`);
    const r = runLoader(probe, [], { env, timeout: 60000 });
    assert.strictEqual(r.status, 0, `tjs probe failed:\n${r.stderr}`);
    const node = JSON.parse(n.stdout); const shim = JSON.parse(r.stdout);
    if (!o.pki.expired) t.diagnostic('this openssl cannot mint an expired certificate (< 3.4): the CERT_HAS_EXPIRED row is not run');
    for (const [k, want] of Object.entries(node)) {
      const got = shim[k];
      if (want.error !== undefined) {
        // the code is node's exactly; the message is node's OpenSSL reason, which node 24 follows with a hint about
        // --use-system-ca and (for a name mismatch) the certificate's altnames, neither of which a node-shim can add
        assert.ok(got && got.error === want.error, `row '${k}': node failed ${want.error}, the shim answered ${JSON.stringify(got)}`);
        assert.ok(got.message && want.message.startsWith(got.message), `row '${k}': '${got.message}' is not node's '${want.message}'`);
      } else {
        assert.deepStrictEqual(got, want, `row '${k}' diverged from node`);
      }
    }
    assert.deepStrictEqual(Object.keys(shim).sort(), Object.keys(node).sort());
  } finally { o.stop(); }
});

// ---- the node TLS option census (the ratchet) --------------------------------------------------------------------
// node's TLS options: what tls.connect, tls.createSecureContext and configSecureContext read from their options, minus
// what net.connect reads (those are the socket's, not TLS's) and three tls.connect reads that are no caller's TLS
// choice: highWaterMark (stream buffering), singleUse (tls.connect sets it itself) and socket (an existing socket to
// wrap: a connection target, refused by the client's own createConnection/socketPath rows).
const NOT_TLS = ['highWaterMark', 'singleUse', 'socket'];
function nodeTlsOptions() {
  const src = `
    const tls = require('tls'); const net = require('net'); const sc = require('internal/tls/secure-context');
    const reads = (s) => [...s.matchAll(/\\boptions\\.([A-Za-z_]\\w*)/g)].map((m) => m[1]);
    const destructured = (s) => [...s.matchAll(/(?:const|let)\\s*\\{([^}]*)\\}\\s*=\\s*options/g)]
      .flatMap((m) => m[1].split(',').map((x) => x.trim().split(/[:=\\s]/)[0]).filter(Boolean));
    const tlsSrc = [tls.connect, tls.createSecureContext, sc.configSecureContext].map(String).join('\\n');
    const netSrc = [net.Socket, net.Socket.prototype.connect, net.connect].map(String).join('\\n');
    const netKeys = new Set(reads(netSrc));
    const names = new Set([...reads(tlsSrc), ...destructured(tlsSrc)].filter((k) => !netKeys.has(k)));
    console.log(JSON.stringify([...names].sort()));`;
  const r = spawnSync(process.execPath, ['--expose-internals', '-e', src], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `could not read node's TLS options from its own source:\n${r.stderr}`);
  return JSON.parse(r.stdout).filter((k) => !NOT_TLS.includes(k));
}

// The censuses are guards (test/guard.cjs): read() is the runtime's option names and the shim's tables, scan() names
// every option in neither, and each control is the real tables with one name dropped, which must go red.
function readNodeCensus() {
  const { TLS_OPTIONS_HONOURED, UNSUPPORTED_TLS_OPTIONS } = require(HTTP)._internals.tls;
  return { names: nodeTlsOptions(), honoured: TLS_OPTIONS_HONOURED, refused: UNSUPPORTED_TLS_OPTIONS };
}
guardTests(defineGuard({
  name: 'tls-option-census-node',
  floor: 30,
  read: readNodeCensus,
  scan({ names, honoured, refused }) {
    const findings = [];
    // a floor on the derivation itself, so a node whose source moved cannot pass this vacuously
    for (const k of ['ca', 'cert', 'key', 'servername', 'rejectUnauthorized', 'checkServerIdentity', 'crl', 'minVersion', 'pfx']) {
      if (!names.includes(k)) findings.push(`the derivation from node's source lost '${k}' (got ${names.join(', ')})`);
    }
    for (const k of honoured.filter((x) => refused.includes(x))) findings.push(`'${k}' is both honoured and refused`);
    for (const k of names.filter((x) => !honoured.includes(x) && !refused.includes(x))) {
      findings.push(`node reads TLS option '${k}' and node-shim's https client neither honours nor refuses it, so it `
        + 'IGNORES it (libexec/node-shim/modules/http.cjs TLS_OPTIONS_HONOURED / UNSUPPORTED_TLS_OPTIONS)');
    }
    return { findings, examined: names.length };
  },
  control() {
    const r = readNodeCensus();
    return { ...r, refused: r.refused.filter((k) => k !== 'crl') };
  },
}));

test('census: each refused TLS option throws ERR_SHIM_HTTPS_UNSUPPORTED_TLS_OPTION before any connection', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tls-refused-'));
  const f = path.join(dir, 'refused.cjs');
  fs.writeFileSync(f, `
const https = require('node:https');
const { UNSUPPORTED_TLS_OPTIONS } = require('node:http')._internals.tls;
const out = {};
for (const k of UNSUPPORTED_TLS_OPTIONS) {
  const v = /^(?:checkServerIdentity|pskCallback)$/.test(k) ? () => undefined : (/^(?:enableTrace|requestOCSP|honorCipherOrder|allowPartialTrustChain)$/.test(k) ? true : 'x');
  for (const where of ['request', 'agent']) {
    try {
      const o = { host: '127.0.0.1', port: 9, path: '/' };
      if (where === 'request') o[k] = v; else o.agent = new https.Agent({ [k]: v });
      https.request(o).on('error', () => {});
      out[k + '/' + where] = 'NOT REFUSED';
    } catch (e) { out[k + '/' + where] = e.code; }
  }
}
console.log(JSON.stringify(out));
`);
  try {
    const r = runLoader(f);
    assert.strictEqual(r.status, 0, r.stderr);
    for (const [k, code] of Object.entries(JSON.parse(r.stdout))) {
      assert.strictEqual(code, 'ERR_SHIM_HTTPS_UNSUPPORTED_TLS_OPTION', `TLS option ${k} was not refused by name`);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- Bun's tls option (fetch, WebSocket) --------------------------------------------------------------------------
function readBunCensus() {
  const native = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'bun-tls-option-reads-native.json'), 'utf8'));
  const { honoured, falseIsUnset, refused } = require(BUN_SHIM)._bunTlsKeys;
  return { native, named: [...honoured, ...falseIsUnset, ...refused] };
}
guardTests(defineGuard({
  name: 'tls-option-census-bun',
  floor: 20,
  read: readBunCensus,
  scan({ native, named }) {
    const findings = [];
    if (new Set(named).size !== named.length) findings.push("a key is in more than one of bun-shim's lists");
    for (const surface of ['fetch', 'WebSocket']) {
      for (const k of native[surface].filter((x) => !named.includes(x))) {
        findings.push(`native Bun's ${surface} reads tls key '${k}' and bun-shim neither honours nor refuses it, so it `
          + 'is IGNORED (libexec/bun-shim.cjs BUN_TLS_*)');
      }
    }
    // and nothing named that Bun does not read: a stale name would hide a renamed one
    for (const k of named.filter((x) => !native.fetch.includes(x))) findings.push(`bun-shim names '${k}', which Bun does not read`);
    return { findings, examined: Math.min(native.fetch.length, native.WebSocket.length) };
  },
  control() {
    const r = readBunCensus();
    return { ...r, named: r.named.filter((k) => k !== 'cert') };
  },
}));

test('bun-shim tls check: the default trust is honoured; anything it cannot apply is refused by name', () => {
  const { _checkBunTls } = require(BUN_SHIM);
  const tls = require('node:tls');
  const def = tls.getCACertificates('default');
  const url = 'https://api.example.test/v1';
  const refusal = (opts, option, u = url) => assert.throws(() => _checkBunTls(opts, u),
    (e) => e.code === 'ERR_CLODE_UNSUPPORTED_TLS_OPTION' && e.option === option, `expected tls.${option} refused`);
  // honoured
  for (const ok of [undefined, null, false, {}, { ca: def }, { ca: [...def].reverse() }, { ca: def.join('\n') },
    { rejectUnauthorized: true }, { serverName: 'api.example.test' }, { servername: 'API.example.test' },
    { requestCert: false, lowMemoryMode: false, allowPartialTrustChain: false }]) {
    assert.doesNotThrow(() => _checkBunTls(ok, url), `refused ${JSON.stringify(ok && Object.keys(ok))}`);
  }
  // an http: URL: Bun applies no tls at all
  assert.doesNotThrow(() => _checkBunTls({ cert: 'x', ca: ['nope'] }, 'http://127.0.0.1:1/'));
  // refused
  refusal({ ca: def.slice(1) }, 'ca');                                  // trusts one fewer than the engine would
  const another = def[0].replace(/(-----BEGIN CERTIFICATE-----\s*)(\S{8})/, (m, h, b) => h + (b === 'AAAAAAAA' ? 'BBBBBBBB' : 'AAAAAAAA'));
  assert.notStrictEqual(another, def[0]);
  refusal({ ca: [...def, another] }, 'ca');                             // and one more
  refusal({ cert: 'pem', key: 'pem' }, 'cert');
  refusal({ key: 'pem' }, 'key');
  refusal({ passphrase: 'p' }, 'passphrase');
  refusal({ checkServerIdentity: () => undefined }, 'checkServerIdentity');
  refusal({ rejectUnauthorized: false }, 'rejectUnauthorized');
  refusal({ serverName: 'other.example' }, 'serverName');
  refusal({ minVersion: 'TLSv1.3' }, 'minVersion');
  refusal({ caFile: '/etc/ssl/cert.pem' }, 'caFile');
  refusal({ requestCert: true }, 'requestCert');
  refusal({ cert: 'pem' }, 'cert', 'wss://api.example.test/ws');
});

test('_wsArgs: Bun tls keys become node tls.connect options for npm ws, or are refused', () => {
  const { _wsArgs } = require(BUN_SHIM);
  assert.deepStrictEqual(_wsArgs('wss://x', { tls: { serverName: 'x', ca: 'C', rejectUnauthorized: false, lowMemoryMode: false } }),
    ['wss://x', undefined, { servername: 'x', ca: 'C', rejectUnauthorized: false }]);
  assert.throws(() => _wsArgs('wss://x', { tls: { caFile: '/x' } }), { code: 'ERR_CLODE_UNSUPPORTED_TLS_OPTION' });
});

// ---- under the engine: fetch, setDefaultCACertificates, no XMLHttpRequest, axios ---------------------------------
test('engine: fetch honours tls.ca through the default trust, refuses another set, and axios keeps its agent', async (t) => {
  if (skipUnlessTjs(t) || !haveOpenssl(t)) return;
  let axiosPath = null;
  try { axiosPath = require.resolve('axios/dist/node/axios.cjs', { paths: [__dirname] }); } catch { /* row skipped below */ }
  const o = await startOrigins();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tls-fetch-'));
  const f = path.join(dir, 'fetch.cjs');
  fs.writeFileSync(f, `
require(${JSON.stringify(BUN_SHIM)});
const tls = require('node:tls'); const https = require('node:https'); const fs = require('node:fs');
const pki = JSON.parse(process.env.PROBE_PKI); const ports = JSON.parse(process.env.PROBE_PORTS);
const CA = fs.readFileSync(pki.ca.cert, 'utf8'); const CA2 = fs.readFileSync(pki.ca2.cert, 'utf8');
const url = 'https://127.0.0.1:' + ports.leaf + '/f';
const out = { xhr: typeof XMLHttpRequest };
const go = async (label, init) => {
  try { const r = await fetch(url, init); out[label] = r.status; await r.text(); }
  catch (e) { out[label] = e.code === 'ERR_CLODE_UNSUPPORTED_TLS_OPTION' ? 'refused:' + e.option : 'failed'; }
};
(async () => {
  await go('beforeSet', {});
  tls.setDefaultCACertificates([CA]);
  out.defaultIsSet = tls.getCACertificates('default').length;
  await go('afterSet', {});
  await go('caIsDefault', { tls: { ca: [CA] } });
  await go('caOther', { tls: { ca: [CA2] } });
  await go('clientCert', { tls: { ca: [CA], cert: 'x', key: 'y' } });
  tls.setDefaultCACertificates([CA2]);
  await go('afterReset', {});
  try { tls.setDefaultCACertificates(['no certificate here']); out.garbageSet = 'accepted'; } catch (e) { out.garbageSet = e.code; }
  if (process.env.AXIOS) {
    const axios = require(process.env.AXIOS);
    for (const [label, ca] of [['axiosNotInCa', CA2], ['axiosTrusted', CA]]) {
      try { const r = await axios.get(url, { maxRedirects: 0, httpsAgent: new https.Agent({ ca }) }); out[label] = r.status; }
      catch (e) { out[label] = e.code; }
    }
  }
  console.log(JSON.stringify(out)); process.exit(0);
})();
`);
  try {
    const env = { PROBE_PKI: JSON.stringify(o.pki), PROBE_PORTS: JSON.stringify(o.ports), ...(axiosPath ? { AXIOS: axiosPath } : {}) };
    const r = runLoader(f, [], { env, timeout: 60000 });
    assert.strictEqual(r.status, 0, r.stderr);
    const got = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.deepStrictEqual(got, {
      xhr: 'undefined',                 // node and native Bun have no XMLHttpRequest
      beforeSet: 'failed',              // the engine's compiled-in roots do not cover the test CA
      defaultIsSet: 1,
      afterSet: 200,                    // setDefaultCACertificates replaced fetch's trust
      caIsDefault: 200,                 // tls.ca = the default in force: honoured
      caOther: 'refused:ca',            // any other set: refused by name, not ignored
      clientCert: 'refused:cert',       // a client certificate fetch cannot present: refused
      afterReset: 'failed',             // replaced again: the test CA is no longer trusted
      garbageSet: 'ERR_CRYPTO_OPERATION_FAILED',
      ...(axiosPath ? { axiosNotInCa: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', axiosTrusted: 200 } : {}),
    });
    if (!axiosPath) t.diagnostic('axios is not installed under test/ (npm install --prefix test): the axios rows were not run');
  } finally { o.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- connect-multiple: a failed handshake ends the attempt, as node's does ----------------------------------------
test('connect-multiple: a TLS handshake failure is final, not a reason to try the next address', async () => {
  const { makeConnectMultiple } = require(path.join(REPO, 'libexec/node-shim/internal/connect-multiple.cjs'));
  const tried = [];
  const verifyFailure = Object.assign(new Error('X509 - Certificate verification failed'), { mbedtlsCode: -0x2700, verifyFlags: 8 });
  const { connectHost } = makeConnectMultiple({
    lookup: async () => [{ address: '10.0.0.1', family: 4 }, { address: '10.0.0.2', family: 4 }],
    connect: async (transport, address) => { tried.push(address); throw verifyFailure; },
  });
  await assert.rejects(connectHost('tls', 'example.test', 443, {}, {}), (e) => e === verifyFailure);
  assert.deepStrictEqual(tried, ['10.0.0.1']);
});
