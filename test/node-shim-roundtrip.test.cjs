'use strict';
// M3 milestone under tjs: (1) the OFFLINE mock round-trip — cli.cjs -p 'say PONG'
// boots under tjs against the local mock, prints PONG, exit 0 (hermetic; gated on
// tjs + provider bin). (2) the LIVE finale — real api.anthropic.com, gated on
// CLODE_LIVE_ROUNDTRIP=1 + a real ANTHROPIC_API_KEY; never captures the key.
//
// DIVERGENCE FROM PLAN (Task 5): the boot is driven with ASYNC child_process.spawn,
// NOT spawnSync. spawnSync blocks THIS process's event loop, which freezes the
// in-process mock server so it can never answer the child's POST /v1/messages ->
// deadlock. Async spawn keeps the parent loop live (and mirrors how real clode
// launches the bundle: libexec/clode-run.cjs spawns + forwards signals, never
// spawnSync). stdin is 'ignore' (== `< /dev/null`) so -p does not block on it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { REPO, tjsPath, skipUnlessTjs, LOADER } = require('./node-shim-helper.cjs');
const { startMockAnthropic } = require('./mock-anthropic-helper.cjs');

function providerBin() { const p = process.env.CLODE_PROVIDER_BIN; return p && fs.existsSync(p) ? p : null; }
function stageBundle(bin) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-rt-'));
  const cli = path.join(dir, 'cli.cjs');
  execFileSync(process.execPath, [path.join(REPO, 'libexec/extract-claude-js.cjs'), bin, cli], { stdio: 'pipe' });
  fs.copyFileSync(path.join(REPO, 'libexec/bun-shim.cjs'), path.join(dir, 'bun-shim.cjs'));
  return { dir, cli };
}
// Drive the staged bundle under tjs via async spawn; resolve {status,stdout,stderr,ms}.
function bootP(cli, dir, env, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(tjsPath(), ['run', LOADER, cli, '-p', 'say PONG'], {
      cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const to = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
    child.on('exit', (status) => { clearTimeout(to); resolve({ status, stdout, stderr, ms: Date.now() - t0 }); });
    child.on('error', (e) => { clearTimeout(to); resolve({ status: null, stdout, stderr: String(e), ms: Date.now() - t0 }); });
  });
}

test('mock round-trip under tjs: -p prints PONG, exit 0', async (t) => {
  if (skipUnlessTjs(t)) return;
  const bin = providerBin();
  if (!bin) { t.skip('no CLODE_PROVIDER_BIN'); return; }
  const mock = await startMockAnthropic();
  try {
    const { cli, dir } = stageBundle(bin);
    const r = await bootP(cli, dir, {
      ...process.env,
      ANTHROPIC_BASE_URL: mock.url,
      ANTHROPIC_API_KEY: 'sk-ant-mock',              // dummy; NOT a secret
      NODE_PATH: path.join(REPO, 'node_modules'),
    }, 90000);
    assert.strictEqual(r.status, 0, `stderr:\n${r.stderr}`);
    assert.match(r.stdout, /PONG/, `stdout:\n${r.stdout}`);
    assert.ok(mock.requests.some((q) => q.method === 'POST' && /\/messages$/.test(q.url.split('?')[0])), 'no messages POST recorded');
  } finally { await mock.close(); }
});

// The LIVE finale. SKIPs unless explicitly opted in AND a key is present. The
// key is read from the environment at run time and NEVER read into a variable
// that is logged, asserted on, or written anywhere.
test('LIVE finale: -p against api.anthropic.com (opt-in)', async (t) => {
  if (skipUnlessTjs(t)) return;
  if (process.env.CLODE_LIVE_ROUNDTRIP !== '1') { t.skip('set CLODE_LIVE_ROUNDTRIP=1 to run the live finale'); return; }
  if (!process.env.ANTHROPIC_API_KEY) { t.skip('no ANTHROPIC_API_KEY in env'); return; }
  const bin = providerBin();
  if (!bin) { t.skip('no CLODE_PROVIDER_BIN'); return; }
  const { cli, dir } = stageBundle(bin);
  const env = { ...process.env, NODE_PATH: path.join(REPO, 'node_modules') };
  delete env.ANTHROPIC_BASE_URL;                        // real endpoint
  const r = await bootP(cli, dir, env, 120000);
  assert.strictEqual(r.status, 0, `stderr:\n${r.stderr}`);
  assert.match(r.stdout, /PONG/i, `stdout:\n${r.stdout}`);
  // Timing only — no key, no headers echoed.
  console.log(`LIVE round-trip: exit 0, ${r.ms}ms, stdout bytes=${Buffer.byteLength(r.stdout)}`);
});
