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
const { spawn } = require('node:child_process');
const { REPO, tjsPath, skipUnlessTjs, engineSpawn, LOADER } = require('./node-shim-helper.cjs');
const { startMockAnthropic, cannedSSE, cannedToolUseSSE } = require('./mock-anthropic-helper.cjs');
const { toolResult, toolResultText, assertFailsOnMissingOutput } = require('../scripts/lib/tool-result.cjs');
const { stageCli } = require('./oracle-models.cjs');

function providerBin() { const p = process.env.CLODE_PROVIDER_BIN; return p && fs.existsSync(p) ? p : null; }
function stageBundle(bin) {
  // realpathSync.NATIVE, because os.tmpdir() on a GitHub runner is an 8.3 SHORT path:
  // C:\Users\RUNNER~1\AppData\Local\Temp. Upstream Claude Code REFUSES to write to a
  // Windows path containing `~` without manual approval — verbatim from the tool_result:
  //
  //     "...which contains a suspicious Windows path pattern that requires manual
  //      approval."
  //
  // So the row failed on both Windows legs looking exactly like a FileHandle.chmod
  // regression, when quaude was faithfully reproducing an upstream SECURITY heuristic.
  // The Read in the same flow succeeded and --allowedTools already granted Edit; nothing
  // was broken.
  //
  // plain realpathSync does NOT expand short names — that was my first fix, and it failed
  // on Windows identically, still reporting RUNNER~1. `.native` asks the OS for the
  // canonical path, which is the long form. A real user's directory has no `~` in it, so
  // this makes the fixture match reality rather than smuggling in a test of upstream's
  // refusal heuristic under a row named for something else.
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'p3-agentic-')));
  // RATCHET, not decoration. If a `~` ever gets back into this path, upstream refuses the
  // write and the row fails with a message about FileHandle.chmod — which is how this
  // cost two CI cycles. Fail here instead, naming the real reason, on every platform.
  if (dir.includes('~')) {
    throw new Error(`agentic fixture path contains "~" (${dir}). Claude Code refuses such `
      + 'Windows paths without manual approval ("suspicious Windows path pattern"), so the '
      + 'row would fail as a phantom FileHandle.chmod regression. Resolve the path first.');
  }
  // ONE STAGING PATH for every oracle (test/oracle-models.cjs stageCli): clode's own
  // cached extraction, which merges upstream's residual cyclic requires. Spawning the raw
  // extractor here instead is what left both rows below dead on 2.1.243+ — the runner it
  // emits is not the runner any built target runs.
  const { cli } = stageCli(bin, { dir });
  return { dir, cli };
}
// Async spawn (spawnSync would freeze the in-process mock — see node-shim-roundtrip.test.cjs).
function bootP(cli, dir, args, env, timeoutMs) {
  return new Promise((resolve) => {
    const [ecmd, eargv] = engineSpawn(['run', LOADER, cli, ...args]);
    const child = spawn(ecmd, eargv, {
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

// Both rows judge the tool_result itself (scripts/lib/tool-result.cjs), never the follow-up
// body: that body also carries the tool_use, i.e. the command, and a raw slice of it truncates
// before the tool_result content anyway (it leads with the system prompt and prior turns),
// which is exactly where a failed atomic write reports its exception. Each judgment is one
// function, run first through assertFailsOnMissingOutput (it must FAIL with the output
// missing and the command text present) and then on the real mock.
//
// The marker is COMPUTED by the shell, so the output spells it and the command does not.
// The old check searched the whole body for `echo ${MARKER}`'s marker: it could not fail on
// missing output.
const MARKER = 'AGENTIC-MARKER-7391';
const BASH = { name: 'Bash', input: { command: 'echo AGENTIC-MARKER-$((7300+91))' }, id: 'toolu_mock_bash_1' };
const stdoutInline = (m) => {
  const out = toolResultText(m, BASH.id);
  return out.includes(MARKER) && !out.includes('bash output unavailable') && !out.includes('Output too large');
};

test('agentic Bash round-trip under tjs: tool_result carries real stdout inline', async (t) => {
  if (skipUnlessTjs(t)) return;
  const bin = providerBin();
  if (!bin) { t.skip('no CLODE_PROVIDER_BIN'); return; }
  assertFailsOnMissingOutput(stdoutInline, BASH);
  // Key the scripted turns off request content, not POST order: side calls
  // (title generation etc.) also hit /messages, but only the main loop's
  // follow-up POST carries our tool_result id.
  const mock = await startMockAnthropic({
    respond: (body) => body.includes(BASH.id)
      ? cannedSSE('TOOLDONE')
      : cannedToolUseSSE(BASH.name, BASH.input, BASH.id),
  });
  try {
    const { cli, dir } = stageBundle(bin);
    const r = await bootP(cli, dir,
      ['-p', 'run the command', '--allowedTools', 'Bash'],
      {
        ...process.env,
        ANTHROPIC_BASE_URL: mock.url,
        ANTHROPIC_API_KEY: 'sk-ant-mock',              // dummy; NOT a secret
        NODE_PATH: path.join(REPO, 'deps', 'claude', 'node_modules'),
      }, 120000);
    assert.strictEqual(r.status, 0, `stderr:\n${r.stderr}`);
    assert.match(r.stdout, /TOOLDONE/, `stdout:\n${r.stdout}`);
    assert.ok(stdoutInline(mock), 'tool_result lacks the command\'s stdout inline (missing, or degraded to the '
      + `output-file readback failure or the persisted-file detour): ${JSON.stringify(toolResultText(mock, BASH.id).slice(0, 2000))}`);
  } finally { await mock.close(); }
});

// Editing / overwriting an EXISTING file: the bundle's atomic write restores the
// original file mode via `await handle.chmod(...)` on a promises.open FileHandle.
// The shim FileHandle lacked chmod, so every Edit / Write-over-existing threw a
// bare "not a function" (quaude self-test 2026-07-19) while Write of a NEW file
// worked. Oracle: the file is actually mutated on disk, and the Edit tool_result
// is not the shim-gap error.
test('agentic Edit round-trip under tjs: overwriting an existing file works (FileHandle.chmod)', async (t) => {
  if (skipUnlessTjs(t)) return;
  const bin = providerBin();
  if (!bin) { t.skip('no CLODE_PROVIDER_BIN'); return; }
  const { cli, dir } = stageBundle(bin);
  const target = path.join(dir, 'edit-target.txt');
  fs.writeFileSync(target, 'hello world\nsecond line\n');
  const READ = { name: 'Read', input: { file_path: target }, id: 'toolu_read_edit' };
  const EDIT = { name: 'Edit', input: { file_path: target, old_string: 'world', new_string: 'universe' }, id: 'toolu_edit_edit' };
  // The Edit tool's own report of success, as the model reads it (2.1.283's carve returns
  // `The file ${path} has been updated successfully.`). The old row asserted only that the
  // result was NOT the shim-gap "not a function" error, which an empty or missing tool_result
  // also satisfies: assertFailsOnMissingOutput refused it.
  const editReported = (m) => {
    const r = toolResult(m, EDIT.id);
    return !!r && !r.isError && /has been updated successfully/.test(r.text);
  };
  assertFailsOnMissingOutput(editReported, EDIT);
  // Read (satisfy read-before-edit) -> Edit -> done, keyed off request content.
  const mock = await startMockAnthropic({
    respond: (body) =>
      body.includes(EDIT.id) ? cannedSSE('EDITDONE')
        : body.includes(READ.id) ? cannedToolUseSSE(EDIT.name, EDIT.input, EDIT.id)
          : cannedToolUseSSE(READ.name, READ.input, READ.id),
  });
  try {
    // --debug-to-stderr surfaces the bundle's atomic-write breadcrumbs (and any
    // exception it caught) so a failure on disk has a named cause, not silence.
    //
    // Tool permission comes from --allowedTools, exactly like the Bash row
    // above, and NOT from --dangerously-skip-permissions. That flag was an
    // incidental convenience here and it makes this row unrunnable as root:
    // the bundle refuses it outright — `if (typeof process.getuid === 'function'
    // && process.getuid() === 0 && process.env.IS_SANDBOX !== '1' &&
    // !CLAUDE_CODE_BUBBLEWRAP) { console.error('--dangerously-skip-permissions
    // cannot be used with root/sudo privileges for security reasons');
    // process.exit(1) }` (verbatim from the extracted 2.1.241 cli.js). The musl
    // reference leg runs in a node:24.18.1-alpine container as root, so this
    // row exited 1 before it ever reached an Edit — a startup refusal wearing
    // the costume of a FileHandle.chmod regression. --allowedTools grants the
    // same permission with no uid opinion, so the row now runs identically as
    // root and as a normal user.
    const r = await bootP(cli, dir,
      ['-p', 'edit the file', '--allowedTools', 'Read,Edit', '--debug', '--debug-to-stderr'],
      {
        ...process.env,
        ANTHROPIC_BASE_URL: mock.url,
        ANTHROPIC_API_KEY: 'sk-ant-mock',
        NODE_PATH: path.join(REPO, 'deps', 'claude', 'node_modules'),
      }, 120000);
    assert.strictEqual(r.status, 0, `stderr:\n${r.stderr}`);
    // Ground-truth oracle: the edit actually landed on disk. On failure, surface
    // what the Edit tool actually REPORTED — the tool_result CONTENT carries any
    // exception the atomic write threw (e.g. a chmod/rename error code, or the
    // FileHandle-shim-gap "not a function") so a platform-specific regression names
    // its own failing step instead of just "did not apply".
    const onDisk = fs.readFileSync(target, 'utf8');
    const edit = toolResult(mock, EDIT.id);
    const editContent = edit ? JSON.stringify({ content: edit.content, is_error: edit.isError }) : '<none>';
    assert.strictEqual(onDisk, 'hello universe\nsecond line\n',
      `Edit did not apply on disk.\n on-disk: ${JSON.stringify(onDisk)}\n`
      + ` Edit tool_result content: ${editContent}\n`
      + ` stderr tail:\n${(r.stderr || '').slice(-3000)}`);
    // And the Edit tool_result is the tool's success report, which the FileHandle-shim-gap
    // error ("not a function", is_error) is not.
    assert.ok(editReported(mock), `Edit tool_result is not the success report: ${editContent.slice(0, 800)}`);
  } finally { await mock.close(); }
});

// Regression guard for the provider-axis bug: a quaude carved from a LINUX
// provider still behaves as linux on macOS (reads /etc/claude-code for
// managed settings) even though it's running under a darwin engine. Only a
// quaude carved from a DARWIN provider takes the correct macOS branch
// (managed-settings under /Library/Application Support/ClaudeCode). `clode
// fetch` now picks the OS-matched provider (see the sibling fix), and this
// test locks that in end-to-end: stage a bundle from a real darwin `claude`
// binary, run it under the mock-agentic harness with --debug-to-stderr, and
// assert the debug log shows the macOS path and never the linux one.
// Gated: needs a tjs engine (skipUnlessTjs) AND a real darwin provider binary
// via CLODE_DARWIN_PROVIDER_BIN (this repo's own fetched provider is
// linux-x64, so this SKIPs on a linux-provider box — that's expected, not a
// failure).
test('a darwin-carved quaude takes the macOS branch (managed-settings under /Library)', async (t) => {
  if (skipUnlessTjs(t)) return;
  const bin = process.env.CLODE_DARWIN_PROVIDER_BIN;
  if (!bin || !fs.existsSync(bin)) {
    // Say WHICH carve we have and why it will not do, rather than naming an env var.
    // Substituting a nearer version to satisfy the platform is what made this test
    // silently run against 2.1.252 and fail on the SCC break the pin exists to avoid.
    const { platformSkipReason } = require('./provider-resolve.cjs');
    t.skip(platformSkipReason('darwin') || 'no CLODE_DARWIN_PROVIDER_BIN');
    return;
  }
  const { cli, dir } = stageBundle(bin);
  const mock = await startMockAnthropic({ respond: () => cannedSSE('hi') });
  try {
    const r = await bootP(cli, dir, ['-p', 'hi', '--debug', '--debug-to-stderr'],
      { ...process.env, ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: 'sk-ant-mock', NODE_PATH: path.join(REPO, 'deps', 'claude', 'node_modules') }, 120000);
    assert.strictEqual(r.status, 0, `stderr:\n${r.stderr}`);
    assert.match(r.stderr, /\/Library\/Application Support\/ClaudeCode/, 'darwin carve must use the macOS managed-settings path');
    assert.doesNotMatch(r.stderr, /\/etc\/claude-code/, 'darwin carve must NOT use the linux managed-settings path');
  } finally { await mock.close(); }
});
