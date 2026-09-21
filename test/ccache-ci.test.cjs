'use strict';
// ccache IN CI — "CI builds should use ccache exactly the same way local builds do."
//
// scripts/ccache-launcher.cjs and test/ccache.test.cjs already cover the DECISION (does
// this build push -DCMAKE_C_COMPILER_LAUNCHER, and for which compiler). What neither
// could see is whether any leg in .github/actions/build-leg/action.yml was ever GIVEN a
// ccache to decide about. It was not: nothing under .github/ installed one, and nothing
// set or persisted a CCACHE_DIR, so on the one runner image that happens to ship ccache
// (windows-latest, via Strawberry Perl) it started cold every run and could never hit,
// and everywhere else the launcher was inert. That gap was invisible for the same reason
// the MSVC one was — it lived in YAML, where nothing type-checks anything.
//
// So this file guards the YAML, the way test/workflow-scripts-exist.cjs guards `run:`
// script references: split the composite action into its steps, find the steps that
// actually COMPILE the engine, and require each of them either to wire ccache or to be
// named, with a reason, in an exempt set that lives here rather than in a comment.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { defineGuard, guardTests } = require('./guard.cjs');
const G = require('../scripts/build-graph.cjs');

const REPO = path.resolve(__dirname, '..');
const ACTION = path.join(REPO, '.github', 'actions', 'build-leg', 'action.yml');
const SCRIPT = path.join(REPO, 'scripts', 'ci-ccache.sh');

