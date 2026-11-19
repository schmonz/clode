'use strict';
// THE CI GATE MANIFEST: which CI job must RUN which gate (observability plan Task 5).
//
// WHY. A gate that skips is indistinguishable from a gate that passed unless something says, by
// NAME, that it had to run. Each CI job used to say that with a skip COUNT at most (node-shim-oracle
// "exactly 2", linux-x64-pty "0" per step): a count names nothing, so a skip that replaced another
// skip, or a gate that quietly moved out of every job, read the same as a pass. This file is the one
// place that names it, and test/gates-ran-in-ci.test.cjs holds CI to it:
//
//   ci-gate-placement (every suite run)   this manifest agrees with the tree and the workflows:
//                                          every name is a registered gate, every job exists and
//                                          uploads its gate list, every placed file is one its job
//                                          runs, and every CI job that runs a gate file is declared.
//   gates-ran-in-ci   (CI's gates-ran-in-ci job, over every job's uploaded gate list)
//                                          every gate a job must run PASSED there, by name; a skip,
//                                          a failure, a gate that never appeared, or a job that
//                                          uploaded no gate list at all, is a finding.
//
// A GATE is a guard registered through test/guard.cjs's defineGuard (its node:test case is
// `guard gate: <name>`), the registry being the source of truth for the universe; plus the named
// gate FILES below, whose every test the job accounts for (the files linux-x64-pty and its siblings
// used to account for by skip count).
//
// THE DEFAULT IS THE SUITE. test/run.mjs runs every test file, so both suite rows (suite.yml's
// ubuntu-latest and windows-latest) must run, and pass, EVERY registered gate, except:
//   PLACED  a gate a suite row cannot run, and the job(s) that must run it instead (with why);
//   EXEMPT  a gate no CI job runs, by name, with the measured reason (or the BACKLOG entry).
// A new gate is therefore declared the moment it is registered: if it skips in the suite it is
// named there until someone places it where it can run, or exempts it.
//
// Records are what test/cell-reporter.mjs writes ({ type, file, name, skip, todo }), one dir per job:
// the aggregator downloads every `gates-ran-<job id>` artifact into CLODE_GATES_RAN.
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');

// ==========================================================================
// THE JOBS that run gates. `id` is the artifact suffix (`gates-ran-<id>`); `workflow` and `job`
// locate the text that runs the job (job null: the whole file, a composite action); `carries` are
// strings that text must hold beyond the upload (a suite row's matrix entry).
// ==========================================================================
const CI = '.github/workflows/ci.yml';
const RELEASE = '.github/workflows/release.yml';
const SUITE = '.github/workflows/suite.yml';
const LEG = '.github/actions/build-leg/action.yml';
// THE ENGINE LEGS, from scripts/tjs-legs.mjs itself (require of an ES module: node >= 22.12). Every leg runs the
// build-leg action's hermeticity step and uploads gates-ran-leg-<leg>; every one is judged (measured, CI run
// 44597568635: engine-hermeticity passed in all 29 ci-tier legs). A soft-fail leg is not: it may stop before the
// step with its job still green, and it ships nothing (ci tier: none; release tier: the engine-only darwin slices).
const TJS_LEGS = require('../scripts/tjs-legs.mjs');
const judgedLegs = (tier) => TJS_LEGS.legsFor(tier).filter((l) => !l['soft-fail']).map((l) => l.leg);
const legJob = (leg) => ({ id: `leg-${leg}`, workflow: LEG, job: null, leg });
const JOBS = [
  { id: 'test-ubuntu-latest', workflow: SUITE, job: 'suite', carries: ['os: ubuntu-latest'], suite: true },
  { id: 'test-windows-latest', workflow: SUITE, job: 'suite', carries: ['os: windows-latest'], suite: true },
  { id: 'node-shim-oracle', workflow: CI, job: 'node-shim-oracle' },
  { id: 'node-shim-oracle-darwin', workflow: CI, job: 'node-shim-oracle-darwin' },
  { id: 'native-builder-oracle', workflow: CI, job: 'native-builder-oracle' },
  { id: 'linux-x64-pty', workflow: CI, job: 'linux-x64-pty' },
  { id: 'windows-amd64-tests', workflow: CI, job: 'windows-amd64-tests' },
  { id: 'windows-arm64-tests', workflow: CI, job: 'windows-arm64-tests' },
  { id: 'windows-amd64-tui', workflow: CI, job: 'windows-amd64-tui' },
  // The engine legs (tjs-legs.yml's `leg`, which every tier calls) run the suite-side hermeticity
  // check through the build-leg action, and each uploads its own list (gates-ran-<github.job>-<leg>).
  ...judgedLegs('ci').map(legJob),
];
// The job that judges the others: it downloads every gates-ran-* artifact and runs gates-ran-in-ci.
const AGGREGATOR = { workflow: CI, job: 'gates-ran-in-ci' };
// ci.yml's `needs` key for a job: a suite row is `test` (which calls suite.yml); an engine leg is `tjs` or `tjs-slow`,
// split by scripts/tjs-legs.mjs's own SLOW_CI_LEG exactly as those two jobs' `only: fast|slow` are; a job is itself.
const CI_LEGS = new Map(TJS_LEGS.legsFor('ci').map((l) => [l.leg, l]));
const ciNeed = (j) => (j.suite ? 'test' : j.leg ? (TJS_LEGS.SLOW_CI_LEG(CI_LEGS.get(j.leg)) ? 'tjs-slow' : 'tjs') : j.job);
const SUITE_ROWS = JOBS.filter((j) => j.suite).map((j) => j.id);

