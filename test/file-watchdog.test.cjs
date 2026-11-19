'use strict';
// file-watchdog — a test file that never finishes is a named red failure within its limit (test/file-watchdog.cjs).
// The 2026-11-19 shape: a promise that never settles while something holds the event loop open. Before the watchdog,
// the full suite sat 9h40m on it with no output.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnCollect } = require('./spawn-collect.cjs');
const { defineGuard, guardTests } = require('./guard.cjs');
const W = require('./file-watchdog.cjs');

// THE CONTROL, end to end under the real node:test: a planted file whose test never settles and whose loop is held
// open, run the way test/run.mjs runs the suite (`node --require <preload> --test`), with a short limit given by a
// preload that calls the same arm(). It must come back red, naming the file, within the limit plus startup.
// A quick file beside it must pass, untouched: the timer is unref'd and per file.
test('CONTROL: a planted never-settling test file fails by name within its limit; a quick one beside it passes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-watchdog-'));
  try {
    const hung = path.join(dir, 'planted-hang.test.cjs');
    const quick = path.join(dir, 'quick.test.cjs');
    fs.writeFileSync(hung, "const test = require('node:test');\nsetInterval(() => {}, 1000);\n"
      + "test('never settles', async () => { await new Promise(() => {}); });\n");
    fs.writeFileSync(quick, "require('node:test')('quick', () => {});\n");
    const preload = path.join(dir, 'short-preload.cjs');
    fs.writeFileSync(preload, `const w = require(${JSON.stringify(require.resolve('./file-watchdog.cjs'))});\n`
      + 'if (w.shouldArm(process)) w.arm(process.argv[1], 1500);\n');
    const t0 = Date.now();
    const r = await spawnCollect(process.execPath, ['--require', preload, '--test', '--test-reporter', 'tap', hung, quick],
      // NODE_TEST_CONTEXT dropped: inherited from THIS file's process, it would make the inner runner a reporting child.
      { cwd: dir, env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT')) },
      { timeoutMs: 60000 });
    const ms = Date.now() - t0;
    assert.strictEqual(r.timedOut, false, `the watchdog never fired: the run was killed after ${ms}ms`);
    assert.notStrictEqual(r.status, 0, 'a hung file must turn the run red');
    assert.match(r.stdout, /not ok \d+ - \S*planted-hang\.test\.cjs$/m, r.stdout);
    assert.match(r.stdout + r.stderr, /file-watchdog: \/\S*planted-hang\.test\.cjs was still running 2s after it started/);
    assert.match(r.stdout, /^ok \d+ - quick$/m, 'the quick file beside it passed');
    assert.ok(ms < 30000, `named in ${ms}ms, not within the limit plus startup`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('shouldArm: a node:test per-file process running a .test.cjs file; never the runner, never a spawned child', () => {
  const file = { execArgv: ['--require=x'], env: { NODE_TEST_CONTEXT: 'child-v8' }, argv: ['node', '/r/test/a.test.cjs'] };
  assert.strictEqual(W.shouldArm(file), true);
  assert.strictEqual(W.shouldArm({ ...file, execArgv: ['--require', 'x', '--test'] }), false, 'the runner');
  assert.strictEqual(W.shouldArm({ ...file, env: {} }), false, 'not under node:test');
  assert.strictEqual(W.shouldArm({ ...file, argv: ['node', '/r/scripts/x.cjs'] }), false, 'a script a test spawned');
});

test('arm: at the limit it names the file and exits 1; the timer never holds the process open', () => {
  let fired = null, unref = false, out = '', code = null;
  W.arm(path.join(W.REPO, 'test', 'x.test.cjs'), 90000, {
    setTimer: (fn, ms) => { fired = { fn, ms }; return { unref: () => { unref = true; } }; },
    write: (s) => { out += s; }, exit: (c) => { code = c; },
  });
  assert.strictEqual(fired.ms, 90000);
  assert.strictEqual(unref, true);
  fired.fn();
  assert.strictEqual(code, 1);
  assert.match(out, /^file-watchdog: test\/x\.test\.cjs was still running 90s after it started/);
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
function scanWiring({ runMjs, overrides, exists, workflows = [] }) {
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
  return { findings, examined: spawns.length + Object.keys(overrides).length + wf.examined };
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
    workflows: [{ rel: 'planted.yml', text: '      run: CLODE_X=1 node --test --test-concurrency=1 test/a.test.cjs' }],
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
