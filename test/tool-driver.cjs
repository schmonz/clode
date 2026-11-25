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
//                    A rule may add `waitForLog: RegExp`: the mock holds that call until the side's own --debug-file
//                    matches (bounded by WAIT_FOR_LOG_MS, then it is sent anyway and the check judges what came back),
//                    for a call whose answer depends on startup work the turn does not wait for. ListAgents names the
//                    session only once native's UDS messaging server is listening, which a -p turn does not await:
//                    under a loaded suite (2026-11-25) native answered before it was, read from the 2.1.330 carve
//                    (CLAUDE_CODE_MESSAGING_SOCKET is set after listen).
//                    An Agent rule may add `subagent: { prompt, reply }`: the subagent's own conversation (a request
//                    that spells `prompt`, the token the Agent input hands it, and not yet the Agent call's id) is
//                    answered with the text `reply`, never with the next scripted call (agentic-subagent-diff's shape).
//                    A WebFetch rule uses the same: the page goes to a second model request (the one that spells the
//                    WebFetch input's prompt), and `reply` may be a function of that request's body, so the answer
//                    can carry what only the fetched page holds (test/fidelity/webfetch.test.cjs).
//   opts.base        an absolute temp dir the caller made, so a tool_use input can name paths under it before the
//                    turn (Read's file_path is absolute). The default is a fresh one, removed when both sides are
//                    done. The caller removes its own.
//   opts.setup       (work, base) => void: lays the fixture in <base>/work, the turn's working directory. Run before
//                    EACH side, on a fresh <base>/work, so both sides see the same tree at the same paths and a
//                    tool_result needs no path rewriting to compare.
//   opts.inspect     (work, base) => any: run after each side's turn, before the next side wipes the tree (what a
//                    Write left on disk); its value is SIDE.inspected.
//   opts.autoModeSeverity  an integer 0-100: the auto-mode safety classifier's answer, `<severity>N` (below 50
//                    allows). Asked in plan and auto mode for a call such as Agent; a request is the classifier's when
//                    it stops at `</severity>` (2.1.283's stop_sequences). Without it the classifier gets the next
//                    scripted call, cannot parse it, and the call is refused as "temporarily unavailable". Never answered
//                    as a subagent either way.
//   opts.args        more CLI arguments, after `-p <prompt>` and --allowedTools (--add-dir, --permission-mode, ...).
//   opts.allowedTools  the --allowedTools value: the scripted tools' names by default; null passes none (the
//                    `unlisted` cell).
//   opts.prompt      the -p prompt ('drive the tool'), or what an interactive turn types.
//   opts.interactive  true: no -p; the turn runs in a pty and the prompt is typed (interactiveTurn). Needs the PTY harness
//                    (node-pty, test/tui-screen.cjs) and a POSIX host.
//   opts.after       interactive only: what is typed AFTER the turn, in order, each { label, send: TEXT[, until: TEXT]
//                    [, exits: true] } (a slash command and its Enter, say). `exits` marks the step the session ends
//                    on by itself (/quit): only the last may say it, and the turn is unfinished unless the child did
//                    exit there. SIDE.exit is how the session ended; SIDE.turn.after the labels typed (so no mode cell
//                    is judged on a session that typed more than its turn).
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
//   opts.timeoutMs   per side (240 s), times CLODE_TIMEOUT_SCALE on a slow host.
// SIDE = { text, isError, result, results, raw, sent, status, signal, stdout, stderr, timedOut, home, keychain, turn, inspected,
//          debugLog }
//   debugLog         the side's --debug-file, as text (null when it wrote none). EVERY side runs with one, and driveTool
//                    holds quaude's to native's (test/debug-log-gate.cjs) and REJECTS with the offending lines on a
//                    finding; the judgement is out.debugLog.
//   turn             what the turn ran: { bin, args, allowedTools, scripted, interactive, switches, env (its keys), settings
//                    (files setup wrote that are settings) }; modeTurnFinding judges it against MODE_TURNS.
//   keychain         the `security` calls the side made, each its argv, answered by the stub (shadowKeychain).
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
const { updaterOff, refuseUpdaterOn } = require('./updater-off.cjs');
const { throwawayHome } = require('./throwaway-home.cjs');
const { startMockAnthropic, cannedSSE, cannedToolUseSSE, cannedMessage } = require('./mock-anthropic-helper.cjs');
const { toolResult, toolResultText } = require('../scripts/lib/tool-result.cjs');
const { debugFileArgs, readLog, assertDebugLogClean } = require('./debug-log-gate.cjs');