// ==========================================================================
// PLACED: gates a suite row cannot run. `jobs` must each run it and see it pass; `why` says what
// the suite lacks. Measured from CI run 44572930594 (666fb91, 2026-11-19): every gate below
// skipped in the suite row(s) it is not placed in, with the reason quoted.
// ==========================================================================
const NO_ENGINE = 'the suite has no tjs engine (CLODE_TJS): "no tjs engine"';
const NO_CARVE = 'the suite never seeds the pinned carve (~/.cache/clode/<pin>/graph.json): "pinned carve not found"';
const NO_STAGE = 'the suite cannot stage the provider without an engine: "provider found but staging it failed: '
  + '... residual cyclic require(s), which need the engine\'s own report"';
const MINIMISED = 'the suite\'s provider is stage-provider\'s minimised carve, which does not run as rg: '
  + '"the provider .../provider-min did not answer as rg here"';
const LIVE_SESSION = 'a live session gate skips inside the concurrent full suite by design (test/live-frame-gate.cjs): '
  + '"does not run inside the concurrent full suite (test/run.mjs)"';
const TEXT_ORACLE = 'needs the text-oracle native (CLODE_NATIVE_ORACLE) and the warm UCD cache, which only '
  + 'linux-x64-pty installs: "no tjs engine" / "offline and the UCD cache is cold"';
const PLACED = {
  // node-shim-oracle: CLODE_TJS + the staged provider + the seeded pinned carve.
  'shim-surface': { jobs: ['node-shim-oracle'], why: `${NO_ENGINE}; it measures the shim under the engine quaude ships` },
  'node-shim-differential': { jobs: ['node-shim-oracle', 'node-shim-oracle-darwin'], why: NO_ENGINE },
  'node-shim-wall-tripwires': { jobs: ['node-shim-oracle', 'node-shim-oracle-darwin'], why: NO_STAGE },
  'zstd-gap-carved-walls': { jobs: ['node-shim-oracle'], why: NO_STAGE },
  'regexp-capture-census': { jobs: ['node-shim-oracle'], why: NO_STAGE },
  'guard-subcommands-gate': { jobs: ['node-shim-oracle'], why: NO_CARVE },
  'guard-option-table-gate': { jobs: ['node-shim-oracle'], why: NO_CARVE },
  'dep-closure-unterminated-side-effect-import': { jobs: ['node-shim-oracle'], why: NO_CARVE },
  'dep-closure-unknown-bare-specifiers': { jobs: ['node-shim-oracle'], why: NO_CARVE },
  'lexical-code-mask-phantom-comment': { jobs: ['node-shim-oracle'], why: NO_CARVE },
  'merger-renameable-escape': { jobs: ['node-shim-oracle'], why: NO_CARVE },
  'merger-renameable-modifier': { jobs: ['node-shim-oracle'], why: NO_CARVE },
  'merger-renameable-computed-member': { jobs: ['node-shim-oracle'], why: NO_CARVE },
  'merger-renameable-generator-star': { jobs: ['node-shim-oracle'], why: NO_CARVE },
  'merger-renameable-static-block': { jobs: ['node-shim-oracle'], why: NO_CARVE },
  // node-shim-oracle-darwin: the only macOS job.
  'credential-store-attempted': { jobs: ['node-shim-oracle-darwin'],
    why: 'security(1) is darwin-only: "this guard has no other platform\'s credential-store call modeled yet"' },
  // Every CI cell job checks its cells with this guard (test/build-gates/tool-coverage-gates.test.cjs).
  'cells-ran-in-ci-job': { jobs: ['node-shim-oracle', 'node-shim-oracle-darwin', 'native-builder-oracle', 'linux-x64-pty'],
    why: 'it judges a cell job\'s own reporter output: "not a CI cell job (CLODE_CELL_JOB unset)"' },
  // linux-x64-pty: the PTY harness, the pinned native that runs as rg, the text oracle.
  'tui-initial-frame-cells': { jobs: ['linux-x64-pty'], why: NO_ENGINE },
  'tui-prompt-wide-glyphs': { jobs: ['linux-x64-pty'], why: NO_ENGINE },
  'tui-reply-hyperlinks': { jobs: ['linux-x64-pty'], why: NO_ENGINE },
  'tui-reply-wraps': { jobs: ['linux-x64-pty'], why: NO_ENGINE },
  'session-determinism': { jobs: ['linux-x64-pty'], why: LIVE_SESSION },
  'session-type-edit': { jobs: ['linux-x64-pty'], why: LIVE_SESSION },
  'session-resize': { jobs: ['linux-x64-pty'], why: LIVE_SESSION },
  'session-scroll': { jobs: ['linux-x64-pty'], why: LIVE_SESSION },
  'session-slash-menu': { jobs: ['linux-x64-pty'], why: LIVE_SESSION },
  'reset-patch-landed': { jobs: ['linux-x64-pty'], why: LIVE_SESSION },
  'reset-invisibility': { jobs: ['linux-x64-pty'], why: LIVE_SESSION },
  'rg-differential': { jobs: ['linux-x64-pty'], why: NO_ENGINE },
  'rg-every-surface-tjs': { jobs: ['linux-x64-pty'],
    why: `${NO_ENGINE}; and not node-shim-oracle, whose container runs as root (rg-spawn's unreadable-file row skips there)` },
  'lead-scrub-equivalence': { jobs: ['linux-x64-pty'],
    why: `${NO_ENGINE}; and its provider must RUN here (the pinned native, not the minimised carve)` },
  'rg-regex-data-fresh': { jobs: ['linux-x64-pty'], why: MINIMISED },
  'rg-regex-oracle-fresh': { jobs: ['linux-x64-pty'], why: MINIMISED },
  'rg-bundle-line-fresh': { jobs: ['linux-x64-pty'], why: MINIMISED },
  'rg-types-fresh': { jobs: ['linux-x64-pty'], why: MINIMISED },
  'paint-differential': { jobs: ['linux-x64-pty'], why: TEXT_ORACLE },
  'unicode-data-fresh': { jobs: ['linux-x64-pty'], why: TEXT_ORACLE },
  'text-diff-segmenter': { jobs: ['linux-x64-pty'], why: TEXT_ORACLE },
  'text-diff-stringwidth': { jobs: ['linux-x64-pty'], why: TEXT_ORACLE },
  'text-diff-intl': { jobs: ['linux-x64-pty'], why: TEXT_ORACLE },
  'text-diff-sliceansi': { jobs: ['linux-x64-pty'], why: TEXT_ORACLE },
  'text-diff-wrapansi': { jobs: ['linux-x64-pty'], why: TEXT_ORACLE },
  'text-diff-wrapansi-cases': { jobs: ['linux-x64-pty'], why: TEXT_ORACLE },
  // The engine legs: the engine this leg just built.
  'engine-hermeticity': { jobs: JOBS.filter((j) => j.leg).map((j) => j.id),
    why: 'needs a built engine (CLODE_DEPSCAN_ENGINE), which only an engine leg has: "CLODE_DEPSCAN_ENGINE is unset"' },
  // Windows-only skips: the ubuntu row runs them.
  'depscan-agrees-with-native-tool': { jobs: ['test-ubuntu-latest'],
    why: 'the windows runner has no dumpbin outside a VS developer prompt: "no dumpbin"' },
  'rg-every-surface-node': { jobs: ['test-ubuntu-latest'], why: 'windows has no /bin/sh for its ugrep stub' },
  'rg-regex-prefilter-superset': { jobs: ['test-ubuntu-latest'],
    why: 'suite.yml installs ugrep on Linux only (no Windows package): "no ugrep on this host"' },
};

