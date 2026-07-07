'use strict';
// The wall-walk oracle: host node running the REAL staged cli.cjs -p 'say PONG'
// against the local mock prints "PONG" and exits 0. This locks the offline
// contract the tjs boot (Task 4) must reproduce byte-for-byte. SKIPs unless a
// real provider binary is present (CLODE_PROVIDER_BIN — fetched in M2 Task 1).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { REPO } = require('./node-shim-helper.cjs');
const { startMockAnthropic } = require('./mock-anthropic-helper.cjs');

function providerBin() {
  const p = process.env.CLODE_PROVIDER_BIN;
  return p && fs.existsSync(p) ? p : null;
}

// Stage cli.cjs + bun-shim.cjs together, mirroring M2 Task 5's staging.
function stageBundle(bin) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm3-stage-'));
  const cli = path.join(dir, 'cli.cjs');
  execFileSync(process.execPath, [path.join(REPO, 'libexec/extract-claude-js.cjs'), bin, cli], { stdio: 'pipe' });
  fs.copyFileSync(path.join(REPO, 'libexec/bun-shim.cjs'), path.join(dir, 'bun-shim.cjs'));
  return { dir, cli };
}

// Run the child asynchronously (NOT spawnSync): the mock Anthropic server lives
// in THIS process, and spawnSync blocks the parent's entire event loop until
// the child exits — which means the mock's http.Server can never accept/handle
// the child's connection, so the child hangs forever waiting for a response
// that is never sent. A minimal repro (a same-process http server + a
// spawnSync'd client hitting it) reproduces this deadlock with no bundle
// involved at all, confirming it is a spawnSync/event-loop property, not an
// SSE-format bug. spawn() keeps this process's event loop free to service the
// mock while we await the child's exit.
function run(cli, args, opts) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: opts.cwd, env: opts.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, opts.timeout || 60000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ status: code, stdout, stderr });
    });
  });
}

test('oracle: host node cli.cjs -p prints the mock response', async (t) => {
  const bin = providerBin();
  if (!bin) { t.skip('no CLODE_PROVIDER_BIN (fetch a real darwin-arm64 binary — see M2 Task 1)'); return; }
  const mock = await startMockAnthropic();
  try {
    const { cli, dir } = stageBundle(bin);
    const r = await run(cli, ['-p', 'say PONG'], {
      cwd: dir,
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: mock.url,
        ANTHROPIC_API_KEY: 'sk-ant-mock',            // dummy; the mock ignores it. NOT a secret.
        NODE_PATH: path.join(REPO, 'node_modules'),
        CLODE_ENGINE: '',                            // oracle is plain node, not the tjs branch
      },
      timeout: 60000,
    });
    assert.strictEqual(r.status, 0, `stderr:\n${r.stderr}`);
    assert.match(r.stdout, /PONG/, `stdout was:\n${r.stdout}`);
    assert.ok(mock.requests.some((q) => q.method === 'POST' && /\/messages$/.test(q.url.split('?')[0])),
      `bundle never POSTed the messages endpoint; hit: ${JSON.stringify(mock.requests.map((q) => q.method + ' ' + q.url))}`);
  } finally {
    await mock.close();
  }
});
