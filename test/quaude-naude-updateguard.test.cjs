'use strict';
// Task 4 acceptance: the END-TO-END proof that a BUILT TARGET (quaude and
// naude) denies a model-issued `claude update` via the injected PreToolUse
// hook (Tasks 1-3, committed), while a benign command still runs.
//
// Mirrors test/quaude-build.test.cjs's build (host `clode build`) and
// test/clode-native.test.cjs's acceptance-3 mock-driven Bash-tool harness
// (startMockAnthropic + cannedToolUseSSE/cannedSSE). Builds BOTH kinds via the
// plain host `clode build` / `clode build --naude` — the simplest path that
// still produces a real, runnable target (the fused-under-native-builder path
// is proven separately by clode-native.test.cjs/quaude-naude-selfupdate.test.cjs
// and is not needed again here).
//
// THE CRUX FINDING (recorded here so it is not re-discovered): the model's
// Bash tool_use ALSO goes through Claude Code's own built-in "auto mode"
// safety classifier (a second, separate /messages call to a fast model) for
// commands its heuristics flag as non-trivial (e.g. `touch <path>` — but NOT
// `echo ...`, which is why the sibling oracles in quaude-build.test.cjs /
// clode-native.test.cjs, which only ever `echo`, never hit this). The mock
// here only answers the ONE conversation model, so that classifier call comes
// back looking like a tool_use SSE, the classifier can't parse it, and Claude
// Code degrades to a synthetic "temporarily unavailable" tool_result — a false
// ALLOW-side failure that has NOTHING to do with the update guard. Passing
// `--dangerously-skip-permissions` removes the classifier round-trip entirely
// (proven empirically below and manually beforehand): the ALLOW turn then
// really executes `touch`, and — the key confirmation — the DENY turn is
// UNCHANGED: the injected PreToolUse hook still fires and blocks the tool
// before it runs. This is exactly the intended contract (the guard cannot be
// bypassed by `--dangerously-skip-permissions`, matching how a real user
// session might be configured) and it also happens to be what makes the
// control (ALLOW) case observable under this mock.
//
// Gates (clean skips, never failures): no tjs binary; no CLODE_PROVIDER_BIN.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { tjsPath, REPO } = require('./node-shim-helper.cjs');
const { startMockAnthropic, cannedSSE, cannedToolUseSSE } = require('./mock-anthropic-helper.cjs');
const cpaths = require('../libexec/clode-paths.cjs');

const ENTRY = path.join(REPO, 'bin', 'clode');
function providerBin() { const p = process.env.CLODE_PROVIDER_BIN; return p && fs.existsSync(p) ? p : null; }

let SKIP = null;
let DIR = null, QUAUDE = null, NAUDE = null;
let QUAUDE_BUILD = null, NAUDE_BUILD = null, NAUDE_SKIP = null;