const DONE = 'TOOL-DRIVER-DONE';
// Keys opts.env may not set: the sandbox (HOME, USERPROFILE, CLAUDE*) and the mock (ANTHROPIC*).
// BUN_OPTIONS and NODE_OPTIONS too: either preloads code into the target (BUN_OPTIONS="--preload x.js" runs JS inside
// native Bun), so a driver could change what registers without spelling a switch.
const RESERVED_ENV = /^(?:HOME|USERPROFILE|CLAUDE.*|ANTHROPIC.*|BUN_OPTIONS|NODE_OPTIONS)$/i;
// THE ONLY Claude Code switches a driver may set (opts.switches), each with why a driver needs it. Never the sandbox
// or the mock: a key here is a product switch that changes which tools register, nothing else.
const TOOL_SWITCHES = Object.freeze({
  CLAUDE_CODE_ENABLE_TASKS: 'the Task* tools register unless it is "false" (then TodoWrite does): every-tool Phase B '
    + 'drives TodoWrite with it off, and a Task* driver may pin it on',
});
const isToolUse = (u) => !!u && typeof u.name === 'string' && !!u.name && typeof u.id === 'string' && !!u.id
  && !!u.input && typeof u.input === 'object';

// The rules the mock walks, each { tool }: opts.script, or opts itself for a single opts.tool.
// The auto-mode safety classifier's requests stop at its closing tag (2.1.283, measured 2026-11-20).
const CLASSIFIER_STOP = '"stop_sequences":["</severity>"]';
// A rule's waitForLog: poll the side's debug log until it matches, or until the bound; resolves either way (the check
// on the tool_result is the verdict, and a log that never matched shows there with the log itself).
const WAIT_FOR_LOG_MS = 60000;
function waitForLog(file, re, limitMs = WAIT_FOR_LOG_MS) {
  const until = Date.now() + limitMs;
  return new Promise((resolve) => {
    const tick = () => {
      let text = '';
      try { text = fs.readFileSync(file, 'utf8'); } catch { /* not written yet */ }
      if (re.test(text) || Date.now() >= until) { resolve(); return; }
      setTimeout(tick, 50);
    };
    tick();
  });
}

function rulesOf(opts) {
  if (opts.autoModeSeverity !== undefined && !(Number.isInteger(opts.autoModeSeverity) && opts.autoModeSeverity >= 0 && opts.autoModeSeverity <= 100)) {
    throw new Error('driveTool: autoModeSeverity must be an integer 0-100');
  }
  const rules = Array.isArray(opts.script) ? opts.script : (opts.tool ? [opts] : []);
  if (!rules.length) throw new Error('driveTool: give the tool_use to script (tool) or several (script: [{ tool }, ...])');
  for (const rule of rules) {
    if (!rule || !isToolUse(rule.tool)) {
      throw new Error(`driveTool: each call must be a tool_use { name, input, id }, got ${JSON.stringify(rule && rule.tool)}`);
    }
    if (rule.waitForLog !== undefined && !(rule.waitForLog instanceof RegExp)) {
      throw new Error(`driveTool: waitForLog (${rule.tool.id}) must be a RegExp over the side's debug log`);
    }
    if (rule.inputFrom !== undefined && typeof rule.inputFrom !== 'function') {
      throw new Error(`driveTool: inputFrom (${rule.tool.id}) must be a function of the request log`);
    }
    if (rule.subagent !== undefined && !(rule.subagent && typeof rule.subagent.prompt === 'string' && rule.subagent.prompt
      && (typeof rule.subagent.reply === 'string' || typeof rule.subagent.reply === 'function')
      && rule.tool.input && String(rule.tool.input.prompt || '').includes(rule.subagent.prompt))) {
      throw new Error(`driveTool: subagent (${rule.tool.id}) must be { prompt, reply }, with prompt a token of the Agent input's prompt`);
    }
  }
  // The mock knows a call was answered by finding its id in the request body, as a substring. An id inside another
  // (t_exit in t_exit_none) reads as answered the moment the longer one is, and the mock skips the call: the turn ends
  // without it and its result is missing (every-tool Task 4: ExitWorktree "had no tool_result" for this reason).
  const ids = rules.map((r) => r.tool.id);
  for (const a of ids) {
    const inside = ids.find((b) => b !== a && b.includes(a));
    if (inside) throw new Error(`driveTool: call id ${a} is inside ${inside}; the mock would take it as answered. Make the ids distinct`);
  }
  return rules;
}

