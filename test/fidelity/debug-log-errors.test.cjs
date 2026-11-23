'use strict';
// quaude's --debug log, READ: the same -p turn under naude (node cli.cjs, the reference runtime) and quaude (tjs
// loader cli.cjs), each against a fresh mock, and quaude's log held to test/debug-log-scan.cjs's three checks: no
// shim-fault line at any level, no request-timeout line naude does not also log, no [ERROR] shape naude does not
// log unless KNOWN names it with its reason.
//
// WHY. Every gap this found was already printed in a debug log a driver produced and nobody read (debug-log-scan.cjs
// has the list). A row that only judges stdout passes a quaude whose telemetry, CA trust and first-party requests are
// all failing underneath, because the turn still answers PONG.
//
// THE NETWORK. ANTHROPIC_BASE_URL moves only the Messages traffic; 2.1.330's bootstrap, fast-mode probe, MCP
// registry and event export go to https://api.anthropic.com whatever it says (cn().BASE_API_URL is "prod" on every
// build), and with the mock's fake key that host answers 401. Both engines make those requests, so a request quaude
// never finishes shows up as a timeout shape naude does not have, and a request it never sends as an [ERROR] shape
// naude has and quaude does not (or the reverse), whichever host answers. Making them hermetic is not possible from
// here: a TLS-intercepting proxy works for naude, but node-shim's https cannot tunnel TLS through a proxy yet
// (measured 2026-11-23; its own branded refusal).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnCollect } = require('../spawn-collect.cjs');
const { throwawayHome } = require('../throwaway-home.cjs');
const { REPO, tjsPath, skipUnlessTjs, isApeFile, wantsTrampoline, LOADER } = require('../node-shim-helper.cjs');
const { startMockAnthropic, cannedSSE } = require('../mock-anthropic-helper.cjs');
const { findings, shape } = require('../debug-log-scan.cjs');

function providerBin() { const p = process.env.CLODE_PROVIDER_BIN; return p && fs.existsSync(p) ? p : null; }

// Quaude-only [ERROR] shapes, each a RULED or FILED divergence with where it is written down. Adding one is a decision.
const KNOWN = {
  [shape('2026-11-23T13:29:30.313Z [ERROR] [uds-messaging] Failed to create server: Error: quaude does not support the sandbox yet: net.createServer')]:
    'net.createServer is an honest throwing stub (USER ruling M1, 2026-11-18; test/shim-surface/golden.json, the '
    + 'http.request/net.createServer note): quaude serves no UDS messaging socket',
};

// THE RED RUNS, verbatim. The first two are from a live NetBSD/arm64 quaude --debug-file log (2026-11-23); the
// timeout lines are the Writable-without-_final hang as the bundle logged it; the connect line is this row's own
// first run on darwin-arm64 (2026-11-23), before connect-multiple stopped abandoning slow TLS handshakes.
const RED = {
  zlib: '2026-11-23T10:41:07.311Z [ERROR] 1P event logging: 181 events failed to export (node-shim: zlib.gzipSync not implemented (tjs has no native zlib; the -p mock path sends no compressed bodies))',
  x509: '2026-11-23T10:40:58.020Z [ERROR] CA certs: A bundled root does not parse: TypeError: not a function',
  bootstrap: '2026-11-23T10:41:03.118Z [DEBUG] [Bootstrap] Fetch failed: ECONNABORTED',
  axiosTimeout: '2026-11-23T10:41:03.119Z [ERROR] [Bootstrap] fetch failed: AxiosError: timeout of 5000ms exceeded',
  catalog: '2026-11-23T10:41:08.502Z [ERROR] [servedCatalog] fetch (org) failed: timeout',
  connect: '2026-11-23T13:25:06.533Z [ERROR] [Bootstrap] fetch failed: Error: ETIMEDOUT: connect ETIMEDOUT 160.79.104.10:443; EHOSTUNREACH: host is unreachable (api.anthropic.com:443)',
};
// What naude logs on the same turn (2026-11-23, darwin-arm64): none of it is a finding.
const NAUDE = [
  '2026-11-23T13:25:21.165Z [ERROR] Failed to save config with lock: Error: ENOENT: no such file or directory, lstat \'/private/var/folders/y5/x/T/errlog-cfg-DIH5JS/.claude.json\'',
  '2026-11-23T13:25:21.281Z [ERROR] 1P event logging: 5 events failed to export (this runtime has no Bun.FetchSession)',
  '2026-11-23T13:25:22.770Z [ERROR] [Bootstrap] fetch failed: AxiosError: Request failed with status code 401',
  '2026-11-23T13:25:22.787Z [DEBUG] [Bootstrap] Fetch failed: 401',
].join('\n');
const DEBUG_LINE = /^\S+ \[DEBUG\] /m;

