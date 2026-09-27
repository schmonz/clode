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
const { spawn } = require('node:child_process');
const { REPO, tjsPath, skipUnlessTjs, engineSpawn, LOADER } = require('../node-shim-helper.cjs');
const { startMockAnthropic, cannedSSE, cannedToolUseSSE } = require('../mock-anthropic-helper.cjs');

function providerBin() { const p = process.env.CLODE_PROVIDER_BIN; return p && fs.existsSync(p) ? p : null; }
// THROUGH CLODE'S OWN STAGING (../oracle-models.cjs's stageCli), not the raw
// extractor directly. The raw libexec/extract-claude-js.cjs emits the graph
// EXACTLY as upstream shipped it, residual cyclic
// `import.meta.require("/$bunfs/root/chunk-….js")` edges and all; only clode's
// staging (libexec/clode-extract.cjs) merges those away. This file used to call
// the raw extractor directly and died on the first residual require — see
// oracle-models.cjs's own header for the full incident (five CI jobs at once).
function stageBundle(bin) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agtool-'));
  const { cli } = require('../oracle-models.cjs').stageCli(bin, { dir });
  return { dir, cli };
}
function bootP(cli, dir, args, env, timeoutMs) {
  return new Promise((resolve) => {
    const [ecmd, eargv] = engineSpawn(['run', LOADER, cli, ...args]);
    const child = spawn(ecmd, eargv, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env });
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
// The text of the tool_result the target sent back for tool_use `id`: the model's
// view of the tool's output, and nothing else. NOT a substring search of the request
// body: every follow-up also carries the assistant's own tool_use block, so a marker
// spelled in the tool's INPUT (`pattern: MARK`, `echo A`) "came back" whether or not
// the tool ran. scripts/floor-probe.mjs's B1/B4 were corrected the same way (b4ff3f2).
function toolResultText(mock, id) {
  let out = '';
  for (const q of mock.requests) {
    let j;
    try { j = JSON.parse(q.body || ''); } catch { continue; }
    for (const m of (j && Array.isArray(j.messages) ? j.messages : [])) {
      for (const b of (Array.isArray(m && m.content) ? m.content : [])) {
        if (!b || b.type !== 'tool_result' || b.tool_use_id !== id) continue;
        out += typeof b.content === 'string' ? b.content
          : (Array.isArray(b.content) ? b.content.map((c) => (c && c.text) || '').join('') : '');
      }
    }
  }
  return out;
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

// The Grep tool still exists at 2.1.283 when the Bash tool does not (upstream swaps
// Grep/Glob for `grep`/`find` via Bash only when Bash is present), which is this row's
// `--allowedTools Grep`. There it now runs `rg --json`, and the rg->ugrep translation
// refuses --json by design (RgTranslateError: rg-only output, no faithful ugrep form),
// so the tool answers "ripgrep not found on PATH". Measured 2026-09-27; the old check
// passed anyway because it matched MARK in the tool_use's own `pattern`. The row skips
// on exactly that proven signature and asserts in full otherwise (BACKLOG.md, "the
// Grep tool fails in quaude at 2.1.283").
const GREP_JSON_REFUSED = /rg→ugrep shim doesn't translate --json/;
const RG_NOT_FOUND = /^ripgrep not found on PATH\./;
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
    const result = toolResultText(mock, ID);
    assert.ok(result, 'no follow-up POST carrying the Grep tool_result');
    if (RG_NOT_FOUND.test(result) && GREP_JSON_REFUSED.test(r.stderr)) {
      t.skip('the Grep tool runs `rg --json`, which the rg->ugrep translation refuses by design; '
        + 'the tool answered "ripgrep not found on PATH" (BACKLOG.md: the Grep tool fails in quaude at 2.1.283)');
      return;
    }
    assert.match(result, new RegExp(MARK), `Grep tool_result lacks the match:\n${result.slice(0, 1500)}`);
  } finally { await mock.close(); }
});

