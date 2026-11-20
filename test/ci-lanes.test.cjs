'use strict';
// netbsd-arm64-cells' lanes (.github/workflows/ci.yml) pick tests by name pattern, so a pattern that matches
// nothing is a DARK gate (a driver that never runs) and one that matches twice is a wasted TCG turn. This
// reads the job's `run <id> [--test-name-pattern=..] [--test-skip-pattern=..] FILE` lines, lists the real test
// names of the files they run (a plain run with no quaude: every test is reported, skipped or not), applies
// node's pattern semantics, and requires EVERY test to be selected by exactly one run, and every run to select
// something. test/file-watchdog.cjs limits each FILE per process, so one run = one file process.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const yml = fs.readFileSync(path.join(REPO, '.github/workflows/ci.yml'), 'utf8');

function laneRuns() {
  const start = yml.indexOf('            TL=test/fidelity/tools-local.test.cjs');
  const end = yml.indexOf('            wait\n', start);
  assert.ok(start > 0 && end > start, 'the lane block moved: this reader is blind');
  const block = yml.slice(start, end);
  const vars = {};
  for (const m of block.matchAll(/^\s*([A-Z]+)=(\S+)$/gm)) vars[m[1]] = m[2];
  const subst = (s) => s.replace(/\$([A-Z]+)\b/g, (_, k) => vars[k] ?? `$${k}`);
  // `agentic ID SUFFIX` is the helper's shorthand for one agentic-grep-glob run
  const h = /^\s*agentic\(\) \{ run "\$1" --test-name-pattern="([^"]*)\$2([^"]*)" (\S+); \}/m.exec(block);
  assert.ok(h, 'the agentic() helper moved: this reader is blind');
  const agentic = { pre: h[1], post: h[2], file: subst(h[3]) };
  const runs = [];
  for (const line of block.split('\n')) {
    const t = line.trim();
    let m;
    if ((m = /^run (\S+) (.*)$/.exec(t))) {
      const names = [...m[2].matchAll(/--test-name-pattern='([^']*)'/g)].map((x) => x[1]);
      const skips = [...m[2].matchAll(/--test-skip-pattern='([^']*)'/g)].map((x) => x[1]);
      const files = m[2].replace(/--test-(name|skip)-pattern='[^']*'/g, '').trim().split(/\s+/).filter(Boolean).map(subst);
      runs.push({ id: m[1], names, skips, files });
    } else if ((m = /^agentic (\S+) '([^']*)'$/.exec(t))) {
      runs.push({ id: m[1], names: [agentic.pre + m[2] + agentic.post], skips: [], files: [agentic.file] });
    }
  }
  return runs;
}

function listTests(files) {
  const env = { ...process.env, CLODE_QUAUDE: '/nonexistent/quaude-for-listing' };
  delete env.NODE_TEST_CONTEXT; // a nested runner inside a test process would report to its parent, not to stdout
  const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=./test/cell-reporter.mjs', ...files],
    { cwd: REPO, encoding: 'utf8', env, timeout: 120000 });
  return r.stdout.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)).filter((x) => x.nesting === 0 && x.line && !/\.test\.cjs$/.test(x.name));
}

test('netbsd-arm64-cells lanes: every test of its two files is selected by exactly one run, and no run selects nothing', () => {
  const runs = laneRuns();
  assert.ok(runs.length >= 8, `found only ${runs.length} runs`);
  const files = [...new Set(runs.flatMap((r) => r.files))].sort();
  assert.deepStrictEqual(files, ['test/fidelity/agentic-grep-glob.test.cjs', 'test/fidelity/tools-local.test.cjs']);
  const tests = listTests(files);
  assert.ok(tests.length > 20, `listed only ${tests.length} tests`);
  const selects = (run, t) => run.files.some((f) => t.file.endsWith(f))
    && (!run.names.length || run.names.some((p) => new RegExp(p).test(t.name)))
    && !run.skips.some((p) => new RegExp(p).test(t.name));
  const findings = [];
  for (const t of tests) {
    const by = runs.filter((r) => selects(r, t)).map((r) => r.id);
    if (by.length !== 1) findings.push(`${path.basename(t.file)}:${t.line} "${t.name}" is selected by ${by.length ? by.join(' and ') : 'no run'}`);
  }
  for (const r of runs) if (!tests.some((t) => selects(r, t))) findings.push(`run ${r.id} selects no test`);
  assert.deepStrictEqual(findings, []);
});