test('the debug-log scan finds every red line, and nothing in what naude also logs', () => {
  const quaudeGreen = [
    '2026-11-23T13:29:30.072Z [ERROR] Failed to save config with lock: Error: ENOENT: no such file or directory, lstat \'/var/folders/y5/x/T/errlog-cfg-EflOvL/.claude.json\'',
    '2026-11-23T13:29:30.278Z [ERROR] 1P event logging: 9 events failed to export (this runtime has no Bun.FetchSession)',
    '2026-11-23T13:29:30.313Z [ERROR] [uds-messaging] Failed to create server: Error: quaude does not support the sandbox yet: net.createServer',
    '2026-11-23T13:29:30.899Z [ERROR] [Bootstrap] fetch failed: AxiosError: Request failed with status code 401',
  ].join('\n');
  assert.deepStrictEqual(findings({ quaude: quaudeGreen, naude: NAUDE, known: KNOWN }), { shimFaults: [], timeouts: [], newErrors: [] });
  const f = (line) => findings({ quaude: `${quaudeGreen}\n${line}`, naude: NAUDE, known: KNOWN });
  assert.deepStrictEqual(f(RED.zlib).shimFaults, [RED.zlib]);
  assert.deepStrictEqual(f(RED.x509).shimFaults, [RED.x509]);
  for (const k of ['bootstrap', 'axiosTimeout', 'catalog', 'connect']) assert.deepStrictEqual(f(RED[k]).timeouts, [RED[k]], k);
  for (const k of ['zlib', 'x509', 'axiosTimeout', 'catalog', 'connect']) assert.strictEqual(f(RED[k]).newErrors.length, 1, k);
  // the uds line is a finding unless KNOWN names it
  assert.strictEqual(findings({ quaude: quaudeGreen, naude: NAUDE }).newErrors.length, 1);
  // a timeout naude logs too is the network's, not quaude's
  assert.deepStrictEqual(findings({ quaude: RED.axiosTimeout, naude: RED.axiosTimeout.replace('5000', '5000') }).timeouts, []);
});

function run(cmd, args, dir, env, timeoutMs) {
  if (wantsTrampoline(process.platform, isApeFile(cmd))) { args = ['-c', '"$@"', 'sh', cmd, ...args]; cmd = '/bin/sh'; }
  return spawnCollect(cmd, args, { cwd: dir, env }, { timeoutMs });
}
async function engineRun(cmd, argv) {
  const { dir, cli } = require('../oracle-models.cjs').stageCli(providerBin());
  const mock = await startMockAnthropic({ respond: () => cannedSSE('PONG') });
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'debuglog-cfg-'));
  const env = { ...process.env, ...throwawayHome(`${dir}-home`), ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: 'sk-ant-mock',
    CLAUDE_CONFIG_DIR: configDir, NODE_PATH: path.join(REPO, 'deps', 'claude', 'node_modules') };
  try {
    const r = await run(cmd, [...argv(cli), '-p', 'hi', '--debug', '--debug-to-stderr'], dir, env, 120000);
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  } finally {
    await mock.close();
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

test('quaude\'s --debug log of a -p turn says nothing naude\'s does not', async (t) => {
  if (skipUnlessTjs(t)) return;
  if (!providerBin()) { t.skip('no CLODE_PROVIDER_BIN'); return; }
  const naude = await engineRun(process.execPath, (cli) => [cli]);
  const quaude = await engineRun(tjsPath(), (cli) => ['run', LOADER, cli]);
  assert.strictEqual(naude.status, 0, 'naude did not exit 0');
  assert.strictEqual(quaude.status, 0, 'quaude did not exit 0');
  assert.match(quaude.stdout, /PONG/);
  assert.match(naude.stderr, DEBUG_LINE, 'naude wrote no debug log, so there is nothing to compare against');
  assert.match(quaude.stderr, DEBUG_LINE, 'quaude wrote no debug log, so the checks below would read nothing');
  assert.deepStrictEqual(findings({ quaude: quaude.stderr, naude: naude.stderr, known: KNOWN }),
    { shimFaults: [], timeouts: [], newErrors: [] });
});
