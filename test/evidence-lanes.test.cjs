'use strict';
// The netbsd-arm64 local VM run's lanes (scripts/netbsd-arm64-evidence.mjs LANES, the layout the emulated CI job used)
// pick tests by name pattern, so a pattern that matches nothing is a DARK gate (a driver that never runs: its cells go
// red in the driven-local evidence as "not run") and one that matches twice is a wasted turn. This lists the real test
// names of the files the runs name (a plain run with no quaude: every test is reported, skipped or not), applies node's
// pattern semantics, and requires EVERY test to be selected by exactly one run, and every run to select something.
// test/file-watchdog.cjs limits each FILE per process, so one run = one file process.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { defineGuard, guardTests } = require('./guard.cjs');

const REPO = path.resolve(__dirname, '..');
// require of an ES module (node >= 22.12), by path: its main() runs only when it is the entry point
const EVIDENCE = require(path.join(REPO, 'scripts', 'netbsd-arm64-evidence.mjs'));

function laneRuns() {
  return EVIDENCE.LANES.flat().map((r) => ({ id: r.id, names: r.names || [], skips: r.skips || [], files: [r.file] }));
}

function listTests(files) {
  const env = { ...process.env, CLODE_QUAUDE: '/nonexistent/quaude-for-listing' };
  delete env.NODE_TEST_CONTEXT; // a nested runner inside a test process would report to its parent, not to stdout
  const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=./test/cell-reporter.mjs', ...files],
    { cwd: REPO, encoding: 'utf8', env, timeout: 120000 });
  return r.stdout.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)).filter((x) => x.nesting === 0 && x.line && !/\.test\.cjs$/.test(x.name));
}

const FILES = EVIDENCE.FILES;
// the reporter's file is the OS's own spelling (D:\\a\\clode\\test\\fidelity\\x.test.cjs on Windows, CI 44810612058), the run's is
// POSIX: compare them in one spelling
const slashed = (f) => String(f).replace(/\\/g, '/');
const selects = (run, t) => run.files.some((f) => slashed(t.file).endsWith(f))
  && (!run.names.length || run.names.some((p) => new RegExp(p).test(t.name)))
  && !run.skips.some((p) => new RegExp(p).test(t.name));

const lanesGuard = defineGuard({
  name: 'evidence-lanes: the netbsd-arm64 VM run selects every test of its files exactly once',
  read() {
    const runs = laneRuns();
    return { runs, tests: listTests(FILES), runner: fs.readFileSync(path.join(REPO, 'scripts', 'netbsd-arm64-evidence.mjs'), 'utf8') };
  },
  scan({ runs, tests, runner }) {
    const findings = [];
    // the lanes proven here are the lanes the guest runs: each lane's runs in order, every lane at once, each run's
    // patterns from runArgs (a second list in the guest would make this proof about nothing)
    if (!/LANES\.map\(async \(lane, i\) => \{ for \(const r of lane\) await runOne\(i \+ 1, r\); \}\)/.test(runner || '')
      || !/\.\.\.runArgs\(r\)\]/.test(runner || '')) {
      findings.push('scripts/netbsd-arm64-evidence.mjs no longer runs LANES through runOne/runArgs: the guest runs some other list');
    }
    if (runs.length < 8) findings.push(`found only ${runs.length} runs: the reader is blind`);
    const files = [...new Set(runs.flatMap((r) => r.files))].sort();
    if (JSON.stringify(files) !== JSON.stringify(FILES)) findings.push(`the runs name ${files.join(', ')}, not ${FILES.join(', ')}`);
    for (const t of tests) {
      const by = runs.filter((r) => selects(r, t)).map((r) => r.id);
      if (by.length !== 1) findings.push(`${path.posix.basename(slashed(t.file))}:${t.line} "${t.name}" is selected by ${by.length ? by.join(' and ') : 'no run'}`);
    }
    for (const r of runs) if (!tests.some((t) => selects(r, t))) findings.push(`run ${r.id} selects no test`);
    return { findings, examined: tests.length };
  },
  floor: 20,
  control() {
    // a lane pattern that drops `interactive`, and one run that doubles another: both must be reported
    const runs = laneRuns();
    return { runs: [...runs.filter((r) => r.id !== 'modes3-tools'), { ...runs.find((r) => r.id === 'modes1-tools'), id: 'dup' }], tests: CONTROL_TESTS,
      runner: 'for (const r of OTHER_LIST) await runOne(1, r);' };
  },
});
const CONTROL_TESTS = [
  { file: '/r/test/fidelity/tools-local.test.cjs', line: 915, name: "every Phase A call in a built quaude in unlisted: each tool_result" },
  { file: '/r/test/fidelity/tools-local.test.cjs', line: 915, name: "every Phase A call in a built quaude in print: each tool_result" },
  ...Array.from({ length: 20 }, (_, i) => ({ file: '/r/test/fidelity/agentic-grep-glob.test.cjs', line: 100 + i, name: `filler ${i}` })),
];
guardTests(lanesGuard);

test('evidence-lanes: a Windows-spelled reported file is matched to the run\'s POSIX path (CI 44810612058)', () => {
  const run = { id: 'x', names: [], skips: [], files: ['test/fidelity/tools-local.test.cjs'] };
  assert.ok(selects(run, { file: 'D:\\a\\clode\\clode\\test\\fidelity\\tools-local.test.cjs', name: 't' }));
  assert.ok(selects(run, { file: '/a/clode/test/fidelity/tools-local.test.cjs', name: 't' }));
  assert.ok(!selects(run, { file: 'D:\\a\\clode\\test\\fidelity\\agentic-grep-glob.test.cjs', name: 't' }));
});