// The caller's environment less any Claude Code or API setting.
function baseEnv(parent = process.env) {
  const env = {};
  for (const [k, v] of Object.entries(parent)) if (!/^(CLAUDE|ANTHROPIC)/.test(k)) env[k] = v;
  return env;
}

// One side's environment (PATH gets the keychain shadow after). DISABLE_AUTOUPDATER on both sides, as
// test/frame-oracle.cjs has always set it: an interactive native left to itself updates its own install mid-job (the
// suspect when linux-x64-pty's global provider no longer decoded an hour after it was installed, CI 45354661143 /
// 45381323279; scripts/record-provider.mjs now makes that a named refusal). One knob, both sides: what a turn is judged
// on is never the updater. opts.autoUpdaterBecause leaves it unset, with the reason (test/updater-off.cjs). Set HERE,
// not inherited: the caller's own environment is whatever ran the file (test/autoupdater-off-gate.test.cjs).
function sideEnv({ home, mockUrl, opts = {}, parent = process.env }) {
  return updaterOff({ ...baseEnv(parent), ...home, ANTHROPIC_BASE_URL: mockUrl, ANTHROPIC_API_KEY: 'sk-ant-mock',
    ...(opts.env || {}), ...(opts.switches || {}) }, opts.autoUpdaterBecause);
}

// THE KEYCHAIN, SHADOWED HERE (fix round 2). Native reads it on every turn, -p and interactive alike, by `security` on
// PATH: measured 2026-11-20 on 2.1.283 darwin-arm64, `find-generic-password -a <user> -w -s "Claude Code-credentials-<hash>"`
// and `... -s "Claude Code-<hash>"`. test/run.mjs puts a stub first on PATH for the suite, but a driver run with
// `node --test <file>` (how every fidelity file is run by hand and in its CI job) had none, and its native turns read the
// developer's real Keychain. Each side now gets its own stub, first on PATH, whoever runs it: the same answers as
// run.mjs's ("not found" for a read, success for a write), and every call logged to <base>/<side>-security.log.
const SECURITY_STUB = (log) => '#!/bin/sh\n'
  + `printf '%s\\n' "$*" >> '${log.replace(/'/g, "'\\''")}'\n`
  + 'case "$1" in\n'
  + '  find-generic-password) echo "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain." 1>&2; exit 44 ;;\n'
  + '  -i) cat >/dev/null; exit 0 ;;\n'
  + '  add-generic-password) exit 0 ;;\n'
  + '  delete-generic-password) exit 0 ;;\n'
  + '  *) exit 1 ;;\n'
  + 'esac\n';
function shadowKeychain(base, side) {
  const dir = path.join(base, `${side}-bin`);
  fs.mkdirSync(dir, { recursive: true });
  const log = path.join(base, `${side}-security.log`);
  fs.writeFileSync(path.join(dir, 'security'), SECURITY_STUB(log), { mode: 0o755 });
  return { dir, log };
}

// THE SHADOW, PROVEN (Task 5 approval, 2026-11-20). On darwin, native looks up its credentials through `security
// find-generic-password` on every turn; a turn that logged none to the stub did not use the stub, so it would have read
// the REAL Keychain (an upstream switch to an absolute /usr/bin/security, a PATH the stub is not first on). That is a
// finding, never a silent pass. null when shadowed, or off darwin (no Keychain there).
function keychainShadowFinding(side, calls, platform = process.platform) {
  if (platform !== 'darwin') return null;
  if ((calls || []).some((c) => /^find-generic-password\b/.test(c))) return null;
  return `${side}'s turn on darwin logged no \`security find-generic-password\` to the Keychain stub (calls: `
    + `${JSON.stringify(calls || [])}): the stub was not used, so the turn could read the real Keychain (an absolute `
    + '/usr/bin/security?); shadow it before running native again';
}

