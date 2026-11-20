'use strict';
// SANDBOXED BASH FAILS CLOSED under quaude (user ruling 2026-10-05, until real sandbox support lands).
//
// quaude cannot provide Claude Code's sandbox yet: its initialization needs node:net servers the node-shim does not
// have, and fails. The 2.1.283 bundle then sets sandboxDisabledThisSession, and every LATER Bash call ran UNSANDBOXED
// (measured 2026-10-05, a quaude built from d93cbd1 on macOS: call 1 refused, calls 2 and 3 wrote outside the working
// directory, where native's sandbox refused them). quaude now hands the bundle sandbox.failIfUnavailable
// (libexec/quaude-bootstrap.mjs states the divergence), so with the sandbox enabled the bundle takes its own
// sandbox-REQUIRED branch: every Bash call refused, nothing written.
//
// A BUILT quaude (test/built-binary.cjs), one turn per case, three Bash calls each writing a marker inside the working
// directory and one outside it; a throwaway HOME, CLAUDE_CONFIG_DIR and TJS_HOME per run. With the sandbox on (user,
// project or local settings, or the user's own --settings): every call is refused with the bundle's required-branch
// reason and no marker exists. With it off: all three run. Measured on macOS, and on Linux with bubblewrap and socat
// present. Where native would NOT sandbox (a linux-carve quaude, on Linux, NetBSD, Haiku..., without bubblewrap or socat: native prints its warning and runs every
// call unsandboxed), quaude does as native does (round 3, USER ruling D2): the same warning, every call runs.
// An explicit sandbox.failIfUnavailable:false from the user stays OVERRIDDEN wherever native would sandbox (USER ruling
// D1): those rows are refused like the rest.
//
// Round 3 (C1): the user's own --settings is MERGED with quaude's (libexec/update-guard.cjs, "THE USER'S --settings"),
// where it used to be discarded whole. Its sandbox setting fails closed like any other source's; its env, hooks and
// permissions apply (the update guard's hook still runs beside the user's); a value the bundle cannot use makes it print
// its own error and exit 1 before anything runs, as native does (measured, native 2.1.283: "Error: Settings file not
// found: <path>", "Error: Invalid JSON provided to --settings").
const test = require('node:test');
const { spawnCollect } = require('../spawn-collect.cjs');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { builtQuaude } = require('../built-binary.cjs');
const { startMockAnthropic, cannedSSE, cannedToolUseSSE } = require('../mock-anthropic-helper.cjs');
const { toolResult, assertFailsOnMissingOutput, assertFailsOnMissingOutputClaimingNoCell } = require('../../scripts/lib/tool-result.cjs');

// The bundle's required-branch refusal, naming the gap (round 3, USER ruling M1: node-shim's net.createServer throws
// "quaude does not support the sandbox yet: net.createServer"; before, the reason read "not a function").
const REQUIRED = /^Sandbox is required but failed to initialize: quaude does not support the sandbox yet: net\.createServer\b/;
const STARTUP_REFUSAL = /sandbox required but unavailable/;
const marker = (n) => `fc-marker-${n}`;
const M1 = { name: 'Bash', input: { command: `echo in > ${marker(1)}; echo x > ../out-1; echo FC-RAN-$((40+1))`, description: 'one' }, id: 'toolu_fc_1' };
const M2 = { name: 'Bash', input: { command: `echo in > ${marker(2)}; echo x > ../out-2; echo FC-RAN-$((40+2))`, description: 'two' }, id: 'toolu_fc_2' };
const M3 = { name: 'Bash', input: { command: `echo in > ${marker(3)}; echo x > ../out-3; echo FC-RAN-$((40+3))`, description: 'three' }, id: 'toolu_fc_3' };
// What the mock answers with, in order: one step per tool_use object, scripted from that object (so the cell gate,
// test/build-gates/tool-coverage-gates.test.cjs, reads each control's object as the one the mock sends).
const step = (USE) => ({ use: USE, emit: () => cannedToolUseSSE(USE.name, USE.input, USE.id) });
const SCRIPT = [step(M1), step(M2), step(M3)];