before(() => {
  if (!tjsPath()) { SKIP = 'no tjs binary (CLODE_TJS or build/tjs/tjs)'; return; }
  if (!providerBin()) { SKIP = 'no CLODE_PROVIDER_BIN'; return; }
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'updateguard-'));

  // -- quaude, via the plain host `clode build` (same as quaude-build.test.cjs).
  QUAUDE = path.join(DIR, 'quaude');
  QUAUDE_BUILD = spawnSync(process.execPath, [ENTRY, 'build', '--out', QUAUDE], {
    encoding: 'utf8',
    timeout: 300000,
    env: {
      ...process.env,
      CLODE_CLAUDE_BIN: providerBin(),
      CLODE_CACHE: path.join(DIR, 'quaude-cache'),
      CLODE_TJS: tjsPath(),
      DYLD_INSERT_LIBRARIES: '',
    },
  });

  // -- naude, via the plain host `clode build --naude`. Needs the pinned node
  // in a warm store first (`clode fetch --naude`, cheap/local when cached) —
  // any failure there (offline, no cache yet) narrows to a clean skip of the
  // naude cases only; the quaude cases are unaffected.
  const NODES = process.env.CLODE_NODES || cpaths.nodeStore(process.env);
  const fetchNode = spawnSync(process.execPath, [ENTRY, 'fetch', '--naude'], {
    encoding: 'utf8', timeout: 300000,
    env: { ...process.env, CLODE_NODES: NODES, DYLD_INSERT_LIBRARIES: '' },
  });
  if (fetchNode.status !== 0) {
    NAUDE_SKIP = `pinned node unavailable (offline?): ${fetchNode.stderr || fetchNode.stdout}`;
  } else {
    NAUDE = path.join(DIR, 'naude');
    NAUDE_BUILD = spawnSync(process.execPath, [ENTRY, 'build', '--naude', '--out', NAUDE], {
      encoding: 'utf8',
      timeout: 300000,
      env: {
        ...process.env,
        CLODE_CLAUDE_BIN: providerBin(),
        CLODE_CACHE: path.join(DIR, 'naude-cache'),
        CLODE_TJS: tjsPath(),
        CLODE_NODES: NODES,
        DYLD_INSERT_LIBRARIES: '',
      },
    });
    // NAUDE_BUILD.status !== 0 is NOT folded into NAUDE_SKIP: with the gates
    // open (tjs + provider + a fetched pinned node) an actual build failure is
    // a real bug, not an environment gap — it must FAIL the precondition test
    // below, not skip silently.
  }
});
after(() => { if (DIR) { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } } });

// Async spawn (never spawnSync — the in-process mock must stay serviceable
// while the child runs; same rationale as the sibling e2e harnesses).
function runTarget(bin, args, env, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd: DIR, stdio: ['ignore', 'pipe', 'pipe'], env });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const to = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
    child.on('exit', (status) => { clearTimeout(to); resolve({ status, stdout, stderr }); });
    child.on('error', (e) => { clearTimeout(to); resolve({ status: null, stdout, stderr: String(e) }); });
  });
}
function cleanEnv(extra) {
  const env = { ...process.env, ...extra };
  delete env.NODE_PATH;   // the fused/baked target must be self-contained
  return env;
}

// Extract the assistant-turn tool_result content block for toolId from a
// follow-up POST body (the Messages request the CLI sends back carrying the
// tool's outcome). Returns { content, isError } or null if not found.
function toolResultFrom(body, toolId) {
  let parsed;
  try { parsed = JSON.parse(body); } catch { return null; }
  for (const msg of parsed.messages || []) {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === 'tool_result' && block.tool_use_id === toolId) {
        return { content: block.content, isError: !!block.is_error };
      }
    }
  }
  return null;
}

// Drives ONE Bash-tool turn against `bin`: the mock returns a single Bash
// tool_use of `command`, then (once the CLI's follow-up POST carrying the
// tool_result arrives) a final "TOOLDONE" text turn. Returns
// { run: {status,stdout,stderr}, toolResult: {content,isError}|null }.
// --dangerously-skip-permissions is REQUIRED here (see file header): it
// removes Claude Code's own auto-mode safety-classifier round-trip, which the
// single-conversation mock cannot answer and which is unrelated to the guard
// under test; the guard's PreToolUse deny fires regardless of this flag.
async function driveBashTurn(bin, command, toolId) {
  const mock = await startMockAnthropic({
    respond: (body) => body.includes(toolId)
      ? cannedSSE('TOOLDONE')
      : cannedToolUseSSE('Bash', { command }, toolId),
  });
  try {
    const env = cleanEnv({ ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: 'sk-ant-mock' });
    const run = await runTarget(bin,
      ['-p', 'run the command', '--allowedTools', 'Bash', '--dangerously-skip-permissions'],
      env, 60000);
    const followUp = mock.requests.find((q) => q.method === 'POST' && q.body
      && q.body.includes(toolId) && q.body.includes('tool_result'));
    const toolResult = followUp ? toolResultFrom(followUp.body, toolId) : null;
    return { run, toolResult };
  } finally { await mock.close(); }
}