// H1 — multi-turn coherence: a 2-tool conversation loop (Bash echo A -> result
// -> Bash echo B -> result -> final). Both tool_results must carry their own
// stdout, in order — the turn loop stays coherent across turns under quaude.
test('agentic multi-turn under tjs: a 2-tool loop keeps both tool_results coherent', async (t) => {
  if (skipUnlessTjs(t)) return;
  const bin = providerBin(); if (!bin) { t.skip('no CLODE_PROVIDER_BIN'); return; }
  const { cli, dir } = stageBundle(bin);
  const ID1 = 'toolu_mt_1', ID2 = 'toolu_mt_2';
  const A = MARK + '-A', B = MARK + '-B';
  const mock = await startMockAnthropic({
    respond: (body) => body.includes(ID2) ? cannedSSE('MULTIDONE')
      : body.includes(ID1) ? cannedToolUseSSE('Bash', { command: `echo ${B}` }, ID2)
        : cannedToolUseSSE('Bash', { command: `echo ${A}` }, ID1),
  });
  try {
    const r = await bootP(cli, dir, ['-p', 'run two commands', '--allowedTools', 'Bash'], mockEnv(dir, mock.url), 120000);
    assert.strictEqual(r.status, 0, `stderr:\n${r.stderr}`);
    assert.match(r.stdout, /MULTIDONE/, `did not reach the final turn:\n${r.stdout}`);
    const r1 = toolResultText(mock, ID1), r2 = toolResultText(mock, ID2);
    assert.ok(r1.includes(A), `turn-1 tool_result missing echo A: ${JSON.stringify(r1)}`);
    assert.ok(r2.includes(B), `turn-2 tool_result missing echo B: ${JSON.stringify(r2)}`);
  } finally { await mock.close(); }
});

// H3 — --continue restores the prior session's context. Establish a token in
// turn 1, then --continue turn 2: the turn-2 request to the model must replay
// turn-1's message (session persisted + restored) under quaude. Hermetic
// CLAUDE_CONFIG_DIR so the session lives in a temp dir shared across both runs.
test('agentic --continue restores the prior session context under tjs', async (t) => {
  if (skipUnlessTjs(t)) return;
  const bin = providerBin(); if (!bin) { t.skip('no CLODE_PROVIDER_BIN'); return; }
  const { cli, dir } = stageBundle(bin);
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'sesscfg-'));
  const TOKEN = `${MARK}-SESSION`;
  const mock = await startMockAnthropic({ respond: () => cannedSSE('TURNDONE') });
  try {
    const env = { ...mockEnv(dir, mock.url), CLAUDE_CONFIG_DIR: cfg };
    const r1 = await bootP(cli, dir, ['-p', `remember this token: ${TOKEN}`], env, 120000);
    assert.strictEqual(r1.status, 0, `turn1 stderr:\n${r1.stderr}`);
    const after1 = mock.requests.length;
    const r2 = await bootP(cli, dir, ['--continue', '-p', 'what token did I give you?'], env, 120000);
    assert.strictEqual(r2.status, 0, `turn2 stderr:\n${r2.stderr}`);
    const turn2 = mock.requests.slice(after1);
    assert.ok(turn2.some((q) => q.body && q.body.includes(TOKEN)),
      `--continue did not replay turn-1 context (token ${TOKEN} absent from turn-2 requests)`);
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
    assert.ok(followUpFor(mock, ID), 'no follow-up POST carrying the Bash tool_result (hook path not reached)');
    // The PreToolUse deny reason (update-guard) must be surfaced in the tool_result,
    // and the command must NOT have actually run.
    const result = toolResultText(mock, ID);
    assert.match(result, /clode manages Claude Code|rebuilds itself/, `hook deny reason not in tool_result:\n${result.slice(0, 1500)}`);
  } finally { await mock.close(); }
});