// The checks: refused by the bundle's required branch (an is_error tool_result saying so), or ran (the computed marker).
const refused1 = (m) => { const r = toolResult(m, M1.id); return !!r && r.isError && REQUIRED.test(r.text); };
const refused2 = (m) => { const r = toolResult(m, M2.id); return !!r && r.isError && REQUIRED.test(r.text); };
const refused3 = (m) => { const r = toolResult(m, M3.id); return !!r && r.isError && REQUIRED.test(r.text); };
const ran1 = (m) => { const r = toolResult(m, M1.id); return !!r && !r.isError && r.text.includes('FC-RAN-41'); };
const ran2 = (m) => { const r = toolResult(m, M2.id); return !!r && !r.isError && r.text.includes('FC-RAN-42'); };
const ran3 = (m) => { const r = toolResult(m, M3.id); return !!r && !r.isError && r.text.includes('FC-RAN-43'); };
const verdicts = (m) => ({ refused: [refused1(m), refused2(m), refused3(m)], ran: [ran1(m), ran2(m), ran3(m)] });

// The user --settings cases' own calls: E echoes an env var only the user's settings set; U spells a model-issued
// update, which quaude's update guard (merged in beside the user's hook) must still deny. U only ECHOES the words: the
// guard judges the command text, so it denies this too, and a guard that failed must not update anything real (a
// native run of an earlier draft, which ran `claude update` itself, updated the box's own global Claude Code).
const E = { name: 'Bash', input: { command: 'echo FC-ENV=$FC_USER_ENV; echo FC-RAN-$((40+4))', description: 'env' }, id: 'toolu_fc_env' };
const U = { name: 'Bash', input: { command: 'echo claude update; echo FC-RAN-$((40+5))', description: 'update' }, id: 'toolu_fc_upd' };
const envHonoured = (m) => { const r = toolResult(m, E.id); return !!r && !r.isError && r.text.includes('FC-ENV=honoured'); };
const updateDenied = (m) => { const r = toolResult(m, U.id); return !!r && r.isError && /clode manages Claude Code/.test(r.text); };
const bashDisabled = (m) => { const r = toolResult(m, E.id); return !!r && r.isError && /No such tool available: Bash/.test(r.text); };

// argv after the binary -> { status, stderr }
function turn(bin, cwd, env, args) {
  return spawnCollect(bin, args, { cwd, env }, { timeoutMs: 180000 }).then(({ status, stderr }) => ({ status, stderr }));
}

const ON = { sandbox: { enabled: true } };
const PRINT = ['-p', 'write the markers', '--allowedTools', 'Bash'];
// One turn of a case. `source` writes ON to user, project or local settings ('off': none). `files` are written to the
// run's base dir first (a value may be a function of { base, work }); `args` is argv, or a function of { base, work };
// `script` the tool calls the mock answers with, in order. -> { mock, markers, r, files } (files: base's entries after).
async function runCase(bin, { source = 'off', sourceSettings = ON, args = PRINT, script = SCRIPT, files = {}, cfgFiles = {} }) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-fail-closed-')));
  try {
    const work = path.join(base, 'work'), home = path.join(base, 'home'), cfg = path.join(home, '.claude'), tjsHome = path.join(base, 'tjs-home');
    for (const d of [path.join(work, '.claude'), cfg, tjsHome]) fs.mkdirSync(d, { recursive: true });
    if (source === 'user') fs.writeFileSync(path.join(cfg, 'settings.json'), JSON.stringify(sourceSettings));
    if (source === 'project') fs.writeFileSync(path.join(work, '.claude', 'settings.json'), JSON.stringify(sourceSettings));
    if (source === 'local') fs.writeFileSync(path.join(work, '.claude', 'settings.local.json'), JSON.stringify(sourceSettings));
    const ctx = { base, work };
    for (const [name, content] of Object.entries(cfgFiles)) fs.writeFileSync(path.join(cfg, name), content);
    for (const [name, content] of Object.entries(files)) {
      const text = typeof content === 'function' ? content(ctx) : content;
      fs.writeFileSync(path.join(base, name), typeof text === 'string' ? text : JSON.stringify(text));
    }
    const mock = await startMockAnthropic({
      respond: (body) => {
        const next = script.find((s) => !body.includes(s.use.id));
        return next ? next.emit() : cannedSSE('FC-DONE');
      },
    });
    try {
      const env = {};
      for (const [k, v] of Object.entries(process.env)) if (!/^(CLAUDE|ANTHROPIC)/.test(k)) env[k] = v;
      Object.assign(env, { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: cfg, TJS_HOME: tjsHome, SHELL: '/bin/bash',
        ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: 'sk-ant-mock' });
      const r = await turn(bin, work, env, typeof args === 'function' ? args(ctx) : args);
      const markers = [1, 2, 3].flatMap((n) => [[marker(n), work], [`out-${n}`, base]].filter(([f, d]) => fs.existsSync(path.join(d, f))).map(([f]) => f));
      return { mock, markers, r, files: fs.readdirSync(base) };
    } finally { await mock.close(); }
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
}

