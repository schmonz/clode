'use strict';
// H6 — subagent/Task dispatch, as a TRUE three-engine differential (the recipe's
// localization model in a test): run the SAME Task scenario under naude (node
// cli.cjs) AND quaude (tjs loader cli.cjs), each against a fresh mock, and assert
// the Task tool_result carries the subagent's answer and is IDENTICAL on both.
//
// Until 2026-09-27 this row deliberately compared two ERRORS: the -p+mock "hits an
// auto-mode safety gate the same way in both", so no Agent ever ran and the row passed on
// identical refusals. On the dev Mac (2026-09-27) that gate came from the operator's own
// ~/.claude settings (defaultMode auto), which the row inherited. A check that passes when no
// subagent ran cannot fail on a subagent that is broken, and one was: see TOO_MANY_CAPTURES
// below. The row now runs in a fresh config dir, asks for a synchronous agent, and judges the
// answer.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { REPO, tjsPath, skipUnlessTjs, isApeFile, wantsTrampoline, LOADER } = require('../node-shim-helper.cjs');
const { startMockAnthropic, cannedSSE, cannedToolUseSSE } = require('../mock-anthropic-helper.cjs');
const { toolResult, toolResultText, assertFailsOnMissingOutput } = require('../../scripts/lib/tool-result.cjs');

function providerBin() { const p = process.env.CLODE_PROVIDER_BIN; return p && fs.existsSync(p) ? p : null; }
const TASK_ID = 'toolu_task_diff_1';
const SUBTOKEN = 'SUBDIFF-PROMPT-77', SUBANSWER = 'SUBDIFF-ANSWER-77';
// `run_in_background: false`: at 2.1.283 "Agents run in the background by default" (the
// tool's own schema text), and a background launch answers with launch metadata (a random
// agentId, an output file), never the subagent's answer. A synchronous agent hands its answer
// back in the tool_result.
const TASK = { name: 'Task', input: { description: 'delegate', prompt: `answer with ${SUBTOKEN}`, subagent_type: 'general-purpose', run_in_background: false }, id: TASK_ID };
// The Task tool_result must carry the SUBAGENT'S answer (SUBANSWER, which only the mock's
// reply to the subagent spells), judged on the tool_result (scripts/lib/tool-result.cjs). The
// old row only required naude's result to be truthy and quaude's to equal it; an empty
// tool_result serialises to '""', which is truthy, so two engines that both lost the answer
// passed: assertFailsOnMissingOutput refused that check. On this box they both had: see the
// config-dir note in engineRun.
const answered = (m) => toolResultText(m, TASK.id).includes(SUBANSWER);
// What must match byte for byte, less the two parts a synchronous Agent tool_result varies
// per run BY DESIGN (measured on naude, 2.1.283, 2026-09-27): the agentId, random, spelled
// twice (`agentId: X` and `to: 'X'`), and the wall-clock `duration_ms`. Normalised here and
// nowhere else.
function handBack(m) {
  const r = toolResult(m, TASK.id);
  const s = JSON.stringify(r ? { content: r.content, isError: r.isError } : null);
  const id = (/agentId: ([0-9a-f]+)/.exec(s) || [])[1];
  return (id ? s.split(id).join('<agentId>') : s).replace(/duration_ms: \d+/g, 'duration_ms: <ms>');
}
// quaude cannot finish a subagent at 2.1.283 (measured 2026-09-27, --debug-to-stderr): the
// completion path compiles a RegExp with more capture groups than QuickJS allows (254: its
// CAPTURE_COUNT_MAX is 255, counting the whole match), and QuickJS's regexp compiler refuses
// it ("SyntaxError: too many captures"; V8 and JSC accept it). On 2.1.283 that regex is the
// carve's bracketedLeadScrubPattern (`get lead()` -> `_No`); this row does not check which
// regex it is, only the error. naude hands the answer back. The row skips on exactly that
// tool_result, after proving naude's carries the answer, and asserts in full otherwise
// (BACKLOG.md, "quaude's Agent tool: too many captures").
const TOO_MANY_CAPTURES = /^too many captures$/;

