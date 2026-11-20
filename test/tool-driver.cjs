'use strict';
require('./suite-home.cjs');   // the suite's own HOME, also for a standalone `node --test` (ruling G33)
// tool-driver.cjs: THE ONE HARNESS a tool driver runs its turn through (every-tool plan, Task 1).
//
// THE SHAPE the drivers already shared (agentic-grep-glob, agentic-tools, node-shim-agentic, agentic-subagent-diff):
// a fixture tree in a temp dir; a canned mock (test/mock-anthropic-helper.cjs) whose `respond` scripts one tool_use per
// follow-up, the first call whose id the request does not yet carry, then a closing text turn; one `-p` turn of the
// target with the tool named in --allowedTools, ANTHROPIC_BASE_URL at the mock and a mock key, in a home of its own;
// the target's exit status; and the tool_result read through scripts/lib/tool-result.cjs, by the call's id. Then the
// same turn by native Claude Code, over the same tree, compared (the fidelity doctrine). Each file wrote that by hand.
//
// driveTool(opts) -> Promise<{ base, quaude: SIDE | { skipped } | { absent }, native: SIDE | { skipped } | { absent } }>
//
// THE VERDICT is the caller's controlled check on the request log: `assert.ok(check(r.quaude.raw))`, the same `check`
// it handed assertFailsOnMissingOutput. SIDE.text is for diagnostics and for comparing quaude with native, never the
// verdict: a judgment on .text is a judgment no control was run over.
//   opts.tool        the tool_use { name, input, id } the mock scripts. Spell it `tool: USE` in the caller, and keep the
//                    control there: assertFailsOnMissingOutput(check, USE) with check reading toolResultText(m, USE.id),
//                    judged on SIDE.raw. Both gates read the CALLER's file (a script, a check or a control in this
//                    file is invisible to them), and `tool: USE` is the mock rule they read as the scripting.
//   opts.script      instead of tool: several calls, [{ tool: A }, { tool: B }], scripted one per follow-up, in order.
//                    A rule may add `inputFrom: (log) => input`: the input SENT is computed from the request log so far
//                    (the turn's earlier tool_results, read with toolResultText), for a call that names what an earlier
//                    call made at run time (TaskStop names the id a background Bash answered with). The rule's
//                    tool.input stays what the control is given; SIDE.sent records what was sent.
//   opts.base        an absolute temp dir the caller made, so a tool_use input can name paths under it before the
//                    turn (Read's file_path is absolute). The default is a fresh one, removed when both sides are
//                    done. The caller removes its own.
//   opts.setup       (work, base) => void: lays the fixture in <base>/work, the turn's working directory. Run before
//                    EACH side, on a fresh <base>/work, so both sides see the same tree at the same paths and a
//                    tool_result needs no path rewriting to compare.
//   opts.inspect     (work, base) => any: run after each side's turn, before the next side wipes the tree (what a
//                    Write left on disk); its value is SIDE.inspected.
//   opts.args        more CLI arguments, after `-p <prompt>` and --allowedTools (--add-dir, --permission-mode, ...).
//   opts.allowedTools  the --allowedTools value: the scripted tools' names by default; null passes none (the
//                    `unlisted` cell).
//   opts.prompt      the -p prompt ('drive the tool').
//   opts.env         extra environment for both sides (SHELL, say). It may not name HOME, USERPROFILE, or any CLAUDE* or
//                    ANTHROPIC* key (CLAUDE_CONFIG_DIR, ANTHROPIC_BASE_URL among them): those are the sandbox and the
//                    mock, and a driver that overrode one would quietly run against the developer's home or a real
//                    API. Refused, as a bad nativeSkip is. Nothing of the caller's own CLAUDE*/ANTHROPIC* environment
//                    reaches the turn either: a run from inside a Claude Code session carries CLAUDE_CODE_ENTRYPOINT
//                    and friends, which change which tools register.
//   opts.switches    Claude Code switches for both sides, ONLY the keys TOOL_SWITCHES lists (each with its reason);
//                    any other key is refused. RESERVED_ENV stays as strict: a switch is not a way round it.
//   opts.quaude      the quaude binary; default the one built from this tree (test/built-binary.cjs builtQuaude()).
//                    When there is none, quaude is { absent: <why> } and nothing is run.
//   opts.quaudeSkip  a one-line reason not to run quaude this time (a test that measures native alone): { skipped }.
//   opts.native      the native binary; default the pinned provider WHEN IT RUNS here (test/provider-resolve.cjs
//                    rgOracle: CI's suite rows hold a minimised carve that cannot run; never a `claude` from PATH).
//                    One that is not there, or does not run, is { absent: <why> }.
//   opts.nativeSkip  a one-line reason native CANNOT run this turn (a credential-bound path): native is
//                    { skipped: reason } and is not run. The fidelity doctrine asks for the reason, so '' is refused.
//   TWO FIELDS ON PURPOSE: `skipped` is the caller's decision, `absent` is this box's. A driver that compares with
//   native treats { absent } as a precondition failure (skip by name, which a CI job then judges), never as the
//   comparison passing.
//   opts.timeoutMs   per side (240 s).
// SIDE = { text, isError, result, results, raw, sent, status, signal, stdout, stderr, timedOut, home, inspected }
//   text/isError/result  the FIRST scripted call's tool_result (toolResult: { text, isError, content }, or null and
//                    text '' when the target sent none). Never the tool_use's input.
//   results          every scripted call's toolResult, by id.
//   raw              the mock's request log, { requests, tmp }: what a check given to assertFailsOnMissingOutput reads.
//   home             the side's own { HOME, USERPROFILE, CLAUDE_CONFIG_DIR, CLAUDE_CODE_TMPDIR }, under <base>/<side>
//                    (test/throwaway-home.cjs).
//   tmp              the side's CLAUDE_CODE_TMPDIR (where a background task's output goes); also raw.tmp.
//
// HERMETIC by construction: each side runs with a HOME, CLAUDE_CONFIG_DIR and CLAUDE_CODE_TMPDIR under <base>/<side>,
// fresh per run, so no turn reads or writes the caller's ~/.claude or the box's shared /tmp/claude-<uid> (the agentic
// rows that inherit them are a recorded defect, BACKLOG "Ten agentic rows run the developer's own ~/.claude"). Output
// is collected on 'close' (test/spawn-collect.cjs).
//
// WHAT IT DOES NOT DO: judge. It returns what each side's model saw; the caller's check decides, and the caller
// compares quaude's with native's. It drives the built binary, not the bundle under the dev loader.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnCollect } = require('./spawn-collect.cjs');
const { throwawayHome } = require('./throwaway-home.cjs');
const { startMockAnthropic, cannedSSE, cannedToolUseSSE } = require('./mock-anthropic-helper.cjs');
const { toolResult, toolResultText } = require('../scripts/lib/tool-result.cjs');

