'use strict';
// WEBFETCH END TO END: the WebFetch tool's print cell in a built quaude, judged against native (every-tool plan; the
// release-candidate report of 2026-11-20).
//
// WHAT HAPPENED. On a NetBSD/arm64 release candidate, a real -p turn asked to fetch https://www.netbsd.org; WebFetch
// answered "Network Error" and the model fell back to curl through Bash. Measured on darwin-arm64 the same day: the
// engine's TLS (mbedtls 3.6, TLS 1.2 and 1.3 both on) offers rsa_pss_rsae_* signatures in its ClientHello, and a
// TLS-1.2-only server (Fastly, which serves www.netbsd.org and cdn.netbsd.org) signs its ServerKeyExchange with
// rsa_pss_rsae_sha256; the client then rejected the algorithm it had offered with a fatal illegal_parameter alert,
// so every fetch and XMLHttpRequest to such a host failed ("mbedtls connect -1 5 0"), and axios, the bundle's
// WebFetch transport (its XHR adapter under tjs), reported only "Network Error". Fixed in the engine for every leg
// (scripts/build-tjs.cjs fixupMbedtlsTls12RsaPss). Nothing drove WebFetch before this file: it was exempt.
//
// THE TURN. One -p turn of one WebFetch call (test/tool-driver.cjs driveTool) to a LOCAL https target that speaks
// TLS 1.2 only and signs with rsa_pss_rsae_sha256, the shape that broke. WebFetch upgrades http: to https:, so the
// target must be TLS, with a self-signed certificate each side trusts through NODE_EXTRA_CA_CERTS (native's own; a
// built quaude honours it since libexec/quaude-bootstrap.mjs applyExtraCaCerts, before which it could trust no
// private CA at all). The upstream domain preflight (api.anthropic.com's domain_info) is skipped by the bundle's own
// setting, skipWebFetchPreflight, and every request leaves through a proxy that does not exist except to 127.0.0.1
// (NO_PROXY), so nothing in this turn can reach the network.
//
// WHAT IS JUDGED. WebFetch hands the page to a second model request, the one that spells the WebFetch prompt; the mock
// answers it with the page's own token, WF-PAGE-<nonce>, read out of that request, and the tool_result is that answer.
// The nonce is in no tool_use input, so the check (`fetched`) passes only when the page's bytes reached the model.
// MEASURED 2026-11-20 on darwin-arm64: native 2.1.283 answers exactly that; a quaude from the engine without the fix
// answered "Network Error", and the target saw no request.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { execFileSync } = require('node:child_process');
const { driveTool } = require('../tool-driver.cjs');
const { builtQuaude } = require('../built-binary.cjs');
const { rgOracle, rgOracleSkip } = require('../provider-resolve.cjs');
const { toolResultText, assertFailsOnMissingOutput } = require('../../scripts/lib/tool-result.cjs');

const NONCE = crypto.randomBytes(6).toString('hex');
const PAGE_TOKEN = `WF-PAGE-${NONCE}`;
const ASK = 'WF-SUMMARIZE-7';
const REPLY = `the page says ${PAGE_TOKEN}`;
// url is filled in once the target listens (its port)
const USE = { name: 'WebFetch', input: { url: '', prompt: `${ASK}: what does the page say?` }, id: 'toolu_wf_fetch' };
// The second request's answer: the page's token as that request carries it, or a refusal naming its absence.
const summarize = (seen) => { const m = /WF-PAGE-[0-9a-f]{12}/.exec(seen); return m ? `the page says ${m[0]}` : 'the page carried no WF-PAGE token'; };
const fetched = (m) => toolResultText(m, USE.id) === REPLY;

// A self-signed certificate for 127.0.0.1, made here (openssl, as test/mock-anthropic-helper.cjs's tls mock does), so
// no key is committed.
function selfSigned(dir) {
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1',
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'pipe' });
  return { key, cert };
}

// THE TARGET: TLS 1.2 only, signing with rsa_pss_rsae_sha256 (the www.netbsd.org shape), serving one small page.
async function startTarget(dir) {
  const { key, cert } = selfSigned(dir);
  const seen = [];
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert),
    maxVersion: 'TLSv1.2', sigalgs: 'rsa_pss_rsae_sha256' }, (req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<html><head><title>WebFetch target</title></head><body><h1>Fetched</h1><p>${PAGE_TOKEN}</p></body></html>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `https://127.0.0.1:${server.address().port}/page`, cert, seen, close: () => new Promise((r) => server.close(r)) };
}

// A port nothing listens on: the proxy every non-local request is sent to, so none leaves the box.
async function deadPort() {
  const net = require('node:net');
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  return port;
}

async function turn(side, bin) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'webfetch-')));
  const target = await startTarget(dir);
  USE.input.url = target.url;
  const proxy = `http://127.0.0.1:${await deadPort()}`;
  try {
    const r = await driveTool({
      script: [{ tool: USE, subagent: { prompt: ASK, reply: summarize } }],
      args: ['--settings', JSON.stringify({ skipWebFetchPreflight: true })],
      env: { NODE_EXTRA_CA_CERTS: target.cert, HTTPS_PROXY: proxy, https_proxy: proxy, HTTP_PROXY: proxy, http_proxy: proxy,
        ALL_PROXY: '', all_proxy: '', NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' },
      ...(side === 'quaude' ? { quaude: bin, nativeSkip: 'native is judged against the same answer by the next test' }
        : { native: bin, quaudeSkip: 'quaude is judged by the test above' }),
    });
    return { side: r[side], seen: target.seen.slice() };
  } finally {
    await target.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function findings(label, { side, seen }) {
  const out = [];
  if (side.status !== 0) out.push(`${label}: the turn exited ${side.status}${side.signal ? ` (${side.signal})` : ''}: ${side.stderr.slice(0, 800)}`);
  if (!fetched(side.raw)) out.push(`${label}: WebFetch answered ${JSON.stringify(toolResultText(side.raw, USE.id))}, not ${JSON.stringify(REPLY)}`);
  if (!seen.includes('GET /page')) out.push(`${label}: the target saw ${JSON.stringify(seen)}, not GET /page`);
  return out;
}

const SKIP = process.platform === 'win32' ? 'the target\'s certificate is made with openssl, which a Windows runner need not have' : false;

test('WebFetch in a built quaude fetches a TLS 1.2, rsa_pss_rsae_sha256 page as native does', { skip: SKIP }, async (t) => {
  const q = builtQuaude();
  if (q.skip) { t.skip(q.skip); return; }
  assertFailsOnMissingOutput(fetched, USE);
  const got = findings('quaude', await turn('quaude', q.path));
  assert.deepStrictEqual(got, [], got.join('\n'));
});

// THE INSTRUMENT: native itself, the same turn, wherever a native runs.
test('native fetches the same page and answers as recorded', { skip: SKIP }, async (t) => {
  const native = rgOracle(process.env);
  if (!native) { t.skip(rgOracleSkip(process.env)); return; }
  const got = findings('native', await turn('native', native));
  assert.deepStrictEqual(got, [], `native moved:\n${got.join('\n')}`);
});
