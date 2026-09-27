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
const { toolResult, toolResultText, assertFailsOnMissingOutput } = require('../../scripts/lib/tool-result.cjs');

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
// Every tool row judges toolResultText(mock, id) (scripts/lib/tool-result.cjs): the model's
// view of the tool's output, and nothing else. NOT a substring search of the request body:
// every follow-up also carries the assistant's own tool_use block, so a marker spelled in the
// tool's INPUT (`pattern: MARK`, `echo A`) "came back" whether or not the tool ran (f4d763d;
// scripts/floor-probe.mjs's B1/B4 were corrected the same way in b4ff3f2). Each judgment is
// one function, run first through assertFailsOnMissingOutput (it must FAIL with the output
// missing and the command text present) and then on the real mock.

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

// This row's `--allowedTools Grep` sets upstream's searchToolsOptIn, which keeps the
// Grep and Glob tools even where upstream would otherwise swap them for `grep`/`find`
// via Bash. They are also kept under CLAUDE_CODE_ENTRYPOINT=local-agent, and on Windows
// without Git Bash; `--allowedTools Bash,Grep` keeps Grep, and `--disallowedTools Bash`
// still removes it (read from the 2.1.283 carve by the F4 review, 2026-09-27). In
// output_mode "content" the tool runs `rg --json` (from 2.1.251 on; not in .185/.218/
// .243/.246/.250), which the rg->ugrep translation refuses by design, so the tool
// answered "ripgrep not found on PATH" here. The old check passed anyway, on MARK in
// the tool_use's own `pattern`. When the refusal shows on stderr, this row can never
// count as a pass: it skips with that reason, even if a host rg on PATH answered
// instead (on a refusal _rewriteRgSpawn hands back the untranslated argv, so a host rg
// runs, which the rg-divergence rule forbids). Otherwise it asserts in full (BACKLOG.md,
// "The Grep tool in quaude").
const GREP_JSON_REFUSED = /rg→ugrep shim doesn't translate --json/;
const RG_NOT_FOUND = /^ripgrep not found on PATH\./;
test('agentic Grep round-trip under tjs: search-applet path returns the match', async (t) => {
  if (skipUnlessTjs(t)) return;
  const bin = providerBin(); if (!bin) { t.skip('no CLODE_PROVIDER_BIN'); return; }
  const { cli, dir } = stageBundle(bin);
  // The matched line carries a TAIL the pattern does not spell: content mode prints the whole
  // line, so the tail proves the tool searched the file. MARK alone could come back in a
  // tool_result that merely quoted the pattern (an rg error, say): assertFailsOnMissingOutput
  // refuses a check that looks for it.
  const TAIL = 'HAY-LINE-TAIL-5502';
  fs.writeFileSync(path.join(dir, 'hay.txt'), `alpha\n${MARK} ${TAIL}\ngamma\n`);
  const GREP = { name: 'Grep', input: { pattern: MARK, path: dir, output_mode: 'content' }, id: 'toolu_grep_1' };
  const found = (m) => toolResultText(m, GREP.id).includes(TAIL);
  assertFailsOnMissingOutput(found, GREP);
  const mock = await startMockAnthropic({
    respond: (body) => body.includes(GREP.id) ? cannedSSE('GREPDONE')
      : cannedToolUseSSE(GREP.name, GREP.input, GREP.id),
  });
  try {
    const r = await bootP(cli, dir, ['-p', 'find the needle', '--allowedTools', 'Grep'], mockEnv(dir, mock.url), 120000);
    assert.strictEqual(r.status, 0, `stderr:\n${r.stderr}`);
    const result = toolResultText(mock, GREP.id);
    assert.ok(result, 'no follow-up POST carrying the Grep tool_result');
    if (GREP_JSON_REFUSED.test(r.stderr)) {
      t.skip('the Grep tool runs `rg --json`, which the rg->ugrep translation refuses by design; '
        + (RG_NOT_FOUND.test(result)
          ? 'the tool answered "ripgrep not found on PATH"'
          : 'a host rg answered instead, which the rg-divergence rule forbids')
        + ' (BACKLOG.md: The Grep tool in quaude)');
      return;
    }
    assert.ok(found(mock), `Grep tool_result lacks the matched line:\n${result.slice(0, 1500)}`);
  } finally { await mock.close(); }
});