// A --settings value written to the run's base dir, by absolute path.
const MERGE_SEAM = { 'remote-settings.json': '{}' };
const fileArg = (name) => ({ base }) => [...PRINT, '--settings', path.join(base, name)];

// The sandbox-ON cases: each must leave every call refused and nothing written.
const ON_CASES = [
  { name: 'user settings', source: 'user' },
  { name: 'project settings', source: 'project' },
  { name: 'local settings', source: 'local' },
  // C1: the user's own --settings, both spellings, file and inline JSON. Before round 3 quaude's --settings came last
  // and the bundle kept only it: a sandbox enabled here never took effect, and every call ran.
  { name: 'the user\'s --settings FILE', files: { 's.json': ON }, args: fileArg('s.json') },
  { name: 'the user\'s --settings=FILE', files: { 's.json': ON }, args: ({ base }) => [...PRINT, `--settings=${path.join(base, 's.json')}`] },
  { name: 'the user\'s --settings inline JSON', args: [...PRINT, '--settings', JSON.stringify(ON)] },
  // A --settings file the bundle drops WHOLE (not a JSON object; or valid JSON that fails its settings schema): native
  // runs on without it. Fix round 1 (I-1): quaude's keys never ride in it, so the sandbox from user settings still
  // fails closed. Before, merged into the dropped file, sandbox.failIfUnavailable went with it: the first call was
  // refused by the optional branch and calls 2 and 3 ran UNSANDBOXED.
  { name: 'user settings + an unparseable --settings file', source: 'user', files: { 'bad.json': '{"sandbox": ' }, args: fileArg('bad.json') },
  { name: 'user settings + a schema-invalid --settings file ({"permissions":5})', source: 'user', files: { 'sch.json': { permissions: 5 } }, args: fileArg('sch.json') },
  // Fix round 2: where managed policy may exist quaude merges into the user's --settings AND adds the layers (belt and
  // braces). The test seam that makes quaude see "policy may exist" without any policy: an empty cached
  // remote-settings.json in the config dir (policyProbe lists it; the bundle finds no settings in it).
  { name: 'policy may exist (merge mode) + user settings + a schema-invalid --settings file', source: 'user', cfgFiles: MERGE_SEAM, files: { 'sch.json': { permissions: 5 } }, args: fileArg('sch.json') },
  // I1 + placement: `--add-dir config` is the model command with one added directory, not the `config` subcommand (the
  // prompt rides after `--`; with stdout not a TTY the bundle prints). quaude's --settings goes BEFORE the `--`: after
  // it, it would be a prompt word, not an option.
  { name: 'user settings, `--add-dir config -- <prompt>` (no -p)', source: 'user', args: ['--add-dir', 'config', '--allowedTools', 'Bash', '--', 'write the markers'] },
  // D1: the user's own failIfUnavailable:false (user settings, and their --settings file) is overridden: quaude's
  // --settings outranks user settings in the bundle's merge, and beside a user --settings quaude's value is managed
  // policy (--managed-settings), which outranks every --settings.
  { name: 'user settings with failIfUnavailable:false (D1)', source: 'user', sourceSettings: { sandbox: { enabled: true, failIfUnavailable: false } } },
  { name: 'a --settings file with failIfUnavailable:false (D1)', files: { 'f.json': { sandbox: { enabled: true, failIfUnavailable: false } } }, args: fileArg('f.json') },
];

// Where native would sandbox (libexec/update-guard.cjs, sandboxWouldRun, by the bundle's own check): macOS always;
// Linux unless WSL1 or bubblewrap or socat is missing from PATH (no managed policy in these throwaway runs).
function onPath(name) {
  return String(process.env.PATH || '').split(path.delimiter).some((d) => {
    try { fs.accessSync(path.join(d, name), fs.constants.X_OK); return fs.statSync(path.join(d, name)).isFile(); } catch { return false; }
  });
}
function nativeWouldSandbox() {
  if (process.platform !== 'linux') return true;
  let v = '';
  try { v = fs.readFileSync('/proc/version', 'utf8'); } catch { /* none */ }
  const m = v.match(/WSL(\d+)/i);
  if ((m && m[1] === '1') || (!m && v.toLowerCase().includes('microsoft'))) return false;
  return onPath('bwrap') && onPath('socat');
}
// Native's own warning when it will not sandbox an enabled sandbox (the 2.1.283 carve, print mode).
const NATIVE_WARNING = /Sandbox disabled: sandbox is enabled but dependencies are missing: .*\n\s*Commands will run WITHOUT sandboxing/;