const DONE = 'TOOL-DRIVER-DONE';
// Keys opts.env may not set: the sandbox (HOME, USERPROFILE, CLAUDE*) and the mock (ANTHROPIC*).
const RESERVED_ENV = /^(?:HOME|USERPROFILE|CLAUDE.*|ANTHROPIC.*)$/i;
// THE ONLY Claude Code switches a driver may set (opts.switches), each with why a driver needs it. Never the sandbox
// or the mock: a key here is a product switch that changes which tools register, nothing else.
const TOOL_SWITCHES = Object.freeze({
  CLAUDE_CODE_ENABLE_TASKS: 'the Task* tools register unless it is "false" (then TodoWrite does): every-tool Phase B '
    + 'drives TodoWrite with it off, and a Task* driver may pin it on',
});
const isToolUse = (u) => !!u && typeof u.name === 'string' && !!u.name && typeof u.id === 'string' && !!u.id
  && !!u.input && typeof u.input === 'object';

// The rules the mock walks, each { tool }: opts.script, or opts itself for a single opts.tool.
function rulesOf(opts) {
  const rules = Array.isArray(opts.script) ? opts.script : (opts.tool ? [opts] : []);
  if (!rules.length) throw new Error('driveTool: give the tool_use to script (tool) or several (script: [{ tool }, ...])');
  for (const rule of rules) {
    if (!rule || !isToolUse(rule.tool)) {
      throw new Error(`driveTool: each call must be a tool_use { name, input, id }, got ${JSON.stringify(rule && rule.tool)}`);
    }
    if (rule.inputFrom !== undefined && typeof rule.inputFrom !== 'function') {
      throw new Error(`driveTool: inputFrom (${rule.tool.id}) must be a function of the request log`);
    }
  }
  return rules;
}

// The caller's environment less any Claude Code or API setting.
function baseEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(CLAUDE|ANTHROPIC)/.test(k)) env[k] = v;
  return env;
}

// Which binary a side runs: { bin }, { absent } (this box has none) or { skipped } (the caller said why).
function quaudeOf(opts) {
  if (opts.quaudeSkip !== undefined) return { skipped: opts.quaudeSkip };
  if (opts.quaude !== undefined) {
    return fs.existsSync(String(opts.quaude)) ? { bin: opts.quaude } : { absent: `quaude ${opts.quaude} does not exist` };
  }
  const q = require('./built-binary.cjs').builtQuaude();
  return q.skip ? { absent: q.skip } : { bin: q.path };
}
function nativeOf(opts) {
  // "Runs as rg" (rgOracle) stands in for "a full, runnable carve": a minimised or foreign carve does neither.
  if (opts.nativeSkip !== undefined) return { skipped: opts.nativeSkip };
  if (opts.native !== undefined) {
    return opts.native && fs.existsSync(String(opts.native)) ? { bin: opts.native }
      : { absent: `native ${opts.native} does not exist` };
  }
  const { rgOracle, rgOracleSkip } = require('./provider-resolve.cjs');
  const bin = rgOracle(process.env);
  return bin ? { bin } : { absent: rgOracleSkip(process.env) };
}