// ---------------------------------------------------------------------------
// Reading the action as STEPS, with no YAML parser.
//
// This repo has zero dependencies, so there is none to reach for, and the shape of a
// composite action makes one unnecessary: every step in `runs.steps` is a list item at
// exactly four spaces of indent, and (verified by the split itself, see the floor on the
// coverage guard) every one of them begins `- name: `. Splitting there gives each step's
// WHOLE text including any nested `script:` / `run:` heredoc, which is exactly the unit
// the question "does this step wire ccache" is asked about.
// ---------------------------------------------------------------------------
function splitSteps(text) {
  const lines = text.split('\n');
  const steps = [];
  let cur = null;
  for (const line of lines) {
    const m = /^ {4}- name: (.*)$/.exec(line);
    if (m) {
      cur = { name: m[1].trim(), lines: [line] };
      steps.push(cur);
    } else if (cur) cur.lines.push(line);
  }
  // A COMMENT BLOCK ABOVE A STEP BELONGS TO THAT STEP, and getting this wrong is not
  // cosmetic — it was caught by this guard's own first run. This action explains each
  // step in prose ABOVE the `- name:` line, so a naive split hands every such paragraph to
  // the PREVIOUS step, and the previous step then reads as though it mentioned ccache, or
  // a cache key, or a compile it has nothing to do with. Move the trailing run of blank
  // and comment lines forward to the block it actually introduces.
  for (let i = 0; i < steps.length - 1; i++) {
    const own = steps[i].lines;
    let cut = own.length;
    while (cut > 1 && /^\s*(#.*)?$/.test(own[cut - 1])) cut--;
    steps[i + 1].lines.unshift(...own.splice(cut));
  }
  return steps.map((s) => ({ name: s.name, text: s.lines.join('\n') }));
}

// A line that is a comment in the YAML sense — `#` first on the line. The action is dense
// with prose that NAMES the very commands it is not running (`--build-only` appears in
// three explanatory comments), so a scan that cannot tell those apart reports steps that
// compile nothing and misses the point entirely.
const codeLines = (text) => text.split('\n').filter((l) => !/^\s*#/.test(l));

// The two ways an engine object file comes to exist in this matrix.
//
// THE FIRST IS ASKED OF THE GRAPH (runner-step-mode, 2026-09-21). It used to be the
// literal `--build-only`, which stopped appearing in this YAML the moment every engine
// call site started naming a step id instead of spelling the command out — and a literal
// that matches nothing turns a seven-step population into one, which is what this guard's
// floor caught. The compiling step is the engine-phase step whose declared OUTPUT is the
// engine binary; that is a property of the graph, so a renamed step moves this rule with
// it rather than leaving it quietly sweeping two steps and calling it clean.
//
// The second, spike/quickjs/qemu/ci-guest-bake.sh, is the netbsd-sparc leg's hand-written
// in-guest compile, which never goes through build-tjs.cjs at all and would otherwise be
// the one compiling leg class this guard could not see.
const COMPILE_STEP_ID = (() => {
  const ctx = G.defaultContext();
  const step = G.steps().find((s) => s.phase === 'engine' && s.outputs(ctx).includes(ctx.engine));
  if (!step) {
    throw new Error('ccache-ci: no engine-phase step declares the engine binary as its '
      + 'output, so this guard cannot tell which CI steps compile. Do not hardcode the id.');
  }
  return step.id;
})();
const COMPILES = [new RegExp(`--only ${COMPILE_STEP_ID.replace(/[.]/g, '\\.')}\\b`),
  /ci-guest-bake\.sh/];

// ---------------------------------------------------------------------------
// GUARD 1 — every compiling step either wires ccache or is exempt WITH A REASON.
// ---------------------------------------------------------------------------
//
// The exempt set is the honest half of "make CI match local": three leg classes cannot
// have a persistent ccache, and saying so here — in the thing that would otherwise go red
// — is what stops them from being silently skipped.
const EXEMPT = new Map([
  ['Build + blobulate + smoke (inside the guest VM)',
    'exec=guest. The cross-platform-actions and vmactions backends boot a SEPARATE '
    + 'machine whose only channel is an rsync of the workspace, and $HOME there dies with '
    + 'the VM. A workspace-relative CCACHE_DIR would therefore round-trip the entire cache '
    + 'over that rsync twice per run — the exact cost the guest script already goes out of '
    + 'its way to avoid by moving TMPDIR and the CMake build dir OUT of the workspace. '
    + 'Persisting a ccache here would pay more in sync than the compile is worth.'],
  ['Load the sparc bake recipe (single committed source)',
    'exec=qemu, and the step in the population because it is the one that NAMES '
    + 'spike/quickjs/qemu/ci-guest-bake.sh (it cats the committed recipe into a step output '
    + 'for the bake step below to run). The compile itself happens inside a TCG-emulated '
    + 'NetBSD/sparc guest driven over a serial console by ci-sparc-driver.py, from a '
    + 'hand-written cc/gmake recipe that never runs build-tjs.cjs and so never consults '
    + 'ccache-launcher.cjs at all; that guest has no package repo wired and no channel to '
    + 'the runner other than the console. Named here rather than filtered out of the '
    + 'population, so a future edit that starts compiling on the RUNNER has to say so.'],
]);
// NOT exempt, deliberately: "Build tjs (native)" also serves the two MSVC legs, where
// scripts/ccache-launcher.cjs declines cl outright and .github/actions/build-leg skips the
// install and the cache for runner.os == 'Windows'. That exclusion is per-RUNNER, inside
// one step that still wires ccache for every other leg it serves, so listing the step here
// would hand a future edit a way to drop the wiring for all of them and stay green.

// The marker that a compiling step has been wired: it is told WHICH DIRECTORY to use.
// That, and not the presence of the install, is the per-step fact — scripts/ci-ccache.sh
// installs once per job for both host-side compiles and once inside each container, so a
// step can legitimately be wired without naming the script. CCACHE_DIR is the thing the
// build itself cannot infer (ccache's own default lives under a cache home that dies with
// the runner), so a step that sets it is a step whose compiles land in the persisted cache.
// Matched against CODE lines only: half this action is prose, and a comment that mentions
// the variable must not read as wiring.
const WIRED = /CCACHE_DIR/;

function scanCoverage({ steps }) {
  const findings = [];
  const claimed = new Set();
  let examined = 0;
  for (const s of steps) {
    const code = codeLines(s.text).join('\n');
    if (!COMPILES.some((re) => re.test(code))) continue;
    examined++;
    if (WIRED.test(code)) continue;
    if (EXEMPT.has(s.name)) { claimed.add(s.name); continue; }
    findings.push(`step "${s.name}" compiles engine objects but neither wires ccache `
      + '(scripts/ci-ccache.sh) nor appears in EXEMPT with a reason');
  }
  // THE OTHER HALF, and the one an exempt list normally lacks: an exemption that no
  // longer covers anything. A renamed or deleted step would leave its reason sitting here
  // looking like live documentation while protecting nothing, and the next step to take
  // that name would inherit a pass it never earned.
  for (const name of EXEMPT.keys()) {
    if (!claimed.has(name)) {
      findings.push(`EXEMPT names "${name}", but no compiling step by that name needs it — `
        + 'the step was renamed, deleted, or has since been wired. Remove the entry.');
    }
  }
  return { findings, examined };
}

const coverage = defineGuard({
  name: 'ccache-ci-leg-coverage',
  // Floor 5: five call sites naming the compile step plus the two sparc steps is 7 today.
  // Set just under, so a split that stops seeing a leg class goes BROKEN rather than
  // reporting a clean sweep of two steps. It did exactly that when the call sites stopped
  // spelling `--build-only` and this rule was still looking for it.
  floor: 5,
  read: () => ({ steps: splitSteps(fs.readFileSync(ACTION, 'utf8')) }),
  scan: scanCoverage,
  // The real steps PLUS one unwired newcomer. Built on the real set on purpose: a control
  // made only of the synthetic step would also trip all three stale-exemption findings, so
  // it would go red without ever proving the finding it is supposed to prove.
  control: () => ({
    steps: [...splitSteps(fs.readFileSync(ACTION, 'utf8')), {
      name: 'Build tjs (a new leg class nobody wired)',
      text: '    - name: Build tjs (a new leg class nobody wired)\n'
        + `      run: ./${G.ENTRY_REL} --only ${COMPILE_STEP_ID} --needs assume\n`,
    }],
  }),
});

// ---------------------------------------------------------------------------
// GUARD 2 — the ccache cache entry is keyed HONESTLY, which here means two things.
// ---------------------------------------------------------------------------
//
// (a) It must NOT carry the engine recipe hash. That hash is precisely what makes the
//     tjs-cache all-or-nothing, and reproducing it here would reproduce the blindness:
//     a recipe move would zero the ccache too, and the whole point is that a recipe move
//     leaves the vast majority of translation units byte-identical.
//
// (b) It must be RUN-SCOPED, i.e. carry github.run_id. actions/cache keys are IMMUTABLE:
//     when the primary key hits exactly, nothing is written back at the end of the job.
//     A static key would therefore be populated once, by whichever run first happened to
//     miss — almost always a cold one — and then frozen forever, which reads in the logs
//     exactly like a working cache and behaves like none. The restore-keys prefix is what
//     turns the always-new key into a rolling cache.
const RECIPE_HASH_EXPR = 'steps.recipe.outputs.hash';

function ccacheCacheBlocks(text) {
  // A cache step is a `- name:` block that `uses:` actions/cache; a CCACHE one is a cache
  // step whose `path:` names the ccache directory.
  return splitSteps(text).filter((s) => {
    const code = codeLines(s.text).join('\n');
    return /uses: actions\/cache/.test(code) && /ccache/i.test(code);
  });
}

function scanKey({ blocks }) {
  const findings = [];
  let examined = 0;
  for (const b of blocks) {
    examined++;
    const key = /\n\s*key: (.*)/.exec(b.text);
    if (!key) { findings.push(`ccache cache step "${b.name}" has no key:`); continue; }
    if (key[1].includes(RECIPE_HASH_EXPR)) {
      findings.push(`ccache cache step "${b.name}" keys on ${RECIPE_HASH_EXPR} — that is the `
        + 'engine cache\'s all-or-nothing key, and copying it here throws away the only '
        + 'thing ccache adds (a recipe move must still hit on unchanged translation units)');
    }
    // Only the step that SAVES needs the rolling key; a restore-only step reuses the same
    // string, so requiring it of both is free and keeps the two from drifting apart.
    if (!key[1].includes('github.run_id')) {
      findings.push(`ccache cache step "${b.name}" has a static key — actions/cache keys are `
        + 'immutable, so an exact hit writes nothing back and the cache freezes at whatever '
        + 'the first missing run stored. Scope it with github.run_id and roll it forward '
        + 'with restore-keys.');
    }
  }
  return { findings, examined };
}

const keyGuard = defineGuard({
  name: 'ccache-ci-key-honest',
  floor: 2, // one restore + one save
  read: () => ({ blocks: ccacheCacheBlocks(fs.readFileSync(ACTION, 'utf8')) }),
  scan: scanKey,
  control: () => ({
    blocks: [{
      name: 'Restore the ccache (keyed like the engine cache)',
      text: '\n      key: ccache-${{ inputs.leg }}-${{ steps.recipe.outputs.hash }}\n',
    }],
  }),
});

// ---------------------------------------------------------------------------
// GUARD 3 — every provide is matched by a report.
// ---------------------------------------------------------------------------
//
// `provide` warms a cache; `report` is the only thing that says afterwards whether it hit.
// This repo's standing lesson is that an invisible build decision hides for an unknown
// number of runs — ccache drove MSVC on a shipping release leg for exactly that reason —
// so a leg that gets the cache without the stats is the same defect in a new place.
function scanPairs({ text }) {
  const findings = [];
  const provides = [...text.matchAll(/ci-ccache\.sh provide/g)].length;
  const reports = [...text.matchAll(/ci-ccache\.sh report/g)].length;
  if (provides !== reports) {
    findings.push(`${provides} 'ci-ccache.sh provide' call site(s) but ${reports} 'report' — `
      + 'a leg that warms a cache with no stats afterwards cannot be told apart from a leg '
      + 'running at 0% hits');
  }
  return { findings, examined: provides + reports };
}

const pairGuard = defineGuard({
  name: 'ccache-ci-stats-visible',
  floor: 6, // three wired leg classes, each provide+report
  read: () => ({ text: fs.readFileSync(ACTION, 'utf8') }),
  scan: scanPairs,
  control: () => ({ text: 'scripts/ci-ccache.sh provide x\nscripts/ci-ccache.sh provide y\n' }),
});

// The two cache steps repeat one long key string, because a composite action has no way
// for a save to name the restore's key. That is a drift risk with a silent failure mode:
// a save under a DIFFERENT key than the restore-keys prefix stores entries nothing will
// ever restore, and the logs look fine. Pin it.
test('the restore and the save use the SAME key, and the restore-keys prefix matches it', () => {
  const blocks = ccacheCacheBlocks(fs.readFileSync(ACTION, 'utf8'));
  const restore = blocks.find((b) => /uses: actions\/cache\/restore/.test(b.text));
  const save = blocks.find((b) => /uses: actions\/cache\/save/.test(b.text));
  assert.ok(restore && save, 'expected exactly one restore and one save for the ccache');
  const keyOf = (b) => /\n\s*key: (.*)/.exec(b.text)[1].trim();
  assert.strictEqual(keyOf(save), keyOf(restore),
    'a save under a key the restore-keys prefix does not cover stores entries nobody reads');
  const prefix = /\n\s*restore-keys: \|\n\s*(.*)/.exec(restore.text)[1].trim();
  assert.ok(keyOf(restore).startsWith(prefix),
    `restore-keys '${prefix}' is not a prefix of the key it is meant to roll forward`);
  // And the prefix must be SHORTER than the key, or it is not a fallback at all.
  assert.ok(prefix.length < keyOf(restore).length);
});

guardTests(coverage);
guardTests(keyGuard);
guardTests(pairGuard);

// ---------------------------------------------------------------------------
// GUARD 4 — the ELIGIBILITY TABLE, run rather than read; and the verdict reaches the build.
// ---------------------------------------------------------------------------
//
// WHY THIS EXISTS: run 35542679928's cosmo leg died at the FIRST archive, with
//
//   cosmoar: CMakeFiles/p256m.dir/p256-m_driver_entrypoints.c.o: missing concomitant
//            CMakeFiles/p256m.dir/.aarch64/p256-m_driver_entrypoints.c.o file
//
// cosmocc is a FAT compiler: one `-o foo.o` produces TWO object files, `foo.o` (x86-64) and
// `<dir>/.aarch64/foo.o`, and cosmoar refuses to archive one without the other. ccache models
// a compile as having exactly ONE output, so on a ccache HIT it restores `foo.o` and the
// sidecar is simply never created. A COLD cache hides this completely (a miss runs the real
// cosmocc, which writes both), which is why the leg was green on 35537960554 — the first run
// with ccache wired — and red on the next one, whose restore-keys line reads
// `Cache hit for restore-key: ccache-cosmo-ubuntu24-3.22-----35537960554-1`. The rolling
// restore-key is doing its job; cosmocc is the thing ccache cannot cache.
//
// Two properties, and the SECOND is the one that would have made this cheap to notice:
//
//  (a) the eligibility table is EXECUTED here, for every shape the matrix can present,
//      instead of being eyeballed in YAML. It is nine lines of `case`/`[ ]` in the mode
//      step and nothing type-checks it.
//  (b) a leg CI decided NOT to give a ccache must SAY SO to the build. Until now "no
//      ccache" was expressed only by not installing one — so on any runner image that
//      happens to ship the tool (windows-latest does, via Strawberry Perl), the build
//      enabled it anyway and only ccache-launcher.cjs's cl decline stopped it. cosmocc is
//      not cl, and cosmo runs on an image that could ship ccache tomorrow. Passing the
//      mode step's verdict through CLODE_TJS_CCACHE makes CI's decision reach the decision.
const NO_SH_GATE = process.platform === 'win32'
  && 'windows: the gate is POSIX sh and Windows runners have no /bin/sh (the ubuntu row of '
  + 'the suite matrix, and every developer box, run it for real)';

// The gate itself, lifted out of the mode step by its own first and last lines. Prose above
// the `case` is deliberately excluded: this runs the CODE, and a comment that changed would
// otherwise look like a behaviour change.
function ccacheGateSource() {
  const text = fs.readFileSync(ACTION, 'utf8');
  const step = splitSteps(text).find((s) => /^Resolve the exec mode/.test(s.name));
  assert.ok(step, 'the mode step that derives `exec` and `ccache` is gone or renamed');
  const m = /\n( *case "\$exec" in[\s\S]*?echo "ccache=\$ccache" >> "\$GITHUB_OUTPUT")/
    .exec(step.text);
  assert.ok(m, 'could not find the ccache eligibility gate in the mode step — it is the '
    + '`case "$exec" in` ... `echo "ccache=$ccache"` block');
  return m[1];
}

// Run it. `exec` arrives as $1 (it is assigned, not exec'd), RUNNER_OS and the cosmo axis
// are bound per case, and GITHUB_OUTPUT is a scratch file we read the verdict back out of.
function decideCcache({ exec, runnerOs = 'Linux', cosmo = 'false' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-ccache-gate-'));
  const out = path.join(dir, 'github-output');
  fs.writeFileSync(out, '');
  const body = ccacheGateSource().replace(/\$\{\{ inputs\.cosmo \}\}/g, cosmo);
  const r = spawnSync('sh', ['-c', `set -eu\nexec="$1"\n${body}\n`, 'sh', exec], {
    encoding: 'utf8',
    env: { ...process.env, RUNNER_OS: runnerOs, RUNNER_TEMP: dir, GITHUB_OUTPUT: out },
  });
  assert.strictEqual(r.status, 0, `the gate did not run: ${r.stderr}`);
  const m = /^ccache=(\d)$/m.exec(fs.readFileSync(out, 'utf8'));
  assert.ok(m, `the gate emitted no ccache verdict: ${fs.readFileSync(out, 'utf8')}`);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  return m[1];
}

test('the ccache eligibility table, executed', { skip: NO_SH_GATE }, () => {
  // The two classes that CAN reach a persistent cache, on a normal POSIX runner.
  assert.strictEqual(decideCcache({ exec: 'host' }), '1', 'exec=host is eligible');
  assert.strictEqual(decideCcache({ exec: 'cross' }), '1', 'exec=cross is eligible');
  // The two that cannot (EXEMPT above says why).
  assert.strictEqual(decideCcache({ exec: 'guest' }), '0', 'exec=guest has no persistent cache');
  assert.strictEqual(decideCcache({ exec: 'qemu' }), '0', 'exec=qemu compiles in-guest');
  // MSVC: ccache-launcher.cjs declines cl, so installing one is pure cost.
  assert.strictEqual(decideCcache({ exec: 'host', runnerOs: 'Windows' }), '0',
    'the MSVC legs are the ones the launcher declines');
  // COSMO: exec=host on an ubuntu runner, and the one leg ccache must NOT be given.
  assert.strictEqual(decideCcache({ exec: 'host', cosmo: 'true' }), '0',
    'cosmocc emits TWO objects per compile (foo.o plus .aarch64/foo.o) and ccache restores '
    + 'only one, so a warm cache makes cosmoar fail with "missing concomitant" — run '
    + '35542679928. The cosmo axis must turn the gate off.');
  // ...and the axis must not take the cache away from the legs that build fine with it.
  assert.strictEqual(decideCcache({ exec: 'host', cosmo: 'false' }), '1',
    'the cosmo decline must be scoped to the cosmo axis');
});

test('a leg CI gave no ccache SAYS so to the build, rather than hoping the image lacks one', () => {
  const steps = splitSteps(fs.readFileSync(ACTION, 'utf8'));
  const native = steps.find((s) => s.name === 'Build tjs (native)');
  assert.ok(native, 'the native engine-build step is gone or renamed');
  const code = codeLines(native.text).join('\n');
  assert.match(code, /CCACHE_DIR: \$\{\{ steps\.mode\.outputs\.ccachedir \}\}/,
    'the native build step should still be told which directory the cache lives in');
  assert.match(code, /CLODE_TJS_CCACHE: \$\{\{ steps\.mode\.outputs\.ccache \}\}/,
    'the native build step serves BOTH legs the gate says no to (windows/MSVC and cosmo) '
    + 'and both run on images that can ship ccache on PATH. Without the verdict reaching '
    + 'scripts/ccache-launcher.cjs — which opts in on mere PRESENCE — "CI installed no '
    + 'ccache" is not the same statement as "this build uses no ccache".');
});

// ---------------------------------------------------------------------------
// scripts/ci-ccache.sh itself, run for real.
// ---------------------------------------------------------------------------
//
// Every case below points CCACHE_DIR at a fresh temp directory, so none of them can touch
// the developer's own cache — which matters more than usual here, since `provide` sets a
// max size and zeroes the counters.
const NO_SH = process.platform === 'win32'
  && 'windows: scripts/ci-ccache.sh is POSIX sh and no Windows leg runs it — the MSVC legs '
  + 'are the ones ccache-launcher.cjs declines outright. The ubuntu and macos rows of the '
  + 'suite matrix run these for real on every push.';
// Options merge, so a case can add its own precondition (`!HAVE_CCACHE`) without losing
// the platform one, and NO_SH's reason is written once rather than per case.
const shTest = (name, a, b) => {
  const [opts, fn] = typeof a === 'function' ? [{}, a] : [a, b];
  return test(name, { ...opts, skip: NO_SH || opts.skip }, fn);
};

const HAVE_CCACHE = spawnSync('sh', ['-c', 'command -v ccache'], { encoding: 'utf8' }).status === 0;

function run(args, env = {}) {
  return spawnSync('sh', [SCRIPT, ...args], {
    cwd: REPO, encoding: 'utf8', env: { ...process.env, ...env },
  });
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'clode-ci-ccache-'));

shTest('provide REFUSES to guess a cache directory', () => {
  const env = { ...process.env };
  delete env.CCACHE_DIR;
  const r = spawnSync('sh', [SCRIPT, 'provide', 'unit'], { cwd: REPO, encoding: 'utf8', env });
  assert.notStrictEqual(r.status, 0, 'a build that warms a cache nobody persists is the bug');
  assert.match(r.stderr, /CCACHE_DIR is unset/);
  assert.match(r.stderr, /^ci-ccache: unit: /m, 'the refusal rides the greppable prefix too');
});

shTest('an unknown subcommand fails loudly rather than doing nothing', () => {
  const r = run(['warmup', 'unit'], { CCACHE_DIR: tmp() });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /usage: scripts\/ci-ccache\.sh provide\|report/);
});

shTest('provide is idempotent and announces the directory it will warm', { skip: !HAVE_CCACHE }, () => {
  const dir = tmp();
  for (const pass of [1, 2]) {
    const r = run(['provide', 'unit'], { CCACHE_DIR: dir });
    assert.strictEqual(r.status, 0, `pass ${pass}: ${r.stderr}`);
    assert.match(r.stderr, new RegExp(`ready dir=${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} `));
  }
  assert.ok(fs.existsSync(dir), 'provide must create the directory actions/cache will save');
});

shTest('report prints ONE greppable line a human can scan 42 legs of', { skip: !HAVE_CCACHE }, () => {
  const dir = tmp();
  assert.strictEqual(run(['provide', 'unit'], { CCACHE_DIR: dir }).status, 0);
  const r = run(['report', 'linux-x64-glibc'], { CCACHE_DIR: dir });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr,
    /^ci-ccache: linux-x64-glibc: HITS=\d+ MISSES=\d+ TOTAL=\d+ RATE=\S+ VERDICT=\S+$/m);
});

shTest('report distinguishes "nothing went through the launcher" from "it missed"',
  { skip: !HAVE_CCACHE }, () => {
    const dir = tmp();
    assert.strictEqual(run(['provide', 'unit'], { CCACHE_DIR: dir }).status, 0);
    // Zeroed counters, no compiler ever launched: the state a leg is in when ccache was
    // installed but cmake never routed the compiler through it. That reads identically to
    // a healthy cold cache in `ccache -s`, which omits zeroed counters entirely.
    assert.match(run(['report', 'unit'], { CCACHE_DIR: dir }).stderr,
      /VERDICT=NOTHING-CACHED/);

    // And the same script, after two real compilations of one file, says HIT.
    const work = tmp();
    const src = path.join(work, 'a.c');
    fs.writeFileSync(src, 'int main(void){return 0;}\n');
    const cc = spawnSync('sh', ['-c', 'command -v cc || command -v gcc || command -v clang'],
      { encoding: 'utf8' });
    if (cc.status !== 0) return; // no compiler on this box: the line above is still proven
    const compiler = cc.stdout.trim().split('\n')[0];
    for (const out of ['a1.o', 'a2.o']) {
      const c = spawnSync('ccache', [compiler, '-c', src, '-o', path.join(work, out)],
        { encoding: 'utf8', env: { ...process.env, CCACHE_DIR: dir } });
      assert.strictEqual(c.status, 0, c.stderr);
    }
    const r = run(['report', 'unit'], { CCACHE_DIR: dir });
    assert.match(r.stderr, /HITS=1 MISSES=1 TOTAL=2 RATE=50\.0% VERDICT=HIT/,
      'one miss then one hit over the same translation unit is the whole mechanism');
  });

// ---------------------------------------------------------------------------
// GUARD-adjacent: the repo cache-usage line `report` prints alongside the verdict.
// ---------------------------------------------------------------------------
//
// WHY THIS EXISTS: see .superpowers/sdd/guest-carve-and-ccache.md -- VERDICT=ALL-MISS
// on every leg was diagnosed BY HAND as capacity/LRU eviction (a few multi-GB guest
// images and toolchain caches on `refs/pull/*/merge` fill the repo's shared 10 GB
// budget and evict a run-scoped ccache entry before the next run can ever read it),
// not broken wiring -- and that distinction cost two wrong predictions before anyone
// thought to ask actions/cache/usage. This makes it readable from a leg's own log.
//
// A fake `curl` on PATH gives deterministic bodies without a live token; the
// degrade-path tests clear GITHUB_TOKEN/GITHUB_REPOSITORY explicitly so a real one
// leaking in from this box's own environment cannot make them pass for the wrong
// reason.
function fakeCurl(dir, body) {
  const bin = path.join(dir, 'curl');
  fs.writeFileSync(bin, `#!/bin/sh\ncat <<'CURL_EOF'\n${body}\nCURL_EOF\n`);
  fs.chmodSync(bin, 0o755);
  return dir;
}

shTest('report degrades to "usage unknown" with no token, rather than guessing or failing',
  { skip: !HAVE_CCACHE }, () => {
    const dir = tmp();
    assert.strictEqual(run(['provide', 'unit'], { CCACHE_DIR: dir }).status, 0);
    const r = run(['report', 'unit'],
      { CCACHE_DIR: dir, GITHUB_TOKEN: '', GITHUB_REPOSITORY: '' });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stderr, /^ci-ccache: unit: cache usage unknown \(/m);
  });

shTest('report prints repo cache usage alongside the verdict, when it can ask',
  { skip: !HAVE_CCACHE }, () => {
    const dir = tmp();
    const binDir = fakeCurl(tmp(), JSON.stringify({
      full_name: 'schmonz/clode', active_caches_size_in_bytes: 1000000, active_caches_count: 3,
    }));
    assert.strictEqual(run(['provide', 'unit'], { CCACHE_DIR: dir }).status, 0);
    const r = run(['report', 'unit'], {
      CCACHE_DIR: dir, PATH: `${binDir}:${process.env.PATH}`,
      GITHUB_REPOSITORY: 'schmonz/clode', GITHUB_TOKEN: 'fake',
    });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stderr,
      /^ci-ccache: unit: cache usage: entries=3 bytes=1000000 of \d+ \([\d.]+%\)$/m);
  });