// A SLOW HOST'S CLOCK (CLODE_TIMEOUT_SCALE, the build's own knob: libexec/clode-build.cjs timeoutScale). Under TCG (the
// netbsd-arm64 cell job's qemu guest on an x64 runner, measured 2026-11-20 at roughly 10-18x the same guest under HVF) a
// turn that takes 125 s here takes tens of minutes, so every wait below is multiplied by it; 1 everywhere else.
const SCALE = require('../libexec/clode-build.cjs').timeoutScale(process.env);
const turnTimeout = (opts) => (opts.timeoutMs || 240000) * SCALE;
// The interactive turn's four settle limits, ALL on that clock. CI 44813971330 (netbsd-arm64-cells, 20x TCG): bootMaxMs was
// left at tui-screen's 60 s default while bootSettleMs was scaled, so a boot that takes ~25 s natively (hundreds of seconds
// under TCG) was cut at 60 s and reported `unsettled boot`. Built from tui-screen's own SCRIPT_DEFAULTS, so a limit it adds
// later is scaled too (test/tool-driver.test.cjs pins that every default is multiplied).
function interactiveLimits(opts, scale = SCALE) {
  const D = require('./tui-screen.cjs').SCRIPT_DEFAULTS;
  return { bootSettleMs: 3000 * scale, bootMaxMs: D.bootMaxMs * scale, settleMs: 1500 * scale,
    maxSettleMs: (opts.timeoutMs || 240000) * scale, ...Object.fromEntries(Object.keys(D).filter((k) => !['bootSettleMs', 'bootMaxMs', 'settleMs', 'maxSettleMs'].includes(k)).map((k) => [k, D[k] * scale])) };
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
  for (const stale of [`${side}-bin`, `${side}-security.log`, `${side}-debug.log`]) fs.rmSync(path.join(base, stale), { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  const laid = filesUnder(base);
  if (opts.setup) opts.setup(work, base);
  const settings = [...filesUnder(base)].filter((f) => !laid.has(f) && SETTINGS_FILE.test(f)).sort();
  const home = throwawayHome(path.join(base, side));
  // Claude Code's per-uid temp dir (background task output, among others): throwawayHome's CLAUDE_CODE_TMPDIR.
  const tmp = home.CLAUDE_CODE_TMPDIR;
  const sent = {};
  // THE DEBUG LOG (test/debug-log-gate.cjs): every side writes one, beside its security log, and driveTool holds
  // quaude's to native's. Named here, before the mock, because a rule's waitForLog reads it.
  const debugFile = path.join(base, `${side}-debug.log`);
  const mock = await startMockAnthropic({
    respond: (seen) => {
      const classifier = seen.includes(CLASSIFIER_STOP);
      if (classifier && opts.autoModeSeverity !== undefined) return cannedMessage(`<severity>${opts.autoModeSeverity}`, '</severity>');
      const sub = !classifier && rules.find((r) => r.subagent && seen.includes(r.subagent.prompt) && !seen.includes(r.tool.id));
      if (sub) return cannedSSE(typeof sub.subagent.reply === 'function' ? String(sub.subagent.reply(seen)) : sub.subagent.reply);
      const rule = rules.find((r) => !seen.includes(r.tool.id));
      if (!rule) return cannedSSE(DONE);
      const reply = () => {
        const input = rule.inputFrom ? rule.inputFrom({ requests: mock.requests.slice() }) : rule.tool.input;
        sent[rule.tool.id] = input;
        return cannedToolUseSSE(rule.tool.name, input, rule.tool.id);
      };
      return rule.waitForLog ? waitForLog(debugFile, rule.waitForLog).then(reply) : reply();
    },
  });
  try {
    const names = [...new Set(rules.map((r) => r.tool.name))];
    const allowed = opts.allowedTools === undefined ? names.join(',') : opts.allowedTools;
    const flags = [...(allowed === null ? [] : ['--allowedTools', allowed]), ...(opts.args || [])];
    // The debug log is not in SIDE.turn.args: it is the harness's, not the turn's, so no mode cell differs by it.
    const runFlags = [...flags, ...debugFileArgs(debugFile)];
    const args = ['-p', opts.prompt || 'drive the tool', ...runFlags];
    const env = sideEnv({ home, mockUrl: mock.url, opts });
    const kc = shadowKeychain(base, side);
    env.PATH = [kc.dir, env.PATH || ''].join(path.delimiter);
    refuseUpdaterOn(env, `driveTool ${side} (${bin})`);
    const r = opts.interactive ? await interactiveTurn(bin, runFlags, work, env, home, opts, afterSteps(opts))
      : await spawnCollect(bin, args, { cwd: work, env }, { timeoutMs: turnTimeout(opts) });
    // the log, and the side's own temp dir beside it (a check that judges a path under it reads it here, never from a
    // module-level variable: a synthetic control log has none, so such a check fails there)
    const raw = { requests: mock.requests.slice(), tmp };
    const results = {};
    for (const rule of rules) results[rule.tool.id] = toolResult(raw, rule.tool.id);
    const first = rules[0].tool.id;
    return {
      text: toolResultText(raw, first), isError: !!(results[first] && results[first].isError), result: results[first], results,
      raw, sent, tmp, status: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut, home,
      exit: r.exit,
      keychain: fs.existsSync(kc.log) ? fs.readFileSync(kc.log, 'utf8').split('\n').filter(Boolean) : [],
      debugLog: readLog(debugFile),
      turn: { bin, args: [...(opts.args || [])], allowedTools: allowed, scripted: names.join(','), interactive: !!opts.interactive,
        after: afterSteps(opts).map((st) => st.label),
        switches: { ...(opts.switches || {}) }, env: Object.keys(opts.env || {}).sort(), settings },
      inspected: opts.inspect ? opts.inspect(work, base) : undefined,
    };
  } finally { await mock.close(); }
}

// THE INTERACTIVE TURN (opts.interactive, the `interactive` cell; fix round 2). The same mock, home and flags, but no
// -p: the binary runs in a pty (test/e2e-pty.cjs captureSession, tui-screen.cjs), the prompt is typed and sent, and the
// turn is over when the mock's closing text (DONE) is on screen. MEASURED 2026-11-20 (native 2.1.283 darwin-arm64): an
// interactive first turn reaches the mock (HEAD /api/hello, then POST /v1/messages) once the profile is past onboarding,
// trusts the working directory and approves the API key (the bundle keeps its last 20 characters); nothing is asked
// of claude.ai. RECIPE G2's "validates credentials with claude.ai" was a synchronous capture freezing the in-process
// mock, so no request was ever answered (test/e2e-pty.cjs seedClaudeProfile, 2026-09-25).
// -> spawnCollect's shape: status 0 when every step settled (the prompt echoed, DONE painted), else 1 with why.
function seedInteractiveProfile(home, work) {
  const profile = { hasCompletedOnboarding: true, theme: 'dark',
    projects: { [work]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
    customApiKeyResponses: { approved: ['sk-ant-mock'.slice(-20)], rejected: [] },
    // interactive defaults to auto mode, whose first classifier call through a gateway (the mock is one: its host is not
    // anthropic.com) opens a billing notice that waits for Enter; acknowledged now, it stays shut for a day (2.1.283)
    autoModeClassifierBillingNoticeAcknowledgedAt: Date.now() };
  // CLAUDE_CONFIG_DIR holds the profile when it is set (it is: throwawayHome); HOME's copy is for a target that ignores it
  for (const d of [home.CLAUDE_CONFIG_DIR, home.HOME]) fs.writeFileSync(path.join(d, '.claude.json'), JSON.stringify(profile));
}
// opts.after, validated: [] when there is none. Throws on a malformed step (driveTool calls it before running).
function afterSteps(opts) {
  if (opts.after === undefined) return [];
  if (!opts.interactive) throw new Error('driveTool: after is what an interactive session types after its turn; give interactive: true');
  if (!Array.isArray(opts.after)) throw new Error('driveTool: after must be an array of { label, send[, until][, exits] }');
  const labels = new Set(['boot', 'type', 'send']);
  opts.after.forEach((st, i) => {
    if (!st || typeof st.label !== 'string' || !st.label || labels.has(st.label) || typeof st.send !== 'string'
      || (st.until !== undefined && (typeof st.until !== 'string' || !st.until)) || (st.exits && i !== opts.after.length - 1)) {
      throw new Error(`driveTool: after[${i}] must be { label (unique), send: TEXT[, until: TEXT][, exits: true, last only] }, got ${JSON.stringify(st)}`);
    }
    labels.add(st.label);
  });
  return opts.after;
}
async function interactiveTurn(bin, flags, work, env, home, opts, after = []) {
  if (process.platform === 'win32') throw new Error('driveTool: an interactive turn needs a POSIX pty here');
  seedInteractiveProfile(home, work);
  const { captureSession } = require('./e2e-pty.cjs');
  const hex = (t) => Buffer.from(t, 'utf8').toString('hex');
  const prompt = opts.prompt || 'drive the tool';
  try {
    const s = await captureSession({ env }, {
      cmd: ['/bin/sh', '-c', 'cd "$1" && shift && exec "$@"', 'sh', work, bin, ...flags],
      script: [{ label: 'type', send: hex(prompt), until: prompt }, { label: 'send', send: hex('\r'), until: DONE },
        ...after.map((st) => ({ label: st.label, send: hex(st.send), ...(st.until ? { until: st.until } : {}) }))],
      rows: 50, cols: 200, ...interactiveLimits(opts),
    });
    // the step the session ends on by itself (/quit) cannot settle (its child is gone): it is done when it exited THERE
    const quit = after.length && after[after.length - 1].exits ? after[after.length - 1].label : null;
    const quitOk = !quit || (s.exit && s.exit.during === quit);
    const unsettled = s.frames.filter((f) => !f.settled && !(quitOk && f.label === quit)).map((f) => f.label);
    if (!quitOk) unsettled.push(`${quit} (the session did not exit there: ${JSON.stringify(s.exit)})`);
    const done = s.frames.length === 3 + after.length && !unsettled.length;
    // stdout: the last screen, as text (what a -p turn would print), for diagnostics
    const { rowText } = require('./frame-diff.cjs');
    const last = s.frames.length ? s.frames[s.frames.length - 1].frame : null;
    const screen = last ? Array.from({ length: last.rows }, (_, y) => rowText(last, y).replace(/\s+$/, '')).join('\n').replace(/\n+$/, '') : '';
    return { status: done ? 0 : 1, signal: null, stdout: screen, timedOut: !done, exit: s.exit,
      stderr: done ? '' : `the interactive turn did not finish: ${unsettled.length ? `unsettled ${unsettled.join(', ')}` : `${s.frames.length} frame(s)`}` };
  } catch (e) {
    return { status: 1, signal: null, stdout: '', stderr: `the interactive turn could not run: ${e.message.slice(0, 1200)}`, timedOut: false };
  }
}

// THE MODE TURNS (every-tool ruling E12): the one turn each mode cell is driven by, as driveTool options. A tool is
// NOT APPLICABLE in a mode (assertNotRegistered) only when the MODE does not register it, so a not-registered answer
// proves nothing unless its turn was EXACTLY this one: these args and --allowedTools, no switches, no extra env, and a
// setup that wrote no settings. A positive rule, not a list of disabling spellings: --disallowedTools,
// --disallowed-tools, --settings '{"permissions":{"deny":[...]}}', a fixture .claude/settings.json and whatever upstream
// adds next are all just "not the mode's turn". modeTurnFinding judges what the turn ACTUALLY ran (SIDE.turn).
const PERMISSION_MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'dontAsk', 'plan'];
const MODE_TURNS = Object.freeze({
  print: Object.freeze({}),
  ...Object.fromEntries(PERMISSION_MODES.map((p) => [`permission:${p}`, Object.freeze({ args: Object.freeze(['--permission-mode', p]) })])),
  unlisted: Object.freeze({ allowedTools: null }),
  interactive: Object.freeze({ interactive: true }),
});
// A file setup wrote that Claude Code reads as settings: any *settings*.json, or any file at the top of a .claude dir
// (its skills/, worktrees/ and the like below it are fixtures, not configuration).
const SETTINGS_FILE = /(?:^|[\\/])(?:[^\\/]*settings[^\\/]*\.json|\.claude[\\/][^\\/]+)$/i;
function filesUnder(dir) {
  const out = new Set();
  const walk = (d, rel) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r); else out.add(r);
    }
  };
  walk(dir, '');
  return out;
}
// -> null when SIDE ran exactly MODE_TURNS[mode] on the binary the cell names, else a finding naming every difference.
// The binary (M2): quaude's is the one built from this tree (builtQuaude, memoized), native's the pinned provider that
// runs here (rgOracle); any other (a stale build, a `claude` from PATH) proves nothing about either.
function modeTurnFinding(label, side, mode) {
  let bin;
  if (label === 'quaude') { const q = require('./built-binary.cjs').builtQuaude(); bin = q.skip ? null : q.path; }
  else if (label === 'native') bin = require('./provider-resolve.cjs').rgOracle(process.env) || null;
  else return `${label}: a mode turn is quaude's or native's, never ${JSON.stringify(label)}`;
  return modeTurnFindingFor(label, side, mode, bin);
}
// The same judgement against a binary the caller names: test/tool-driver.test.cjs's fakes. The coverage gate counts a
// not-applicable proof only in a file that calls modeTurnFinding itself, never this.
function modeTurnFindingFor(label, side, mode, wantBin) {
  const want = MODE_TURNS[mode];
  if (!want) return `${label}: ${JSON.stringify(mode)} is not a mode turn (MODE_TURNS: ${Object.keys(MODE_TURNS).join(', ')})`;
  const t = side && side.turn;
  if (!t) return `${label} ${mode}: the side records no turn (SIDE.turn), so what it ran cannot be judged`;
  const diff = [];
  if (!wantBin || t.bin !== wantBin) diff.push(`binary ${JSON.stringify(t.bin)}, not ${wantBin ? JSON.stringify(wantBin) : `${label}'s (none here)`}`);
  const wantArgs = want.args || [];
  if (JSON.stringify(t.args) !== JSON.stringify(wantArgs)) diff.push(`args ${JSON.stringify(t.args)}, not ${JSON.stringify(wantArgs)}`);
  const wantAllowed = want.allowedTools === null ? null : t.scripted;
  if (t.allowedTools !== wantAllowed) diff.push(`--allowedTools ${JSON.stringify(t.allowedTools)}, not ${JSON.stringify(wantAllowed)}`);
  if (t.interactive !== !!want.interactive) diff.push(`interactive ${t.interactive}, not ${!!want.interactive}`);
  if (t.after && t.after.length) diff.push(`typed after the turn: ${t.after.join(', ')}`);
  if (Object.keys(t.switches).length) diff.push(`switches ${JSON.stringify(t.switches)}`);
  if (t.env.length) diff.push(`env ${t.env.join(', ')}`);
  if (t.settings.length) diff.push(`setup wrote settings ${t.settings.join(', ')}`);
  return diff.length ? `${label} ${mode}: not the mode's own turn (ruling E12), so no answer in it proves a tool not `
    + `registered: ${diff.join('; ')}` : null;
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
      + 'ANTHROPIC* the mock, BUN_OPTIONS and NODE_OPTIONS preload code into the target');
  }
  const unlisted = Object.keys(opts.switches || {}).filter((k) => !Object.prototype.hasOwnProperty.call(TOOL_SWITCHES, k));
  if (unlisted.length) {
    throw new Error(`driveTool: switches may set only ${Object.keys(TOOL_SWITCHES).join(', ')} (TOOL_SWITCHES, each with `
      + `its reason), not ${unlisted.join(', ')}`);
  }
  afterSteps(opts);
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
      const unshadowed = out.native.keychain && keychainShadowFinding('native', out.native.keychain);
      if (unshadowed) throw new Error(`driveTool: ${unshadowed}`);
      // quaude's --debug log, READ (test/debug-log-gate.cjs): held to native's when native ran this turn, else to the
      // absolute rules. A finding fails the driver's test here, with the lines, whatever its own check says.
      if (out.quaude.debugLog !== undefined) {
        out.debugLog = assertDebugLogClean({ label: 'driveTool: quaude', quaude: out.quaude.debugLog,
          reference: out.native.debugLog });
      }
      return out;
    } finally { if (own) fs.rmSync(base, { recursive: true, force: true }); }
  })();
}

// Why an interactive turn cannot run here (no PTY harness: node-pty in the platform harness dir or on the module path),
// or null when it can. A test skips by this name rather than failing on a box without the harness.
function ptyHarnessMissing() {
  try {
    require('./tui-screen.cjs');
    const { harnessDir } = require('../scripts/platform-tag.cjs');
    try { require(path.join(harnessDir(path.resolve(__dirname, '..')), 'node_modules', 'node-pty')); } catch { require('node-pty'); }
    return null;
  } catch (e) { return `no PTY harness here (node-pty): ${e.message.split('\n')[0]}`; }
}

module.exports = { waitForLog, WAIT_FOR_LOG_MS, driveTool, sideEnv, DONE, TOOL_SWITCHES, MODE_TURNS, modeTurnFinding, modeTurnFindingFor, shadowKeychain, keychainShadowFinding, CLASSIFIER_STOP, ptyHarnessMissing, SCALE, interactiveLimits };