// ==========================================================================
// EXEMPT: gates no CI job runs, by name. Each reason is measured, never "unknown".
// ==========================================================================
const EXEMPT = {
  // The verdict of the gates-ran-in-ci job itself: its own record would be judged by nobody.
  'gates-ran-in-ci': 'it IS the aggregator job\'s verdict (gates-ran-in-ci in ci.yml); a record of it could only be '
    + 'judged by itself, and that job\'s own success is what reports it',
  'vendored-archive-rule-overrides': 'BACKLOG "vendored-archive-rule-overrides reads a vendor path the build no longer '
    + 'uses" (Measured 2026-11-19): it reads spike/quickjs/vendor/txiki.js, which no CI checkout has (the build '
    + 'clones into tjsVendorParentDir), so it skipped in both suite rows of run 44572930594 and is in no other job',
};

// ==========================================================================
// FILES: named gate files a job accounts for test by test. Every test of the file must be reported
// in that job and pass; a skip is accepted only by its exact test name, with why.
// ==========================================================================
const FILES = {
  // node-shim-oracle: added there (task-8, observability Task 5) because the suite cannot run them.
  'test/shim-surface.test.cjs': { jobs: ['node-shim-oracle'] },
  'test/guard-subcommands-gate.test.cjs': { jobs: ['node-shim-oracle'] },
  'test/engine-regexp-reuse.test.cjs': { jobs: ['node-shim-oracle'] },
  'test/build-gates/dep-closure-gates.test.cjs': { jobs: ['node-shim-oracle'] },
  'test/build-gates/lexical-code-mask.test.cjs': { jobs: ['node-shim-oracle'] },
  'test/build-gates/renameable-positions.test.cjs': { jobs: ['node-shim-oracle'] },
  'test/zlib-zstd-stream-gap.test.cjs': { jobs: ['node-shim-oracle'] },
  'test/fidelity/regexp-capture-census.test.cjs': { jobs: ['node-shim-oracle'] },
  'test/credential-store-attempted.test.cjs': { jobs: ['node-shim-oracle-darwin'] },
  // The node-shim oracles' two accepted skips, by name (each job's "skipped 2").
  'test/node-shim-agentic.test.cjs': { jobs: ['node-shim-oracle', 'node-shim-oracle-darwin', 'windows-amd64-tests',
    'windows-arm64-tests'], skips: {
    'a darwin-carved quaude takes the macOS branch (managed-settings under /Library)':
      'needs a darwin-carved provider (CLODE_DARWIN_PROVIDER_BIN), which no CI job stages',
  } },
  'test/node-shim-roundtrip.test.cjs': { jobs: ['node-shim-oracle', 'node-shim-oracle-darwin', 'windows-amd64-tests',
    'windows-arm64-tests'], skips: {
    'LIVE finale: -p against api.anthropic.com (opt-in)': 'opt-in (CLODE_LIVE_ROUNDTRIP): real tokens, never in CI',
  } },
  // The Windows jobs: the node-shim oracles on the real Windows kernels, and the ConPTY TUI.
  'test/node-shim-fs-stat-identity.test.cjs': { jobs: ['windows-amd64-tests', 'windows-arm64-tests'] },
  'test/node-shim-os-devnull.test.cjs': { jobs: ['windows-amd64-tests', 'windows-arm64-tests'] },
  // os.getPriority/setPriority through real PowerShell on the real Windows kernel; the POSIX nice(1) row skips there.
  'test/node-shim-os-priority.test.cjs': { jobs: ['windows-amd64-tests'], skips: {
    'os.getPriority/setPriority under quaude answer as host node does, both under nice -n 5':
      'nice(1) is POSIX; the real-PowerShell row in the same file judges Windows',
  } },
  'test/node-shim-tty.test.cjs': { jobs: ['windows-amd64-tui'], skips: {
    'process.stdout emits resize with updated columns on SIGWINCH': 'SIGWINCH/resize N/A on Windows ConPTY (node emits none either)',
  } },
  // native-builder-oracle: the native builder's acceptances, `skipped 0` in the job.
  'test/clode-native.test.cjs': { jobs: ['native-builder-oracle'] },
  'test/oracle-binaries.test.cjs': { jobs: ['native-builder-oracle'] },
  'test/naude-shim-boundary.test.cjs': { jobs: ['native-builder-oracle'] },
  // linux-x64-pty: every file its steps run, with the skips its steps accept by name.
  'test/quaude-build.test.cjs': { jobs: ['linux-x64-pty'] },
  'test/e2e-tui-tjs.test.cjs': { jobs: ['linux-x64-pty', 'windows-amd64-tui'] },
  'test/e2e-ctrlz-tui.test.cjs': { jobs: ['linux-x64-pty'] },
  'test/fidelity/interactive-render-diff.test.cjs': { jobs: ['linux-x64-pty'] },
  'test/fidelity/interactive-frame-diff.test.cjs': { jobs: ['linux-x64-pty'] },
  'test/fidelity/interactive-resize-diff.test.cjs': { jobs: ['linux-x64-pty'] },
  'test/fidelity/update-notify.pty.test.cjs': { jobs: ['linux-x64-pty'] },
  'test/fidelity/session-determinism.test.cjs': { jobs: ['linux-x64-pty'] },
  'test/fidelity/interactive-session-diff.test.cjs': { jobs: ['linux-x64-pty'] },
  'test/fidelity/reset-invisibility.test.cjs': { jobs: ['linux-x64-pty'] },
  'test/native-oracle.test.cjs': { jobs: ['linux-x64-pty'] },
  'test/unicode-data-fresh.test.cjs': { jobs: ['linux-x64-pty'] },
  'test/unicode-text.test.cjs': { jobs: ['linux-x64-pty'] },
  'test/fidelity/text-differential.test.cjs': { jobs: ['linux-x64-pty'] },
  'test/fidelity/paint-differential.test.cjs': { jobs: ['linux-x64-pty'] },
  'test/build-gates/text-probe-gates.test.cjs': { jobs: ['linux-x64-pty'] },
  'test/build-gates/paint-probe-gates.test.cjs': { jobs: ['linux-x64-pty'] },
  'test/build-gates/reset-patch-gates.test.cjs': { jobs: ['linux-x64-pty'] },
  'test/bun-slice-ansi-arity.test.cjs': { jobs: ['linux-x64-pty'] },
  'test/fidelity/rg-differential.test.cjs': { jobs: ['linux-x64-pty'], skips: {
    'RG-MMAP-EVERYWHERE: macOS native in a tree with a quote and a non-ASCII letter prints its record as inTree spells it (native, macOS)':
      'macOS only: it judges the macOS native\'s own record of the RG-MMAP-EVERYWHERE divergence',
  } },
  'test/fidelity/agentic-grep-glob.test.cjs': { jobs: ['linux-x64-pty'] },
  'test/build-gates/rg-regex-gates.test.cjs': { jobs: ['linux-x64-pty'] },
  'test/build-gates/rg-types-gates.test.cjs': { jobs: ['linux-x64-pty'] },
  'test/fidelity/lead-scrub-equivalence.test.cjs': { jobs: ['linux-x64-pty'] },
  'test/rg-spawn.test.cjs': { jobs: ['linux-x64-pty'] },
  'test/fidelity/agentic-sandbox-fail-closed.test.cjs': { jobs: ['linux-x64-pty'], skips: {
    'where native would not sandbox, quaude does as native does (D2): its warning, and every call runs':
      'this runner has bubblewrap and socat, so native WOULD sandbox: the D2 branch does not apply (step comment)',
  } },
};