const SKIP = process.platform === 'win32' ? 'the Bash tool needs bash; Windows sandboxing is not this gap' : false;
// Two tests, one per branch, so a job cannot report the fail-closed branch as judged when only the D2 one ran: the
// Bash x sandbox:on cell's controls live only in the first, which SKIPS wherever native would not sandbox, and a
// skipped driver whose cell no other passing test drives fails its job's cells check
// (test/build-gates/tool-coverage-gates.test.cjs, cells-ran-in-ci-job). Both judge the sandbox-off turn (print, in
// bash), so whichever branch applies, that cell is driven and the other test's skip is no finding.
const sandboxOff = async (q, findings) => {
  const off = await runCase(q.path, {});
  const offVerdict = verdicts(off.mock);
  if (!offVerdict.ran.every(Boolean)) findings.push(`off: not every call ran: ${JSON.stringify(offVerdict)} rc ${off.r.status} ${off.r.stderr.slice(0, 300)}`);
  if (off.markers.length !== 6) findings.push(`off: markers ${off.markers.join(', ')} (want all six)`);
};
test('sandboxed Bash fails CLOSED under quaude: every call refused, nothing written, from any settings source; off, all run', { skip: SKIP }, async (t) => {
  const q = builtQuaude();
  if (q.skip) { t.skip(q.skip); return; }
  if (!nativeWouldSandbox()) { t.skip('native would not sandbox here (no bubblewrap or socat, or WSL1): the fail-closed branch cannot be judged'); return; }
  // The cells: the refusals judge Bash with the sandbox enabled; the runs judge the sandbox-off turn (print, in bash).
  assertFailsOnMissingOutput(refused1, M1, 'sandbox:on');
  assertFailsOnMissingOutput(refused2, M2, 'sandbox:on');
  assertFailsOnMissingOutput(refused3, M3, 'sandbox:on');
  assertFailsOnMissingOutput(ran1, M1, ['print', 'shell:bash']);
  assertFailsOnMissingOutput(ran2, M2, ['print', 'shell:bash']);
  assertFailsOnMissingOutput(ran3, M3, ['print', 'shell:bash']);
  const findings = [];
  for (const c of ON_CASES) {
    const { mock, markers, r } = await runCase(q.path, c);
    const verdict = verdicts(mock);
    if (STARTUP_REFUSAL.test(r.stderr)) findings.push(`${c.name}: refused to START (native starts): rc ${r.status} ${r.stderr.slice(0, 300)}`);
    if (markers.length) findings.push(`${c.name}: wrote ${markers.join(', ')} (ran unsandboxed)`);
    if (!verdict.refused.every(Boolean)) findings.push(`${c.name}: not every call was refused by the required branch: ${JSON.stringify(verdict)} rc ${r.status} ${r.stderr.slice(0, 300)}`);
  }
  await sandboxOff(q, findings);
  assert.deepStrictEqual(findings, []);
});

test('where native would not sandbox, quaude does as native does (D2): its warning, and every call runs', { skip: SKIP }, async (t) => {
  const q = builtQuaude();
  if (q.skip) { t.skip(q.skip); return; }
  if (nativeWouldSandbox()) { t.skip('native would sandbox here: the D2 branch does not apply'); return; }
  // The cells: the sandbox-off turn, as in the first test. The enabled turn here is D2 (warn and run), which is not
  // the sandbox:on cell: that cell is the fail-closed branch.
  assertFailsOnMissingOutput(ran1, M1, ['print', 'shell:bash']);
  assertFailsOnMissingOutput(ran2, M2, ['print', 'shell:bash']);
  assertFailsOnMissingOutput(ran3, M3, ['print', 'shell:bash']);
  const findings = [];
  for (const c of ON_CASES) {
    const { mock, markers, r } = await runCase(q.path, c);
    const verdict = verdicts(mock);
    if (STARTUP_REFUSAL.test(r.stderr)) findings.push(`${c.name}: refused to START (native starts): rc ${r.status} ${r.stderr.slice(0, 300)}`);
    if (!NATIVE_WARNING.test(r.stderr)) findings.push(`${c.name}: no native sandbox warning: rc ${r.status} ${r.stderr.slice(0, 300)}`);
    if (!verdict.ran.every(Boolean) || markers.length !== 6) findings.push(`${c.name}: not every call ran as native runs it: ${JSON.stringify(verdict)} markers ${markers.join(', ')}`);
  }
  await sandboxOff(q, findings);
  assert.deepStrictEqual(findings, []);
});