shTest('VERDICT=ALL-MISS names eviction as the likely cause ONLY when usage backs it up',
  { skip: !HAVE_CCACHE }, () => {
    const dir = tmp();
    // Same 77.7%-of-budget occupancy the real incident measured (7,770,191,495 of
    // 10,000,000,000) -- the exact evidence this line is allowed to reason from.
    const binDir = fakeCurl(tmp(), JSON.stringify({
      full_name: 'schmonz/clode', active_caches_size_in_bytes: 7770191495, active_caches_count: 34,
    }));
    assert.strictEqual(run(['provide', 'unit'], { CCACHE_DIR: dir }).status, 0);
    const work = tmp();
    const src = path.join(work, 'a.c');
    fs.writeFileSync(src, 'int main(void){return 2;}\n');
    const cc = spawnSync('sh', ['-c', 'command -v cc || command -v gcc || command -v clang'],
      { encoding: 'utf8' });
    if (cc.status !== 0) return; // no compiler on this box: covered by the PROOF test below
    const compiler = cc.stdout.trim().split('\n')[0];
    // Exactly one compile -- HITS=0 MISSES=1, VERDICT=ALL-MISS (not NOTHING-CACHED).
    const c = spawnSync('ccache', [compiler, '-c', src, '-o', path.join(work, 'a.o')],
      { encoding: 'utf8', env: { ...process.env, CCACHE_DIR: dir } });
    assert.strictEqual(c.status, 0, c.stderr);
    const r = run(['report', 'unit'], {
      CCACHE_DIR: dir, PATH: `${binDir}:${process.env.PATH}`,
      GITHUB_REPOSITORY: 'schmonz/clode', GITHUB_TOKEN: 'fake',
    });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stderr,
      /VERDICT=ALL-MISS at 77\.7% of the repo cache budget: EVICTION is the likely cause/);
  });