// ==========================================================================
// Pure helpers
// ==========================================================================
const GATE_PREFIX = 'guard gate: ';
const gateOf = (name) => (typeof name === 'string' && name.startsWith(GATE_PREFIX) ? name.slice(GATE_PREFIX.length) : null);
// A record's file, repo-relative: the path from the checkout's first `test/` on, whatever the runner's
// root and separator (/home/runner/work/clode/clode/test/x, D:\a\clode\clode\test\x).
function repoFile(file) {
  if (typeof file !== 'string') return null;
  const p = file.replace(/^file:\/\//, '').split('\\').join('/');
  const i = p.indexOf('/test/');
  return i < 0 ? (p.startsWith('test/') ? p : null) : p.slice(i + 1);
}

// Which gates each job must run, given the universe of gate names. -> Map(job id -> Set(name))
function declaredGates(universe, manifest) {
  const { jobs, placed, exempt } = manifest;
  const out = new Map(jobs.map((j) => [j.id, new Set()]));
  const suiteRows = jobs.filter((j) => j.suite).map((j) => j.id);
  for (const name of universe) {
    if (name in exempt) continue;
    const where = placed[name] ? placed[name].jobs : suiteRows;
    for (const id of where) if (out.has(id)) out.get(id).add(name);
  }
  return out;
}

// The outcome of one test across every report of it in one job: passed only if every report passed.
function outcomeOf(reports) {
  if (!reports.length) return 'never reported';
  for (const r of reports) {
    if (r.type === 'test:fail') return 'failed';
    if (r.skip !== undefined) return `skipped (${r.skip || 'no reason given'})`;
    if (r.todo !== undefined) return `todo (${r.todo || 'no reason given'})`;
  }
  return 'passed';
}

// ==========================================================================
// THE STATIC CHECK: the manifest agrees with the registry, the tree and the workflows.
// registry: [{ name, file }]; texts: { [repo path]: text }; files: Set of repo paths.
// ==========================================================================
const stripComments = (yaml) => yaml.replace(/(^|[ \t])#.*$/gm, '$1');
function jobBlocks(yaml) {
  const out = new Map();
  const y = stripComments(yaml);
  const at = [...y.matchAll(/^ {2}([\w-]+):[ \t]*$/gm)];
  at.forEach((h, k) => out.set(h[1], y.slice(h.index, k + 1 < at.length ? at[k + 1].index : y.length)));
  return out;
}
// Does a job's text run `file`? Named outright, or by a glob token (test/node-shim-*.test.cjs).
function names(block, file) {
  if (block.includes(file)) return true;
  for (const tok of block.match(/test\/[\w./*-]*\*[\w./*-]*\.test\.cjs/g) || []) {
    const re = new RegExp(`^${tok.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\/]/g, '\\$&')).join('[^/]*')}$`);
    if (re.test(file)) return true;
  }
  return false;
}
function blockOf(texts, workflow, job) {
  const text = texts[workflow];
  if (typeof text !== 'string') return { error: `${workflow} is not in the tree` };
  if (job === null) return { block: stripComments(text) };
  const b = jobBlocks(text).get(job);
  return b ? { block: b } : { error: `${workflow} has no job ${job}` };
}

// Every gates-ran-* upload step in a job's text: its artifact name, and whether it overwrites.
function gateUploads(block) {
  const out = [];
  for (const step of block.split(/^\s*- /m)) {
    if (!/actions\/upload-artifact@/.test(step)) continue;
    const m = /\bname:\s*['"]?(gates-ran-[^\s,'"}]+)/.exec(step);
    if (m) out.push({ name: m[1], overwrite: /\boverwrite:\s*true\b/.test(step), multiPath: /\bpath:\s*[|>]/.test(step) });
  }
  return out;
}

// The jobs of one workflow that call tjs-legs.yml, with the `tier`/`only` they pass (the legs each builds are
// computed by the caller, from scripts/tjs-legs.mjs itself: legsOf).
function legCallersIn(workflow, text) {
  const out = [];
  for (const [job, block] of jobBlocks(text)) {
    if (!/uses:\s*\.\/\.github\/workflows\/tjs-legs\.yml/.test(block)) continue;
    const arg = (k) => ((new RegExp(`^\\s+${k}:\\s*['"]?([\\w.-]+)`, 'm')).exec(block) || [])[1] || '';
    out.push({ workflow, job, tier: arg('tier'), only: arg('only') });
  }
  return out;
}

function checkPlacement({ manifest, registry, texts, files, legCallers = [] }) {
  const { jobs, placed, exempt, files: gateFiles, aggregator } = manifest;
  const findings = [];
  const known = new Map();
  for (const g of registry) {
    if (known.has(g.name) && known.get(g.name) !== g.file) {
      findings.push(`gate ${g.name} is registered twice (${known.get(g.name)} and ${g.file}): a gate list names gates, so a name must be one gate`);
    }
    known.set(g.name, g.file);
  }
  const ids = new Set();
  const blocks = new Map();
  for (const j of jobs) {
    if (ids.has(j.id)) { findings.push(`job ${j.id} is declared twice`); continue; }
    ids.add(j.id);
    const { block, error } = blockOf(texts, j.workflow, j.job);
    if (error) { findings.push(`job ${j.id}: ${error}`); continue; }
    blocks.set(j.id, block);
    const why = [];
    if (!/actions\/upload-artifact@/.test(block) || !block.includes('gates-ran-')) why.push('uploads no gates-ran-* artifact');
    if (!block.includes(j.suite ? 'CLODE_GATES_REPORT' : 'cell-reporter.mjs')) {
      why.push(j.suite ? 'never sets CLODE_GATES_REPORT for test/run.mjs' : 'runs no test under test/cell-reporter.mjs');
    }
    for (const c of j.carries || []) if (!block.includes(c)) why.push(`does not carry "${c}"`);
    if (why.length) findings.push(`job ${j.id} (${j.workflow}${j.job ? ` ${j.job}` : ''}) cannot report its gates: ${why.join('; ')}`);
  }
  // RE-RUNS AND COLLISIONS. v4 artifacts are run-scoped and immutable: every gates-ran-* upload overwrites, so a
  // re-run attempt replaces its OWN list instead of colliding with it. That is only safe if no two jobs of one run
  // can produce the same name: every name is unique across the declared jobs' texts (one text per workflow job, so
  // the two suite rows, which share suite.yml's job, count once and differ by matrix.os), and the engine legs'
  // name (gates-ran-leg-<leg>, shared by every caller of tjs-legs.yml) is kept unique by the leg-set check below.
  {
    const seen = new Map();
    for (const j of jobs) {
      const key = `${j.workflow}:${j.job}`;
      if (!blocks.has(j.id) || seen.has(key)) { seen.set(key, true); continue; }
      seen.set(key, true);
      for (const u of gateUploads(blocks.get(j.id))) {
        if (!u.overwrite) findings.push(`job ${j.id} uploads ${u.name} without overwrite: true, so a re-run of it collides with its own earlier list`);
        // in a container job the runner maps only the FIRST line of a multi-line path into the container
        // (run 44597568635: node-shim-oracle's gates/ was silently left out), so a gate list is one directory
        if (u.multiPath) findings.push(`job ${j.id} uploads ${u.name} from a multi-line path: in a container job only the first line reaches the upload; stage one directory`);
      }
    }
    const owners = new Map();
    const textKeys = new Set();
    for (const j of jobs) {
      const key = `${j.workflow}:${j.job}`;
      if (!blocks.has(j.id) || textKeys.has(key)) continue;
      textKeys.add(key);
      for (const u of gateUploads(blocks.get(j.id))) owners.set(u.name, [...(owners.get(u.name) || []), key]);
    }
    for (const [name, keys] of owners) {
      if (keys.length > 1) findings.push(`artifact ${name} is uploaded by ${keys.join(' and ')}: with overwrite, one would silently replace the other's gate list`);
    }
  }
  // Two callers of tjs-legs.yml in one workflow run must build disjoint legs, or both upload gates-ran-leg-<leg>.
  {
    const byWf = new Map();
    for (const c of legCallers) byWf.set(c.workflow, [...(byWf.get(c.workflow) || []), c]);
    for (const [wf, cs] of byWf) {
      for (let a = 0; a < cs.length; a++) for (let b = a + 1; b < cs.length; b++) {
        const both = cs[a].legs.filter((l) => cs[b].legs.includes(l));
        if (both.length) {
          findings.push(`${wf}: jobs ${cs[a].job} (only: ${cs[a].only || '(all)'}) and ${cs[b].job} (only: ${cs[b].only || '(all)'}) `
            + `both build ${both.join(', ')}, so both upload gates-ran-leg-<leg> for it and one list replaces the other`);
        }
      }
    }
  }
  // The aggregator: it must download every list and run the runtime check, after every job it judges.
  {
    const { block, error } = blockOf(texts, aggregator.workflow, aggregator.job);
    if (error) findings.push(`the aggregator: ${error}; nothing judges the gate lists`);
    else {
      if (!/actions\/download-artifact@/.test(block) || !block.includes('gates-ran-')) findings.push('the aggregator downloads no gates-ran-* artifact');
      if (!block.includes('CLODE_GATES_RAN') || !block.includes('test/gates-ran-in-ci.test.cjs')) {
        findings.push('the aggregator never runs test/gates-ran-in-ci.test.cjs with CLODE_GATES_RAN');
      }
      if (!/NEEDS:\s*\$\{\{\s*toJSON\(needs\)\s*\}\}/.test(block)) {
        findings.push('the aggregator never passes NEEDS: ${{ toJSON(needs) }}, so a list missing because its job was '
          + 'cancelled reads exactly like a job hiding its gates');
      }
      const needs = (/needs:\s*\[([^\]]*)\]/.exec(block) || [, ''])[1].split(',').map((s) => s.trim());
      // A judge that gates something (release.yml's `release`): that job must wait for the verdict.
      if (manifest.gates) {
        const { block: gated, error: gErr } = blockOf(texts, aggregator.workflow, manifest.gates);
        const gNeeds = gErr ? [] : (/needs:\s*\[([^\]]*)\]/.exec(gated) || [, ''])[1].split(',').map((s) => s.trim());
        if (!gNeeds.includes(aggregator.job)) findings.push(`${manifest.gates} does not need ${aggregator.job}, so it can be cut whatever the gate lists say`);
      }
      for (const j of jobs) {
        const need = needKey(j, manifest);
        if (!needs.includes(need)) findings.push(`the aggregator does not wait for ${need} (job ${j.id}), so it can judge a list before it exists`);
      }
    }
  }
  for (const [name, p] of Object.entries(placed)) {
    if (!known.has(name)) { findings.push(`PLACED names ${name}, which is not a registered gate`); continue; }
    if (name in exempt) findings.push(`${name} is both PLACED and EXEMPT`);
    if (typeof p.why !== 'string' || !p.why.trim()) findings.push(`PLACED ${name} gives no why`);
    if (!Array.isArray(p.jobs) || !p.jobs.length) { findings.push(`PLACED ${name} names no job`); continue; }
    for (const id of p.jobs) {
      if (!ids.has(id)) { findings.push(`PLACED ${name} names job ${id}, which JOBS does not declare`); continue; }
      const j = jobs.find((x) => x.id === id);
      if (!j.suite && blocks.has(id) && !names(blocks.get(id), known.get(name))) {
        findings.push(`PLACED ${name} in ${id}, which never runs ${known.get(name)}`);
      }
    }
  }
  for (const [name, why] of Object.entries(exempt)) {
    if (!known.has(name)) findings.push(`EXEMPT names ${name}, which is not a registered gate`);
    if (typeof why !== 'string' || !why.trim()) findings.push(`EXEMPT ${name} gives no reason; "unknown" is not one`);
  }
  for (const [file, f] of Object.entries(gateFiles)) {
    if (!files.has(file)) { findings.push(`FILES names ${file}, which is not in the tree`); continue; }
    for (const id of f.jobs || []) {
      if (!ids.has(id)) findings.push(`FILES ${file} names job ${id}, which JOBS does not declare`);
      else if (blocks.has(id) && !names(blocks.get(id), file)) findings.push(`FILES ${file} in ${id}, which never runs it`);
    }
    for (const [t, why] of Object.entries(f.skips || {})) {
      if (typeof why !== 'string' || !why.trim()) findings.push(`FILES ${file}: the accepted skip "${t}" gives no why`);
    }
  }
  // Every job in the per-push CI that runs a gate file must be declared, or its gates go unaccounted.
  const gateFileSet = new Set([...known.values(), ...Object.keys(gateFiles)]);
  const WF = aggregator.workflow;
  const declaredBlocks = new Set(jobs.filter((j) => j.workflow === WF).map((j) => j.job));
  if (typeof texts[WF] === 'string') {
    for (const [job, block] of jobBlocks(texts[WF])) {
      if (declaredBlocks.has(job) || job === aggregator.job) continue;
      const ran = [...gateFileSet].filter((f) => names(block, f));
      if (ran.length) findings.push(`${path.basename(WF)} job ${job} runs gate file(s) ${ran.join(', ')} but is not in JOBS, so nothing holds it to them`);
    }
  }
  return { findings, examined: jobs.length + Object.keys(placed).length + Object.keys(exempt).length + Object.keys(gateFiles).length,
    note: `${jobs.length} job(s), ${known.size} registered gate(s), ${Object.keys(placed).length} placed, `
      + `${Object.keys(exempt).length} exempt, ${Object.keys(gateFiles).length} gate file(s)` };
}

// ==========================================================================
// THE RUNTIME CHECK: what each job's uploaded gate list says it ran.
// records: Map(job id -> [record] | null); registry: [{ name }] (may be empty: the suite rows'
// records are the registry as CI loaded it, since test/run.mjs loads every test file).
// ==========================================================================
// The aggregator's `needs` key for a job: a suite row is ci.yml's `test` (which calls suite.yml), an engine
// leg is `tjs` (which calls the leg workflow), a ci.yml job is itself.
function needKey(j, manifest = MANIFEST) {
  return manifest.need ? manifest.need(j) : j.suite ? 'test' : j.job;
}

// Every finding is one of two kinds, and both stay red:
//   UNOBSERVED  something is ABSENT (no list, or a gate or file never reported) from a job that did not conclude
//               `success` (cancelled, skipped, failure: needs.<job>.result, from NEEDS): the job may have stopped
//               before reaching it. Infra (a runner-capacity cancel, as in run 44572930594) lands here; re-run it.
//   DARK        everything else: a gate that REPORTED skipped or failed (it was reached, whatever the job's
//               result), or anything absent from a job that succeeded (or whose result is unknown). The gate is
//               hidden, which is the failure this guard exists for.
// One evidence limit: both suite rows are ci.yml's one `test` job (a matrix inside suite.yml), and needs.test.result
// is the matrix's combined result, so one red row makes the OTHER row's absences UNOBSERVED too. Per-row results are
// not in `needs`; a row's own list, when it exists, is the per-row evidence, and its reported skips stay DARK.
function checkRan({ manifest, records, registry = [], needs = null }) {
  const { jobs, placed, exempt, files: gateFiles } = manifest;
  // node's reporter names the file where test() was CALLED, and guardTests() calls it inside test/guard.cjs: so
  // "guard gate: X" and "guard control: X can fail" carry test/guard.cjs, never the file that registered X. A file
  // whose only tests are guards then looked unrun (CI run 44597568635: guard-subcommands-gate, paint-differential,
  // lead-scrub-equivalence). They are attributed to the file the registry says registered X.
  const registeredIn = new Map(registry.map((g) => [g.name, g.file]));
  const fileOf = (r) => {
    const f = repoFile(r.file);
    if (f !== 'test/guard.cjs') return f;
    const m = /^guard (?:gate|control): (.+?)(?: can fail)?$/.exec(r.name || '');
    return (m && registeredIn.get(m[1])) || f;
  };
  const raw = [];
  const findings = { push: (msg, j, absent = false) => raw.push({ msg, j, absent }) };
  const universe = new Set([...registry.map((g) => g.name), ...Object.keys(placed), ...Object.keys(exempt)]);
  for (const rs of records.values()) for (const r of rs || []) { const g = gateOf(r.name); if (g) universe.add(g); }
  const declared = declaredGates(universe, manifest);
  let examined = 0;
  const passedIn = new Map();
  for (const j of jobs) {
    const rs = records.get(j.id);
    if (!rs || !rs.length) {
      findings.push(`${j.id} uploaded no gate list (artifact gates-ran-${j.id}): a job that never reported its gates proves `
        + `none of the ${declared.get(j.id).size} gate(s) it must run ran`, j, true);
      continue;
    }
    const byGate = new Map();
    const byFile = new Map();
    for (const r of rs) {
      const g = gateOf(r.name);
      if (g) byGate.set(g, [...(byGate.get(g) || []), r]);
      const f = fileOf(r);
      if (f) byFile.set(f, [...(byFile.get(f) || []), r]);
    }
    for (const [g, reps] of byGate) if (outcomeOf(reps) === 'passed') passedIn.set(g, [...(passedIn.get(g) || []), j.id]);
    for (const g of declared.get(j.id)) {
      examined++;
      const o = outcomeOf(byGate.get(g) || []);
      if (o !== 'passed') findings.push(`${j.id}: gate ${g} ${o}; ${j.id} must run it${placed[g] ? '' : ' (every registered gate runs in the suite unless test/ci-gates.cjs places or exempts it)'}`, j, o === 'never reported');
    }
    for (const [file, f] of Object.entries(gateFiles)) {
      if (!(f.jobs || []).includes(j.id)) continue;
      examined++;
      const reps = byFile.get(file) || [];
      if (!reps.length) { findings.push(`${j.id}: no test of ${file} reported; ${j.id} must run it`, j, true); continue; }
      const tests = new Map();
      for (const r of reps) tests.set(r.name, [...(tests.get(r.name) || []), r]);
      for (const [t, trs] of tests) {
        const o = outcomeOf(trs);
        if (o === 'passed') continue;
        if (o.startsWith('skipped') && f.skips && t in f.skips) continue;
        findings.push(`${j.id}: ${file}: test "${t}" ${o}`, j);
      }
      for (const t of Object.keys(f.skips || {})) {
        if (!tests.has(t)) findings.push(`${j.id}: ${file}: the accepted skip "${t}" was never reported (renamed or gone?): re-measure it`, j, true);
      }
    }
  }
  // An exemption that is no longer true: the gate passed somewhere, so place it there instead.
  for (const name of Object.keys(exempt)) {
    if (passedIn.has(name)) findings.push(`gate ${name} is EXEMPT but passed in ${passedIn.get(name).join(', ')}: place it there instead`);
  }
  const ran = [...passedIn.keys()].length;
  const resultOf = (j) => (needs && needs[needKey(j, manifest)] && needs[needKey(j, manifest)].result) || null;
  const out = raw.map(({ msg, j, absent }) => {
    const r = absent && j && resultOf(j);
    return r && r !== 'success' ? `UNOBSERVED (${j.id} concluded ${r}): ${msg}` : `DARK: ${msg}`;
  });
  const unobserved = out.filter((m) => m.startsWith('UNOBSERVED')).length;
  return { findings: out, examined, note: `${jobs.length} job(s), ${universe.size} gate(s) in the universe, ${ran} passed in at least one job`
    + `${needs ? '' : '; NEEDS unset, so no job\'s result is known and every finding counts as DARK'}`
    + `\n  DARK: ${out.length - unobserved} finding(s): a gate reported skipped or failed, or was absent from a job that succeeded`
    + `\n  UNOBSERVED: ${unobserved} finding(s): absent from a job that concluded cancelled, skipped or failure, so maybe never reached` };
}

// Read every job's gate list from `root` (one dir per artifact, gates-ran-<id>, *.jsonl at any
// depth). A missing dir is `null`: the job uploaded nothing.
function readRecords(root, jobs) {
  const out = new Map();
  for (const j of jobs) {
    const dir = path.join(root, `gates-ran-${j.id}`);
    if (!fs.existsSync(dir)) { out.set(j.id, null); continue; }
    const recs = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.jsonl')) {
          for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
            if (!line.trim()) continue;
            try { recs.push(JSON.parse(line)); } catch { recs.push({ type: 'test:fail', name: `unparseable record in ${path.relative(root, p)}: ${line.slice(0, 80)}` }); }
          }
        }
      }
    };
    walk(dir);
    out.set(j.id, recs);
  }
  return out;
}

// THE REGISTRY, loaded: every test file that calls defineGuard, required in ONE child process that
// exits before node:test runs a single test (the same move guards-population's registry-size test
// makes), so registered() is the real universe, dynamic names (interactive-session-diff's
// sessionGuard) included. -> [{ name, file }] or throws naming what failed to load.
function loadRegistry({ repo = REPO, env = process.env } = {}) {
  const { execFileSync } = require('node:child_process');
  // Tracked AND untracked-but-not-ignored, as test/run.mjs discovers them: a gate in a file not yet
  // committed is still a gate the suite runs.
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', 'test'],
    { cwd: repo, encoding: 'utf8' });
  // Every test file that loads the guard module at all, not only those that spell a bare defineGuard( call: the
  // registry is what defineGuard REGISTERED when the file loaded, so a guard defined through an alias (or a helper)
  // counts. (It used to reuse guards-population's bare-call regex, and a guard registered through an alias was
  // invisible to both checks.)
  const candidates = out.split('\0').filter((f) => /\.test\.c?js$/.test(f) && f !== 'test/guard.test.cjs')
    .filter((f) => /guard\.cjs['"]/.test(fs.readFileSync(path.join(repo, f), 'utf8')));
  const script = [
    `const { registered } = require(${JSON.stringify(path.join(repo, 'test', 'guard.cjs'))});`,
    'const out = []; const errors = [];',
    `for (const f of ${JSON.stringify(candidates)}) {`,
    '  const before = new Set(registered().map((g) => g.name));',
    `  try { require(require('node:path').join(${JSON.stringify(repo)}, f)); } catch (e) { errors.push(f + ': ' + (e && e.message)); continue; }`,
    '  for (const g of registered()) if (!before.has(g.name)) out.push({ name: g.name, file: f });',
    '}',
    'process.stdout.write(JSON.stringify({ out, errors }));',
    'process.exit(0);',
  ].join('\n');
  const r = execFileSync(process.execPath, ['-e', script], { cwd: path.join(repo, 'test'), encoding: 'utf8', env,
    timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  const { out: reg, errors } = JSON.parse(r);
  if (errors.length) throw new Error(`loading the gate registry failed: ${errors.join('; ')}`);
  return reg;
}

const MANIFEST = Object.freeze({ name: 'ci', jobs: JOBS, placed: PLACED, exempt: EXEMPT, files: FILES, aggregator: AGGREGATOR, need: ciNeed });

// ==========================================================================
// RELEASE.YML, judged the same way before a release is cut (final review, observability plan): its jobs that run
// tests are the suite rows (release.yml's `suite` calls the same suite.yml), be-bytecode-oracle (the BE-sensitive
// rows), and every non-soft-fail release-tier engine leg (`leg` and `darwin-slices`). Its aggregator,
// gates-ran-in-release, must pass before the `release` job. Publish steps run no tests and are not judged.
// A gate PLACED only in ci.yml jobs has no release job to run it: it is EXEMPT here, naming where CI runs it.
// ==========================================================================
const BE_ORACLE = 'be-bytecode-oracle';
const RELEASE_JOBS = [
  ...JOBS.filter((j) => j.suite),
  { id: BE_ORACLE, workflow: RELEASE, job: BE_ORACLE },
  ...judgedLegs('release').map(legJob),
];
const RELEASE_IDS = new Set(RELEASE_JOBS.map((j) => j.id));
const RELEASE_PLACED = {};
const RELEASE_EXEMPT = { ...EXEMPT };
for (const [name, p] of Object.entries(PLACED)) {
  if (name === 'engine-hermeticity') { RELEASE_PLACED[name] = { ...p, jobs: RELEASE_JOBS.filter((j) => j.leg).map((j) => j.id) }; continue; }
  const here = p.jobs.filter((id) => RELEASE_IDS.has(id));
  if (here.length) RELEASE_PLACED[name] = { ...p, jobs: here };
  else RELEASE_EXEMPT[name] = `placed in ci.yml's ${p.jobs.join(', ')} (${p.why}); release.yml has no such job`;
}
const RELEASE_FILES = {
  'test/node-shim-crypto.test.cjs': { jobs: [BE_ORACLE] },
  'test/url-characterization.test.cjs': { jobs: [BE_ORACLE] },
};
for (const [file, f] of Object.entries(FILES)) {
  const here = (f.jobs || []).filter((id) => RELEASE_IDS.has(id));
  if (here.length) RELEASE_FILES[file] = { ...f, jobs: here };
}
const RELEASE_AGGREGATOR = { workflow: RELEASE, job: 'gates-ran-in-release' };
const releaseNeed = (j) => (j.suite ? 'suite' : j.leg ? (TJS_LEGS.DARWIN_SLICES.includes(j.leg) ? 'darwin-slices' : 'leg') : j.job);
const RELEASE_MANIFEST = Object.freeze({ name: 'release', jobs: RELEASE_JOBS, placed: RELEASE_PLACED, exempt: RELEASE_EXEMPT,
  files: RELEASE_FILES, aggregator: RELEASE_AGGREGATOR, need: releaseNeed, gates: 'release' });
const MANIFESTS = { ci: MANIFEST, release: RELEASE_MANIFEST };

module.exports = {
  needKey, gateUploads, legCallersIn,
  MANIFEST, RELEASE_MANIFEST, MANIFESTS, RELEASE, JOBS, PLACED, EXEMPT, FILES, AGGREGATOR, SUITE_ROWS, CI, SUITE, LEG,
  declaredGates, outcomeOf, repoFile, gateOf, names, jobBlocks,
  checkPlacement, checkRan, readRecords, loadRegistry,
};
