'use strict';
// Windows PE-trailer fuse acceptance: the cross-fused quaude.exe self-loads
// (tx1k1 trailer -> VFS members) and completes a turn, on a REAL Windows kernel.
// Gated on CLODE_QUAUDE_EXE (the fused binary) + CLODE_PROVIDER_BIN (mock turn).
// Spawns quaude.exe DIRECTLY — it self-loads, no loader/cli args (unlike the
// non-fused roundtrip oracle, test/node-shim-roundtrip.test.cjs, which spawns
// `tjs run loader cli`). Skips locally (no Windows / no fused binary).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');
const { startMockAnthropic } = require('./mock-anthropic-helper.cjs');

function quaudeExe() { const p = process.env.CLODE_QUAUDE_EXE; return p && fs.existsSync(p) ? p : null; }

function bootQuaude(exe, args, env, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const to = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
    child.on('exit', (status) => { clearTimeout(to); resolve({ status, stdout, stderr }); });
    child.on('error', (e) => { clearTimeout(to); resolve({ status: null, stdout, stderr: String(e) }); });
  });
}

test('fused quaude.exe --clode-version self-loads and boots', (t) => {
  const exe = quaudeExe();
  if (!exe) { t.skip('no CLODE_QUAUDE_EXE'); return; }
  const r = spawnSync(exe, ['--clode-version'], { encoding: 'utf8', timeout: 60000 });
  assert.strictEqual(r.status, 0, `stderr:\n${r.stderr}`);
  assert.match(r.stdout, /clode|quaude/i, `--clode-version stdout:\n${r.stdout}`);
});

test('fused quaude.exe -p prints PONG through the VFS module path', async (t) => {
  const exe = quaudeExe();
  if (!exe) { t.skip('no CLODE_QUAUDE_EXE'); return; }
  if (!process.env.CLODE_PROVIDER_BIN) { t.skip('no CLODE_PROVIDER_BIN'); return; }
  const mock = await startMockAnthropic();
  try {
    const r = await bootQuaude(exe, ['-p', 'say PONG'], {
      ...process.env,
      ANTHROPIC_BASE_URL: mock.url,
      ANTHROPIC_API_KEY: 'sk-ant-mock',   // dummy; NOT a secret
    }, 120000);
    assert.strictEqual(r.status, 0, `stderr:\n${r.stderr}`);
    assert.match(r.stdout, /PONG/, `stdout:\n${r.stdout}`);
  } finally { await mock.close(); }
});
