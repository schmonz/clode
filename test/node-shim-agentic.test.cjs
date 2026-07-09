'use strict';
// Phase-3 agentic tool use under tjs: a scripted mock conversation drives the
// bundle's Bash tool end-to-end. Turn 1 answers the -p prompt with a tool_use
// (Bash: print a marker), the CLI executes it and POSTs back a tool_result,
// turn 2 answers with final text. The oracle: the tool_result carries the
// command's REAL stdout inline — not the "Output too large" persisted-file
// detour and not "<bash output unavailable ... (unknown)>", which is what a
// FileHandle without Symbol.asyncDispose degrades every Bash result to
// (bundle ≥2.1.204 reads the output file with `await using`; see
// modules/fs.cjs makeFileHandle and the dogfooding transcript that surfaced it).
// Hermetic; gated on tjs + CLODE_PROVIDER_BIN like the M3 round-trip.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { REPO, tjsPath, skipUnlessTjs, LOADER } = require('./node-shim-helper.cjs');
const { startMockAnthropic, cannedSSE, cannedToolUseSSE } = require('./mock-anthropic-helper.cjs');

function providerBin() { const p = process.env.CLODE_PROVIDER_BIN; return p && fs.existsSync(p) ? p : null; }
function stageBundle(bin) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3-agentic-'));
  const cli = path.join(dir, 'cli.cjs');
  execFileSync(process.execPath, [path.join(REPO, 'libexec/extract-claude-js.cjs'), bin, cli], { stdio: 'pipe' });
  fs.copyFileSync(path.join(REPO, 'libexec/bun-shim.cjs'), path.join(dir, 'bun-shim.cjs'));
  return { dir, cli };
}
// Async spawn (spawnSync would freeze the in-process mock — see node-shim-roundtrip.test.cjs).
function bootP(cli, dir, args, env, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(tjsPath(), ['run', LOADER, cli, ...args], {
      cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const to = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
    child.on('exit', (status) => { clearTimeout(to); resolve({ status, stdout, stderr }); });
    child.on('error', (e) => { clearTimeout(to); resolve({ status: null, stdout, stderr: String(e) }); });
  });
}

const MARKER = 'AGENTIC-MARKER-7391';
const TOOL_ID = 'toolu_mock_bash_1';

test('agentic Bash round-trip under tjs: tool_result carries real stdout inline', async (t) => {
  if (skipUnlessTjs(t)) return;
  const bin = providerBin();
  if (!bin) { t.skip('no CLODE_PROVIDER_BIN'); return; }
  // Key the scripted turns off request content, not POST order: side calls
  // (title generation etc.) also hit /messages, but only the main loop's
  // follow-up POST carries our tool_result id.
  const mock = await startMockAnthropic({
    respond: (body) => body.includes(TOOL_ID)
      ? cannedSSE('TOOLDONE')
      : cannedToolUseSSE('Bash', { command: `echo ${MARKER}` }, TOOL_ID),
  });
  try {
    const { cli, dir } = stageBundle(bin);
    const r = await bootP(cli, dir,
      ['-p', 'run the command', '--allowedTools', 'Bash'],
      {
        ...process.env,
        ANTHROPIC_BASE_URL: mock.url,
        ANTHROPIC_API_KEY: 'sk-ant-mock',              // dummy; NOT a secret
        NODE_PATH: path.join(REPO, 'node_modules'),
      }, 120000);
    assert.strictEqual(r.status, 0, `stderr:\n${r.stderr}`);
    assert.match(r.stdout, /TOOLDONE/, `stdout:\n${r.stdout}`);
    const followUp = mock.requests.find((q) => q.method === 'POST' && q.body && q.body.includes(TOOL_ID) && q.body.includes('tool_result'));
    assert.ok(followUp, 'no follow-up POST carrying the tool_result');
    assert.ok(followUp.body.includes(MARKER), `tool_result lacks the command's stdout:\n${followUp.body.slice(0, 2000)}`);
    assert.ok(!followUp.body.includes('bash output unavailable'), 'tool_result degraded to the output-file readback failure');
    assert.ok(!followUp.body.includes('Output too large'), 'tool_result degraded to the persisted-file detour');
  } finally { await mock.close(); }
});