// THROUGH CLODE'S OWN STAGING (../oracle-models.cjs's stageCli), not the raw
// extractor directly. The raw libexec/extract-claude-js.cjs emits the graph
// EXACTLY as upstream shipped it, residual cyclic
// `import.meta.require("/$bunfs/root/chunk-….js")` edges and all; only clode's
// staging (libexec/clode-extract.cjs) merges those away. This file used to call
// the raw extractor directly and died on the first residual require — see
// oracle-models.cjs's own header for the full incident (five CI jobs at once).
function stage(bin) {
  const { dir, cli } = require('../oracle-models.cjs').stageCli(bin);
  return { dir, cli };
}
function run(cmd, args, dir, env, timeoutMs) {
  // A cosmo APE engine can't be execve'd on non-Windows — wrap it in the /bin/sh
  // ENOEXEC trampoline, on POSIX only (node-shim-helper.cjs's wantsTrampoline).
  // On win32 every PE is 'MZ'-headed — node.exe (the naude side) and tjs.exe
  // alike — so the magic alone would send BOTH sides to a /bin/sh Windows does
  // not have; the same misfire failed CI runs 30675029624 and 36039332441.
  if (wantsTrampoline(process.platform, isApeFile(cmd))) { args = ['-c', '"$@"', 'sh', cmd, ...args]; cmd = '/bin/sh'; }
  return new Promise((res) => {
    const c = spawn(cmd, args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env });
    let so = '', se = ''; c.stdout.on('data', (d) => so += d); c.stderr.on('data', (d) => se += d);
    const to = setTimeout(() => c.kill('SIGKILL'), timeoutMs);
    c.on('exit', (s) => { clearTimeout(to); res({ status: s, stdout: so, stderr: se }); });
    c.on('error', (e) => { clearTimeout(to); res({ status: null, stdout: so, stderr: String(e) }); });
  });
}
async function engineRun(cmd, argv) {
  const bin = providerBin();
  const { dir, cli } = stage(bin);
  const mock = await startMockAnthropic({
    respond: (body) => (body.includes('"tool_result"') && body.includes(TASK.id)) ? cannedSSE('TASKDONE')
      : body.includes(SUBTOKEN) ? cannedSSE(SUBANSWER)
        : cannedToolUseSSE(TASK.name, TASK.input, TASK.id),
  });
  // A FRESH CONFIG DIR per run, never the operator's ~/.claude. Inheriting it let the
  // operator's own settings decide what this row measured: with `"defaultMode": "auto"` there
  // (this box, 2026-09-27) every Task call went to upstream's auto-mode safety classifier,
  // which this one-conversation mock cannot answer, and BOTH engines returned the same
  // "...is temporarily unavailable, so auto mode cannot determine the safety of Agent..."
  // tool_result. The old byte-equality check passed on those two identical errors, with no
  // subagent ever dispatched; judging the tool_result for the subagent's answer found it.
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subdiff-cfg-'));
  const env = { ...process.env, ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: 'sk-ant-mock',
    CLAUDE_CONFIG_DIR: configDir, NODE_PATH: path.join(REPO, 'deps', 'claude', 'node_modules') };
  const r = await run(cmd, [...argv(cli), '-p', 'delegate the work', '--allowedTools', 'Task'], dir, env, 90000);
  fs.rmSync(configDir, { recursive: true, force: true });
  const result = { status: r.status, done: /TASKDONE/.test(r.stdout), requests: mock.requests };
  await mock.close();
  return result;
}

test('subagent (Task) dispatch is identical under naude and quaude', async (t) => {
  if (skipUnlessTjs(t)) return;
  if (!providerBin()) { t.skip('no CLODE_PROVIDER_BIN'); return; }
  assertFailsOnMissingOutput(answered, TASK);
  const naude = await engineRun(process.execPath, (cli) => [cli]);
  const quaude = await engineRun(tjsPath(), (cli) => ['run', LOADER, cli]);
  assert.strictEqual(naude.status, 0, 'naude did not exit 0');
  assert.strictEqual(quaude.status, 0, 'quaude did not exit 0');
  assert.ok(naude.done && quaude.done, 'both engines must reach the final turn');
  assert.ok(answered(naude), `naude's Task tool_result lacks the subagent's answer: ${JSON.stringify(toolResultText(naude, TASK.id))}`);
  const q = toolResult(quaude, TASK.id);
  if (q && q.isError && TOO_MANY_CAPTURES.test(q.text)) {
    t.skip('quaude\'s Agent tool answers "too many captures": a regex on the Agent completion path has more '
      + 'capture groups than QuickJS allows (254); naude hands the answer back '
      + '(BACKLOG.md: quaude\'s Agent tool: too many captures)');
    return;
  }
  assert.ok(answered(quaude), `quaude's Task tool_result lacks the subagent's answer: ${JSON.stringify(toolResultText(quaude, TASK.id))}`);
  assert.strictEqual(handBack(quaude), handBack(naude), 'quaude Task tool_result must byte-match naude');
});