// PROOF the eviction note is not printed unconditionally: a HIT at the same occupancy
// must not carry it -- otherwise the note would be decoration, not evidence-gated.
shTest('PROOF: the eviction note is gated on VERDICT=ALL-MISS, not printed for a HIT',
  { skip: !HAVE_CCACHE }, () => {
    const dir = tmp();
    const binDir = fakeCurl(tmp(), JSON.stringify({
      full_name: 'schmonz/clode', active_caches_size_in_bytes: 7770191495, active_caches_count: 34,
    }));
    assert.strictEqual(run(['provide', 'unit'], { CCACHE_DIR: dir }).status, 0);
    const work = tmp();
    const src = path.join(work, 'a.c');
    fs.writeFileSync(src, 'int main(void){return 3;}\n');
    const cc = spawnSync('sh', ['-c', 'command -v cc || command -v gcc || command -v clang'],
      { encoding: 'utf8' });
    if (cc.status !== 0) return;
    const compiler = cc.stdout.trim().split('\n')[0];
    for (const out of ['a1.o', 'a2.o']) {
      const c = spawnSync('ccache', [compiler, '-c', src, '-o', path.join(work, out)],
        { encoding: 'utf8', env: { ...process.env, CCACHE_DIR: dir } });
      assert.strictEqual(c.status, 0, c.stderr);
    }
    const r = run(['report', 'unit'], {
      CCACHE_DIR: dir, PATH: `${binDir}:${process.env.PATH}`,
      GITHUB_REPOSITORY: 'schmonz/clode', GITHUB_TOKEN: 'fake',
    });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stderr, /VERDICT=HIT/);
    assert.doesNotMatch(r.stderr, /EVICTION is the likely cause/);
  });

