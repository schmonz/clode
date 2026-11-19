'use strict';
// file-watchdog — a test file that never finishes is a named red failure within its limit (test/file-watchdog.cjs).
// The 2026-11-19 shape: a promise that never settles while something holds the event loop open. Before the watchdog,
// the full suite sat 9h40m on it with no output. Round 5: a synchronous call that never returns, too.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnCollect } = require('./spawn-collect.cjs');
const { defineGuard, guardTests } = require('./guard.cjs');
const W = require('./file-watchdog.cjs');

// THE CONTROLS, end to end under the real node:test, run the way test/run.mjs runs the suite (`node --require <preload>
// --test`), with a short limit given by a preload that calls the same arm() and records its sleeper's pid. Planted:
//   - an ASYNC hang: a test that never settles while an interval holds the loop open (the 2026-11-19 shape);
//   - a SYNC hang: a spawnSync of a child that sleeps forever, so the file's own event loop never runs again (no timer
//     inside the file could fire: why the watchdog is out of process);
//   - a quick file, which must pass untouched.
// Each hang must come back `not ok`, named, within the limit plus startup; afterwards no sleeper and no planted child
// may be alive (the sync hang's grandchild records its own pid, since its parent is blocked).
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
async function waitGone(pids, ms = 10000) {
  const t0 = Date.now();
  let left = pids;
  while ((left = left.filter(alive)).length && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 100));
  return left;
}
test('CONTROL: an async hang and a sync hang each fail by name within the limit, a quick file passes, nothing survives', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-watchdog-'));
  try {
    const asyncHang = path.join(dir, 'planted-async-hang.test.cjs');
    const syncHang = path.join(dir, 'planted-sync-hang.test.cjs');
    const quick = path.join(dir, 'quick.test.cjs');
    const grandPidFile = path.join(dir, 'grandchild.pid');
    fs.writeFileSync(asyncHang, "const test = require('node:test');\nsetInterval(() => {}, 1000);\n"
      + "test('never settles', async () => { await new Promise(() => {}); });\n");
    const sleeperForever = `require('fs').writeFileSync(${JSON.stringify(grandPidFile)}, String(process.pid)); setInterval(() => {}, 1e9);`;
    fs.writeFileSync(syncHang, "const test = require('node:test');\n"
      + `test('never returns', () => { require('node:child_process').spawnSync(process.execPath, ['-e', ${JSON.stringify(sleeperForever)}]); });\n`);
    fs.writeFileSync(quick, "require('node:test')('quick', () => {});\n");
    const preload = path.join(dir, 'short-preload.cjs');
    fs.writeFileSync(preload, `const w = require(${JSON.stringify(require.resolve('./file-watchdog.cjs'))});\n`
      + 'if (w.shouldArm(process)) {\n'
      + '  const s = w.arm(process.argv[1], 2000);\n'
      + `  require('fs').appendFileSync(${JSON.stringify(path.join(dir, 'sleepers'))}, s.pid + '\\n');\n`
      + '}\n');
    const t0 = Date.now();
    const r = await spawnCollect(process.execPath,
      ['--require', preload, '--test', '--test-concurrency=3', '--test-reporter', 'tap', asyncHang, syncHang, quick],
      // NODE_TEST_CONTEXT dropped: inherited from THIS file's process, it would make the inner runner a reporting child.
      { cwd: dir, env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT')) },
      { timeoutMs: 90000 });
    const ms = Date.now() - t0;
    const out = r.stdout + r.stderr;
    assert.strictEqual(r.timedOut, false, `the watchdog never fired: the run was killed after ${ms}ms\n${out}`);
    assert.notStrictEqual(r.status, 0, 'a hung file must turn the run red');
    for (const name of ['planted-async-hang', 'planted-sync-hang']) {
      assert.match(r.stdout, new RegExp(`not ok \\d+ - \\S*${name}\\.test\\.cjs$`, 'm'), out);
      assert.match(out, new RegExp(`file-watchdog: \\S*${name}\\.test\\.cjs was still running 2s after it started`), out);
    }
    assert.match(r.stdout, /^ok \d+ - quick$/m, 'the quick file beside them passed');
    assert.ok(ms < 45000, `named in ${ms}ms, not within the limit plus startup`);
    const sleepers = fs.readFileSync(path.join(dir, 'sleepers'), 'utf8').trim().split('\n').map(Number);
    assert.strictEqual(sleepers.length, 3, 'one sleeper per test file, none for the runner');
    const grand = Number(fs.readFileSync(grandPidFile, 'utf8'));
    assert.deepStrictEqual(await waitGone([...sleepers, grand]), [], 'a sleeper or the planted child survived the run');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('shouldArm: a node:test per-file process running a .test.cjs file; never the runner, never a spawned child', () => {
  const file = { execArgv: ['--require=x'], env: { NODE_TEST_CONTEXT: 'child-v8' }, argv: ['node', '/r/test/a.test.cjs'] };
  assert.strictEqual(W.shouldArm(file), true);
  assert.strictEqual(W.shouldArm({ ...file, execArgv: ['--require', 'x', '--test'] }), false, 'the runner');
  assert.strictEqual(W.shouldArm({ ...file, env: {} }), false, 'not under node:test');
  assert.strictEqual(W.shouldArm({ ...file, argv: ['node', '/r/scripts/x.cjs'] }), false, 'a script a test spawned');
});

test('arm: one sleeper, given the pid, the limit and the file, on an IPC channel, never holding the file open', () => {
  let call = null, unref = 0;
  const fake = { pid: 7, unref: () => { unref++; }, channel: { unref: () => { unref++; } } };
  const file = path.join(W.REPO, 'test', 'x.test.cjs');
  W.arm(file, 90000, { pid: 4242, env: { NODE_OPTIONS: '--require forced', NODE_TEST_CONTEXT: 'child-v8', KEEP: '1' },
    spawn: (cmd, args, opts) => { call = { cmd, args, opts }; return fake; } });
  assert.deepStrictEqual(call.args, [W.SLEEPER, '4242', '90000', file]);
  assert.strictEqual(call.cmd, process.execPath);
  assert.deepStrictEqual(call.opts.stdio, ['ignore', 'ignore', 'inherit', 'ipc']);
  assert.deepStrictEqual(call.opts.env, { KEEP: '1' }, 'no preload and no test context reach the sleeper');
  assert.strictEqual(unref, 2);
  assert.match(W.message(file, 90000, [9]), /^file-watchdog: test\/x\.test\.cjs was still running 90s after it started.*pids still alive after the kill: 9/);
});

test('the sleeper: the tree it kills is every transitive descendant, and it exits when its file does', async () => {
  const { descendants } = require('./file-watchdog-sleeper.cjs');
  assert.deepStrictEqual(descendants([[10, 1], [11, 10], [12, 11], [13, 99], [14, 13]], 10).sort(), [11, 12]);
  // A real sleeper for a real short-lived parent: gone once the parent is.
  const { spawn } = require('node:child_process');
  const parent = spawn(process.execPath, ['-e',
    `const s = require(${JSON.stringify(require.resolve('./file-watchdog.cjs'))}).arm('x.test.cjs', 600000);
     console.log(s.pid); setTimeout(() => process.exit(0), 300);`], { stdio: ['ignore', 'pipe', 'inherit'] });
  let so = '';
  parent.stdout.on('data', (d) => { so += d; });
  await new Promise((r) => parent.on('close', r));
  const sleeper = Number(so.trim());
  assert.ok(sleeper > 0, so);
  assert.deepStrictEqual(await waitGone([sleeper], 5000), [], 'the sleeper outlived its file');
});

test('limitFor: the default, or a file named in OVERRIDES', () => {
  assert.strictEqual(W.limitFor(path.join(W.REPO, 'test', 'anything.test.cjs')), W.DEFAULT_LIMIT_MS);
  assert.strictEqual(W.limitFor(path.join(W.REPO, 'test', 'unicode-data-fresh.test.cjs')), W.OVERRIDES['test/unicode-data-fresh.test.cjs'].ms);
});

// The wiring, read from source, so a guard: both of run.mjs's node --test passes carry the preload; so does EVERY
// `node ... --test` a workflow or action runs directly (a hang there would burn the job's whole 6h timeout); and every
// override names a test file that exists, with a reason, above the default (an override below it is a typo).
// A workflow line is matched as `node`, its flags, then exactly `--test`; comment and echo lines are passed over.
// BLIND SPOT: an invocation whose `--test` is on a continuation line after a bare `node \\`.
const CI_PRELOAD = '--require ./test/file-watchdog-preload.cjs';
const NODE_TEST = /\bnode((?:\s+-[-\w=./]+(?:\s+\.\/[\w./-]+)?)*)\s+--test(?=\s|$)/g;
function scanWorkflows(workflows) {
  const findings = [];
  let examined = 0;
  for (const { rel, text } of workflows) {
    text.split('\n').forEach((line, i) => {
      if (/^\s*#/.test(line) || /\becho\b/.test(line)) return;
      for (const m of line.matchAll(NODE_TEST)) {
        examined++;
        if (!m[1].includes(CI_PRELOAD)) findings.push(`${rel}:${i + 1}: node --test without the file watchdog (${CI_PRELOAD}): ${line.trim().slice(0, 100)}`);
      }
    });
  }
  return { findings, examined };
}
// THE BACKSTOP: every job in ci.yml carries timeout-minutes, or calls a reusable workflow whose every job does
// (GitHub refuses timeout-minutes on a job that calls one). Jobs are the two-space keys under `jobs:`; a job's own
// keys are at four spaces.
function jobsOf(text) {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => /^jobs:/.test(l));
  if (at < 0) return [];
  const jobs = [];
  let cur = null;
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^\S/.test(l)) break;
    const m = /^  ([\w-]+):\s*$/.exec(l);
    if (m) { cur = { name: m[1], line: i + 1, timeout: false, uses: null }; jobs.push(cur); continue; }
    if (!cur) continue;
    if (/^    timeout-minutes:\s*\S/.test(l)) cur.timeout = true;
    const u = /^    uses:\s*\.\/(\.github\/workflows\/[\w.-]+\.ya?ml)/.exec(l);
    if (u) cur.uses = u[1];
  }
  return jobs;
}
const CI = '.github/workflows/ci.yml';
function scanJobTimeouts(workflows) {
  const byRel = new Map(workflows.map((w) => [w.rel, w.text]));
  const findings = [];
  let examined = 0;
  if (!byRel.has(CI)) return { findings: [`${CI} was not read`], examined };
  for (const job of jobsOf(byRel.get(CI))) {
    examined++;
    if (job.uses) {
      const called = byRel.get(job.uses);
      if (called === undefined) { findings.push(`${CI}:${job.line}: job ${job.name} calls ${job.uses}, which was not read`); continue; }
      for (const j of jobsOf(called)) {
        examined++;
        if (!j.timeout) findings.push(`${job.uses}:${j.line}: job ${j.name} (called by ci.yml's ${job.name}) has no timeout-minutes`);
      }
    } else if (!job.timeout) findings.push(`${CI}:${job.line}: job ${job.name} has no timeout-minutes (GitHub's default is 6 hours)`);
  }
  return { findings, examined };
}
function scanWiring({ runMjs, overrides, exists, workflows = [], jobsRequired = true }) {
  const findings = [];
  const spawns = runMjs.split(/spawnSync\(process\.execPath, \[/).slice(1).filter((s) => /^\s*(?:'--require', WATCHDOG,\s*)?'--test'/.test(s));
  for (const [i, s] of spawns.entries()) {
    if (!/^\s*'--require', WATCHDOG,\s*'--test'/.test(s)) findings.push(`test/run.mjs: node --test pass ${i + 1} runs without the file watchdog`);
  }
  if (!/const WATCHDOG = path\.join\(HERE, 'file-watchdog-preload\.cjs'\);/.test(runMjs)) findings.push('test/run.mjs: WATCHDOG is not the preload');
  for (const [rel, o] of Object.entries(overrides)) {
    if (!exists(rel)) findings.push(`OVERRIDES: ${rel} does not exist`);
    if (!o || typeof o.why !== 'string' || o.why.length < 20) findings.push(`OVERRIDES: ${rel} gives no reason`);
    if (!o || !(o.ms > W.DEFAULT_LIMIT_MS)) findings.push(`OVERRIDES: ${rel} is not above the default`);
  }
  const wf = scanWorkflows(workflows);
  findings.push(...wf.findings);
  const jt = jobsRequired ? scanJobTimeouts(workflows) : { findings: [], examined: 0 };
  findings.push(...jt.findings);
  return { findings, examined: spawns.length + Object.keys(overrides).length + wf.examined + jt.examined };
}
const WORKFLOW_DIRS = [path.join(W.REPO, '.github', 'workflows'), path.join(W.REPO, '.github', 'actions')];
function readWorkflows() {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.ya?ml$/.test(e.name) && !e.name.startsWith('.')) out.push({ rel: W.relOf(p), text: fs.readFileSync(p, 'utf8') });
    }
  };
  for (const d of WORKFLOW_DIRS) walk(d);
  return out;
}
guardTests(defineGuard({
  name: 'file-watchdog-wiring',
  floor: 2,
  read: () => ({
    runMjs: fs.readFileSync(path.join(__dirname, 'run.mjs'), 'utf8'),
    overrides: W.OVERRIDES,
    exists: (rel) => fs.existsSync(path.join(W.REPO, rel)),
    workflows: readWorkflows(),
  }),
  scan: scanWiring,
  control: () => ({
    runMjs: "const WATCHDOG = path.join(HERE, 'file-watchdog-preload.cjs');\nconst res = spawnSync(process.execPath, [\n  '--test',\n  ...files]);",
    overrides: { 'test/gone.test.cjs': { ms: 1, why: '' } },
    exists: () => false,
    workflows: [{ rel: 'planted.yml', text: '      run: CLODE_X=1 node --test --test-concurrency=1 test/a.test.cjs' },
      { rel: CI, text: 'jobs:\n  new-job:\n    runs-on: ubuntu-latest\n    steps: []\n' }],
  }),
}));