async function runSide(side, bin, rules, opts, base) {
  const work = path.join(base, 'work');
  fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(path.join(base, side), { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  if (opts.setup) opts.setup(work, base);
  const home = throwawayHome(path.join(base, side));
  // Claude Code's per-uid temp dir (background task output, among others): throwawayHome's CLAUDE_CODE_TMPDIR.
  const tmp = home.CLAUDE_CODE_TMPDIR;
  const sent = {};
  const mock = await startMockAnthropic({
    respond: (seen) => {
      const rule = rules.find((r) => !seen.includes(r.tool.id));
      if (!rule) return cannedSSE(DONE);
      const input = rule.inputFrom ? rule.inputFrom({ requests: mock.requests.slice() }) : rule.tool.input;
      sent[rule.tool.id] = input;
      return cannedToolUseSSE(rule.tool.name, input, rule.tool.id);
    },
  });
  try {
    const names = [...new Set(rules.map((r) => r.tool.name))];
    const allowed = opts.allowedTools === undefined ? names.join(',') : opts.allowedTools;
    const args = ['-p', opts.prompt || 'drive the tool', ...(allowed === null ? [] : ['--allowedTools', allowed]), ...(opts.args || [])];
    const env = { ...baseEnv(), ...home, ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: 'sk-ant-mock', ...(opts.env || {}),
      ...(opts.switches || {}) };
    const r = await spawnCollect(bin, args, { cwd: work, env }, { timeoutMs: opts.timeoutMs || 240000 });
    // the log, and the side's own temp dir beside it (a check that judges a path under it reads it here, never from a
    // module-level variable: a synthetic control log has none, so such a check fails there)
    const raw = { requests: mock.requests.slice(), tmp };
    const results = {};
    for (const rule of rules) results[rule.tool.id] = toolResult(raw, rule.tool.id);
    const first = rules[0].tool.id;
    return {
      text: toolResultText(raw, first), isError: !!(results[first] && results[first].isError), result: results[first], results,
      raw, sent, tmp, status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut, home,
      inspected: opts.inspect ? opts.inspect(work, base) : undefined,
    };
  } finally { await mock.close(); }
}

// Validates synchronously (a malformed call throws at the call site), then drives quaude, then native.
function driveTool(opts = {}) {
  const rules = rulesOf(opts);
  for (const k of ['quaudeSkip', 'nativeSkip']) {
    if (opts[k] !== undefined && !(typeof opts[k] === 'string' && opts[k].trim() && !/\n/.test(opts[k]))) {
      throw new Error(`driveTool: ${k} must be a one-line reason that side is not run`);
    }
  }
  const reserved = Object.keys(opts.env || {}).filter((k) => RESERVED_ENV.test(k));
  if (reserved.length) {
    throw new Error(`driveTool: env may not set ${reserved.join(', ')}: HOME, USERPROFILE and CLAUDE* are the sandbox, `
      + 'ANTHROPIC* the mock');
  }
  const unlisted = Object.keys(opts.switches || {}).filter((k) => !Object.prototype.hasOwnProperty.call(TOOL_SWITCHES, k));
  if (unlisted.length) {
    throw new Error(`driveTool: switches may set only ${Object.keys(TOOL_SWITCHES).join(', ')} (TOOL_SWITCHES, each with `
      + `its reason), not ${unlisted.join(', ')}`);
  }
  if (opts.base !== undefined && !(typeof opts.base === 'string' && path.isAbsolute(opts.base))) {
    throw new Error(`driveTool: base must be an absolute temp dir, got ${JSON.stringify(opts.base)}`);
  }
  return (async () => {
    const own = opts.base === undefined;
    const base = own ? fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tool-driver-'))) : opts.base;
    try {
      const out = { base };
      for (const [side, which] of [['quaude', quaudeOf(opts)], ['native', nativeOf(opts)]]) {
        out[side] = which.bin === undefined ? (which.absent !== undefined ? { absent: which.absent } : { skipped: which.skipped })
          : await runSide(side, which.bin, rules, opts, base);
      }
      return out;
    } finally { if (own) fs.rmSync(base, { recursive: true, force: true }); }
  })();
}

module.exports = { driveTool, DONE, TOOL_SWITCHES };