// PROOF that the two assertions above are not vacuous: the same regex must REJECT the
// shape the old world produced (a decision line with no hit information in it).
test('PROOF: the stats regex rejects build-tjs\'s decision line, which carries no hit rate', () => {
  const decisionLine = 'build-tjs: ccache: ENABLED launcher=/usr/bin/ccache compiler=gcc (found on PATH)';
  assert.doesNotMatch(decisionLine,
    /^ci-ccache: \S+: HITS=\d+ MISSES=\d+ TOTAL=\d+ RATE=\S+ VERDICT=\S+$/m,
    'if this ever matches, the guard above is measuring the wrong line');
});

// The script is referenced from YAML by path; test/workflow-scripts-exist.test.cjs checks
// that every `scripts/*.sh` a workflow names exists, so this only has to pin the bit that
// guard cannot see: it must be runnable as written.
test('scripts/ci-ccache.sh is POSIX sh a busybox-ash alpine container can run', { skip: NO_SH }, () => {
  const r = spawnSync('sh', ['-n', SCRIPT], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  // `sh -n` alone is NOT enough on this box: macOS /bin/sh is bash in sh-mode and parses
  // bashisms happily, so the one machine most likely to author them is the one least able
  // to notice. Scan the CODE lines (the prose above is full of the words) for the
  // constructs busybox ash does not have.
  const code = fs.readFileSync(SCRIPT, 'utf8').split('\n')
    .map((l, i) => [i + 1, l]).filter(([, l]) => !/^\s*#/.test(l));
  const BASHISMS = [
    [/\[\[/, '[[ ... ]]'], [/<<</, 'here-string <<<'], [/\$\{!/, '${!indirect}'],
    [/^\s*local\s/, 'local'], [/^\s*function\s/, 'function keyword'],
    [/^\s*source\s/, 'source (use .)'], [/\+=/, '+= append'],
  ];
  const found = code.flatMap(([n, l]) => BASHISMS
    .filter(([re]) => re.test(l)).map(([, what]) => `${SCRIPT}:${n}: ${what}`));
  assert.deepStrictEqual(found, [],
    'bashisms: one caller is `sh -e` inside alpine:3.22 (busybox ash)');
});

// PROOF the scan above is not vacuous: it must find a bashism when one is there.
test('PROOF: the bashism scan rejects a script that uses [[', () => {
  const bad = ['#!/bin/sh', '# [[ in a comment must not count', 'if [[ -n "$x" ]]; then :; fi']
    .map((l, i) => [i + 1, l]).filter(([, l]) => !/^\s*#/.test(l));
  assert.strictEqual(bad.filter(([, l]) => /\[\[/.test(l)).length, 1,
    'one code line, and the comment above it is correctly ignored');
});