function runUpdateGuardAcceptance(t, kind, bin, skipReason) {
  if (SKIP) { t.skip(SKIP); return; }
  if (skipReason) { t.skip(skipReason); return; }
  return (async () => {
    // -- DENY: the model issues `claude update`, chained with a `touch` whose
    // sole purpose is to prove the WHOLE Bash call never ran (a deny reason
    // alone doesn't rule out a shell that ran and merely got told "no" after
    // the fact — the file's absence is definitive).
    const markerDenied = path.join(DIR, `${kind}-MARKER-DENIED-${Date.now()}`);
    const denyId = `toolu_${kind}_deny`;
    const deny = await driveBashTurn(bin, `claude update; touch ${markerDenied}`, denyId);
    assert.strictEqual(deny.run.status, 0, `${kind} deny-turn run failed:\nstdout:\n${deny.run.stdout}\nstderr:\n${deny.run.stderr}`);
    assert.match(deny.run.stdout, /TOOLDONE/, `${kind} deny-turn stdout:\n${deny.run.stdout}`);
    // Definitive: the command never ran.
    assert.ok(!fs.existsSync(markerDenied), `${kind}: MARKER_DENIED exists — claude update's Bash call was NOT blocked`);
    // Corroborating: the guard's actual deny reason surfaced to the model.
    assert.ok(deny.toolResult, `${kind}: no tool_result found for the deny turn`);
    assert.strictEqual(deny.toolResult.isError, true, `${kind}: deny tool_result was not is_error`);
    assert.match(String(deny.toolResult.content), /clode manages Claude Code/,
      `${kind}: deny tool_result did not carry the guard's reason: ${deny.toolResult.content}`);

    // -- CONTROL: a benign command must still be ALLOWED (the guard denies
    // ONLY update/reinstall commands, not everything).
    const markerOk = path.join(DIR, `${kind}-MARKER-OK-${Date.now()}`);
    const okId = `toolu_${kind}_ok`;
    const allow = await driveBashTurn(bin, `touch ${markerOk}`, okId);
    assert.strictEqual(allow.run.status, 0, `${kind} control-turn run failed:\nstdout:\n${allow.run.stdout}\nstderr:\n${allow.run.stderr}`);
    assert.match(allow.run.stdout, /TOOLDONE/, `${kind} control-turn stdout:\n${allow.run.stdout}`);
    assert.ok(fs.existsSync(markerOk), `${kind}: MARKER_OK does not exist — a benign Bash command was blocked`);
    assert.ok(allow.toolResult, `${kind}: no tool_result found for the control turn`);
    assert.strictEqual(allow.toolResult.isError, false, `${kind}: control tool_result reported an error: ${allow.toolResult.content}`);
  })();
}

test('quaude: `clode build` fuses it (precondition for the acceptance below)', (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  assert.strictEqual(QUAUDE_BUILD.status, 0, `clode build failed:\n${QUAUDE_BUILD.stdout}\n${QUAUDE_BUILD.stderr}`);
});

test('quaude: a model-issued `claude update` is DENIED (file marker proves the shell never ran); a benign command is ALLOWED', (t) => {
  return runUpdateGuardAcceptance(t, 'quaude', QUAUDE, null);
});

test('naude: `clode build --naude` builds it (precondition for the acceptance below)', (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  if (NAUDE_SKIP) { t.skip(NAUDE_SKIP); return; }
  assert.strictEqual(NAUDE_BUILD.status, 0, `clode build --naude failed:\n${NAUDE_BUILD.stdout}\n${NAUDE_BUILD.stderr}`);
});

test('naude: a model-issued `claude update` is DENIED (file marker proves the shell never ran); a benign command is ALLOWED', (t) => {
  return runUpdateGuardAcceptance(t, 'naude', NAUDE, NAUDE_SKIP);
});
