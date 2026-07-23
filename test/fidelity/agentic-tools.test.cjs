'use strict';
// Discovery pass — agentic tool round-trips beyond Bash/Edit (which
// test/node-shim-agentic.test.cjs already covers). Drives the real extracted
// bundle under tjs+shim against a mock Anthropic, scripting one tool_use per
// test, and asserts the CLIENT-OBSERVABLE (a file created on disk / the
// tool_result content sent back) — node is the reference for "correct". Gated on
// a tjs binary + CLODE_PROVIDER_BIN.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { REPO, tjsPath, skipUnlessTjs, LOADER } = require('../node-shim-helper.cjs');
const { startMockAnthropic, cannedSSE, cannedToolUseSSE } = require('../mock-anthropic-helper.cjs');

function providerBin() { const p = process.env.CLODE_PROVIDER_BIN; return p && fs.existsSync(p) ? p : null; }
function stageBundle(bin) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agtool-'));
  const cli = path.join(dir, 'cli.cjs');
  execFileSync(process.execPath, [path.join(REPO, 'libexec/extract-claude-js.cjs'), bin, cli], { stdio: 'pipe' });
  fs.copyFileSync(path.join(REPO, 'libexec/bun-shim.cjs'), path.join(dir, 'bun-shim.cjs'));
  return { dir, cli };
}
function bootP(cli, dir, args, env, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(tjsPath(), ['run', LOADER, cli, ...args], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const to = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
    child.on('exit', (status) => { clearTimeout(to); resolve({ status, stdout, stderr }); });
    child.on('error', (e) => { clearTimeout(to); resolve({ status: null, stdout, stderr: String(e) }); });
  });
}
function mockEnv(dir, url) {
  return { ...process.env, ANTHROPIC_BASE_URL: url, ANTHROPIC_API_KEY: 'sk-ant-mock', NODE_PATH: path.join(REPO, 'deps', 'claude', 'node_modules') };
}
function followUpFor(mock, id) {
  return mock.requests.find((q) => q.method === 'POST' && q.body && q.body.includes(id) && q.body.includes('tool_result'));
}

const MARK = 'AGT-NEEDLE-5501';

test('agentic Write round-trip under tjs: the tool creates the file on disk', async (t) => {
  if (skipUnlessTjs(t)) return;
  const bin = providerBin(); if (!bin) { t.skip('no CLODE_PROVIDER_BIN'); return; }
  const { cli, dir } = stageBundle(bin);
  const target = path.join(dir, 'written.txt');
  const ID = 'toolu_write_1';
  const mock = await startMockAnthropic({
    respond: (body) => body.includes(ID) ? cannedSSE('WRITEDONE')
      : cannedToolUseSSE('Write', { file_path: target, content: `content ${MARK}\n` }, ID),
  });
  try {
    const r = await bootP(cli, dir, ['-p', 'write the file', '--allowedTools', 'Write'], mockEnv(dir, mock.url), 120000);
    assert.strictEqual(r.status, 0, `stderr:\n${r.stderr}`);
    assert.ok(fs.existsSync(target), 'Write tool did not create the file on disk');
    assert.match(fs.readFileSync(target, 'utf8'), new RegExp(MARK), 'file content missing the marker');
  } finally { await mock.close(); }
});

test('agentic Grep round-trip under tjs: search-applet path returns the match', async (t) => {
  if (skipUnlessTjs(t)) return;
  const bin = providerBin(); if (!bin) { t.skip('no CLODE_PROVIDER_BIN'); return; }
  const { cli, dir } = stageBundle(bin);
  fs.writeFileSync(path.join(dir, 'hay.txt'), `alpha\n${MARK}\ngamma\n`);
  const ID = 'toolu_grep_1';
  const mock = await startMockAnthropic({
    respond: (body) => body.includes(ID) ? cannedSSE('GREPDONE')
      : cannedToolUseSSE('Grep', { pattern: MARK, path: dir, output_mode: 'content' }, ID),
  });
  try {
    const r = await bootP(cli, dir, ['-p', 'find the needle', '--allowedTools', 'Grep'], mockEnv(dir, mock.url), 120000);
    assert.strictEqual(r.status, 0, `stderr:\n${r.stderr}`);
    const followUp = followUpFor(mock, ID);
    assert.ok(followUp, 'no follow-up POST carrying the Grep tool_result');
    assert.match(followUp.body, new RegExp(MARK), `Grep tool_result lacks the match:\n${followUp.body.slice(0, 1500)}`);
  } finally { await mock.close(); }
});

// H4 — a PreToolUse(Bash) hook fires under quaude and denies (dogfood: the
// update-guard). Exercises settings loading (--settings), hook matching, hook
// COMMAND spawn (a child process reading the hook-input JSON), and the deny
// contract — all through the shim. The hook wrapper reuses the real
// update-guard.cjs guardVerdict, so a Bash `claude update` is denied.
test('agentic hook (PreToolUse) fires and denies a model-issued `claude update` under tjs', async (t) => {
  if (skipUnlessTjs(t)) return;
  const bin = providerBin(); if (!bin) { t.skip('no CLODE_PROVIDER_BIN'); return; }
  const { cli, dir } = stageBundle(bin);
  const hook = path.join(dir, 'hook.cjs');
  fs.writeFileSync(hook, `'use strict';
const { guardVerdict } = require(${JSON.stringify(path.join(REPO, 'libexec/update-guard.cjs'))});
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  let cmd = '';
  try { const j = JSON.parse(input); cmd = (j.tool_input && j.tool_input.command) || ''; } catch (_) {}
  const v = guardVerdict(cmd);
  if (v) process.stdout.write(JSON.stringify(v));
  process.exit(0);
});`);
  const settings = path.join(dir, 'guard-settings.json');
  fs.writeFileSync(settings, JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `${process.execPath} ${hook}` }] }] },
  }));
  const ID = 'toolu_update_1';
  const mock = await startMockAnthropic({
    respond: (body) => body.includes(ID) ? cannedSSE('HOOKDONE')
      : cannedToolUseSSE('Bash', { command: 'claude update' }, ID),
  });
  try {
    const r = await bootP(cli, dir,
      ['-p', 'update yourself', '--allowedTools', 'Bash', '--settings', settings],
      mockEnv(dir, mock.url), 120000);
    assert.strictEqual(r.status, 0, `stderr:\n${r.stderr}`);
    const followUp = followUpFor(mock, ID);
    assert.ok(followUp, 'no follow-up POST carrying the Bash tool_result (hook path not reached)');
    // The PreToolUse deny reason (update-guard) must be surfaced in the tool_result,
    // and the command must NOT have actually run.
    assert.match(followUp.body, /clode manages Claude Code|rebuilds itself/, `hook deny reason not in tool_result:\n${followUp.body.slice(0, 1500)}`);
  } finally { await mock.close(); }
});