// H1 — multi-turn coherence: a 2-tool conversation loop (Bash echo A -> result
// -> Bash echo B -> result -> final). Both tool_results must carry their own
// stdout, in order — the turn loop stays coherent across turns under quaude.
// A and B are COMPUTED by the shell ($((40+2)), $((40+3))), so the output spells them and
// the commands do not: `echo ${A}` could pass on a tool_result that only quoted it.
test('agentic multi-turn under tjs: a 2-tool loop keeps both tool_results coherent', async (t) => {
  if (skipUnlessTjs(t)) return;
  const bin = providerBin(); if (!bin) { t.skip('no CLODE_PROVIDER_BIN'); return; }
  const { cli, dir } = stageBundle(bin);
  const A = `${MARK}-A42`, B = `${MARK}-B43`;
  const ONE = { name: 'Bash', input: { command: `echo ${MARK}-A$((40+2))` }, id: 'toolu_mt_1' };
  const TWO = { name: 'Bash', input: { command: `echo ${MARK}-B$((40+3))` }, id: 'toolu_mt_2' };
  const saidA = (m) => toolResultText(m, ONE.id).includes(A);
  const saidB = (m) => toolResultText(m, TWO.id).includes(B);
  assertFailsOnMissingOutput(saidA, ONE);
  assertFailsOnMissingOutput(saidB, TWO);
  const mock = await startMockAnthropic({
    respond: (body) => body.includes(TWO.id) ? cannedSSE('MULTIDONE')
      : body.includes(ONE.id) ? cannedToolUseSSE(TWO.name, TWO.input, TWO.id)
        : cannedToolUseSSE(ONE.name, ONE.input, ONE.id),
  });
  try {
    const r = await bootP(cli, dir, ['-p', 'run two commands', '--allowedTools', 'Bash'], mockEnv(dir, mock.url), 120000);
    assert.strictEqual(r.status, 0, `stderr:\n${r.stderr}`);
    assert.match(r.stdout, /MULTIDONE/, `did not reach the final turn:\n${r.stdout}`);
    assert.ok(saidA(mock), `turn-1 tool_result missing echo A: ${JSON.stringify(toolResultText(mock, ONE.id))}`);
    assert.ok(saidB(mock), `turn-2 tool_result missing echo B: ${JSON.stringify(toolResultText(mock, TWO.id))}`);
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
  const UPDATE = { name: 'Bash', input: { command: 'claude update' }, id: 'toolu_update_1' };
  const denied = (m) => /clode manages Claude Code|rebuilds itself/.test(toolResultText(m, UPDATE.id));
  assertFailsOnMissingOutput(denied, UPDATE);
  const mock = await startMockAnthropic({
    respond: (body) => body.includes(UPDATE.id) ? cannedSSE('HOOKDONE')
      : cannedToolUseSSE(UPDATE.name, UPDATE.input, UPDATE.id),
  });
  try {
    const r = await bootP(cli, dir,
      ['-p', 'update yourself', '--allowedTools', 'Bash', '--settings', settings],
      mockEnv(dir, mock.url), 120000);
    assert.strictEqual(r.status, 0, `stderr:\n${r.stderr}`);
    assert.ok(toolResult(mock, UPDATE.id), 'no follow-up POST carrying the Bash tool_result (hook path not reached)');
    // The PreToolUse deny reason (update-guard) must be surfaced in the tool_result,
    // and the command must NOT have actually run.
    assert.ok(denied(mock), `hook deny reason not in tool_result:\n${toolResultText(mock, UPDATE.id).slice(0, 1500)}`);
  } finally { await mock.close(); }
});