test('the workflow rule: exactly --test, after node and its flags; the preload anywhere among them', () => {
  const wf = (text) => scanWorkflows([{ rel: 'w.yml', text }]);
  assert.strictEqual(wf('run: node --test x.test.cjs').findings.length, 1);
  assert.strictEqual(wf('run: node --test-name-pattern=x --test x').findings.length, 1);
  assert.deepStrictEqual(wf('run: node --require ./test/file-watchdog-preload.cjs --test x'), { findings: [], examined: 1 });
  assert.deepStrictEqual(wf('  # node --test in a comment\n  echo "node --test summaries"'), { findings: [], examined: 0 });
  assert.deepStrictEqual(wf('run: node scripts/x.cjs --test').examined, 0, 'a script taking its own --test flag is not node --test');
  assert.ok(readWorkflows().length > 3, 'the workflows were read');
});

test('the job rule: timeout-minutes on each ci.yml job, or on every job of the workflow it calls', () => {
  const ci = (body) => ({ rel: CI, text: `on: push\njobs:\n${body}` });
  assert.deepStrictEqual(scanJobTimeouts([ci('  a:\n    runs-on: x\n    timeout-minutes: 45\n    steps: []\n')]).findings, []);
  assert.match(scanJobTimeouts([ci('  a:\n    runs-on: x\n    steps:\n      - run: echo\n        timeout-minutes: 5\n')]).findings[0],
    /job a has no timeout-minutes/, "a STEP timeout is not the job's");
  const called = { rel: '.github/workflows/s.yml', text: 'on: workflow_call\njobs:\n  s:\n    runs-on: x\n' };
  assert.match(scanJobTimeouts([ci('  t:\n    uses: ./.github/workflows/s.yml\n'), called]).findings[0], /s\.yml:3: job s \(called by ci\.yml's t\)/);
  const ok = { ...called, text: called.text + '    timeout-minutes: 90\n' };
  assert.deepStrictEqual(scanJobTimeouts([ci('  t:\n    uses: ./.github/workflows/s.yml\n'), ok]).findings, []);
});