test('the user\'s --settings is honoured under quaude: env, hooks and permissions apply, the update guard still runs, an unusable value is the bundle\'s own error', { skip: SKIP }, async (t) => {
  const q = builtQuaude();
  if (q.skip) { t.skip(q.skip); return; }
  // The cells: E and U run under --dangerously-skip-permissions; bashDisabled is a plain -p turn.
  assertFailsOnMissingOutput(envHonoured, E, 'permission:bypassPermissions');
  assertFailsOnMissingOutput(updateDenied, U, 'permission:bypassPermissions');
  // bashDisabled judges a SWITCH's effect (--settings deny), never a cell: it passes on "No such tool available", so it
  // is vetted by the control that claims no cell (final-review I3), and drives nothing
  assertFailsOnMissingOutputClaimingNoCell(bashDisabled, E);
  const findings = [];

  // A FILE carrying env and a PreToolUse hook (the sandbox off): both apply, and quaude's update-guard hook runs too.
  const userHook = ({ base }) => ({ env: { FC_USER_ENV: 'honoured' },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `echo ran >> ${path.join(base, 'user-hook-ran')}` }] }] } });
  const h = await runCase(q.path, { files: { 'u.json': userHook }, script: [step(E), step(U)],
    args: ({ base }) => [...PRINT, '--dangerously-skip-permissions', '--settings', path.join(base, 'u.json')] });
  if (!envHonoured(h.mock)) findings.push(`--settings env not applied: ${JSON.stringify(toolResult(h.mock, E.id))} rc ${h.r.status} ${h.r.stderr.slice(0, 300)}`);
  if (!h.files.includes('user-hook-ran')) findings.push('--settings PreToolUse hook did not run');
  if (!updateDenied(h.mock)) findings.push(`quaude's update guard did not deny \`claude update\` beside the user's hook: ${JSON.stringify(toolResult(h.mock, U.id))}`);

  // A schema-invalid --settings file is dropped whole by the bundle (native too); the update guard is not in it, so it
  // still denies (fix round 1, I-1: it rides a session plugin beside a user --settings).
  const sch = await runCase(q.path, { files: { 'sch.json': { permissions: 5 } }, script: [step(U)],
    args: ({ base }) => [...PRINT, '--dangerously-skip-permissions', '--settings', path.join(base, 'sch.json')] });
  if (!updateDenied(sch.mock)) findings.push(`a schema-invalid --settings file took the update guard with it: ${JSON.stringify(toolResult(sch.mock, U.id))} rc ${sch.r.status} ${sch.r.stderr.slice(0, 300)}`);
  const schM = await runCase(q.path, { cfgFiles: MERGE_SEAM, files: { 'sch.json': { permissions: 5 } }, script: [step(U)],
    args: ({ base }) => [...PRINT, '--dangerously-skip-permissions', '--settings', path.join(base, 'sch.json')] });
  if (!updateDenied(schM.mock)) findings.push(`merge mode: a schema-invalid --settings file took the update guard with it: ${JSON.stringify(toolResult(schM.mock, U.id))} rc ${schM.r.status} ${schM.r.stderr.slice(0, 300)}`);

  // Inline JSON denying Bash: the tool is gone, as native measured ("No such tool available: Bash").
  const d = await runCase(q.path, { script: [step(E)], args: [...PRINT, '--settings', JSON.stringify({ permissions: { deny: ['Bash'] } })] });
  if (!bashDisabled(d.mock)) findings.push(`--settings permissions.deny not applied: ${JSON.stringify(toolResult(d.mock, E.id))} rc ${d.r.status} ${d.r.stderr.slice(0, 300)}`);

  // Values the bundle cannot use: its own error, rc 1, and no request ever made (nothing ran).
  const missing = await runCase(q.path, { args: fileArg('nope.json') });
  if (missing.r.status !== 1 || !/^Error: Settings file not found: .*nope\.json$/m.test(missing.r.stderr) || missing.mock.requests.length) {
    findings.push(`a missing --settings file: rc ${missing.r.status}, ${missing.mock.requests.length} request(s), stderr ${JSON.stringify(missing.r.stderr.slice(0, 300))}`);
  }
  const bad = await runCase(q.path, { args: [...PRINT, '--settings', '{"sandbox": }'] });
  if (bad.r.status !== 1 || !/^Error: Invalid JSON provided to --settings$/m.test(bad.r.stderr) || bad.mock.requests.length) {
    findings.push(`invalid inline --settings: rc ${bad.r.status}, ${bad.mock.requests.length} request(s), stderr ${JSON.stringify(bad.r.stderr.slice(0, 300))}`);
  }
  assert.deepStrictEqual(findings, []);
});
