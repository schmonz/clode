'use strict';
// scripts/build-tjs-boot.sh — the ONE way a CI leg runs scripts/build-tjs.cjs, and the
// gate on how many legs still run it under node.
//
// WHY THIS FILE EXISTS AT ALL. The thing being changed here is a CI-only invocation, and
// this repo has been burned twice by exactly that shape: a test that asserted source TEXT
// while the real path was broken, and an opt-in gate nothing ever scheduled. So the
// wrapper is written so that it CAN be run locally — it shells out to a resolver, a
// loader and an engine, every one of which is a path, so a sandbox with stub programs at
// those paths exercises the real file end to end. Every behavioural test below runs a
// VERBATIM COPY of scripts/build-tjs-boot.sh (the bytes, not a paraphrase) against such a
// sandbox. What remains CI-only is whether the pinned slice for a given leg's target
// actually fetches and passes the floor probe on that leg's machine; that is
// test/bootstrap-engine-online.test.cjs's question, and ultimately the leg's.
//
// THE FAILURE MODE THIS IS DESIGNED AGAINST. A flip that "works" because the node
// fallback quietly took over is a GREEN CI run that proves nothing about tjs. Hence the
// one greppable line: every run of the wrapper prints exactly one
// `build-tjs-engine: engine=...` line saying which interpreter actually ran the build,
// so "did this leg really run under tjs?" is a grep, not an argument.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { defineGuard, guardTests } = require('./guard.cjs');
const { shTest, committedExecBit } = require('./posix-host.cjs');
const G = require('../scripts/build-graph.cjs');

const REPO = path.join(__dirname, '..');
const BOOT = path.join(REPO, 'scripts', 'build-tjs-boot.sh');
const ACTION = path.join(REPO, '.github', 'actions', 'build-leg', 'action.yml');
// The one token a CI log is grepped for. Spelled here so a rename has to be deliberate.
const LOG_PREFIX = 'build-tjs-engine:';

// ---------------------------------------------------------------------------
// A sandbox: the real wrapper, with stubs at every path it shells out to.
// ---------------------------------------------------------------------------
function sandbox({ rc = 0, stdout = '', stderr = '', target = 'linux-amd64', node = true,
  engineExit = 0 } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-boot-'));
  const w = (p, body, mode) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
    if (mode) fs.chmodSync(p, mode);
    return p;
  };
  // The wrapper UNDER TEST: the real bytes, at the real relative path, so `$0`-relative
  // resolution is exercised rather than assumed.
  w(path.join(d, 'scripts', 'build-tjs-boot.sh'), fs.readFileSync(BOOT), 0o755);
  // A resolver whose exit code and output the case chooses.
  w(path.join(d, 'scripts', 'bootstrap-engine.sh'),
    '#!/bin/sh\n'
    + `case "$1" in --print-target) printf '%s\\n' '${target}'; exit 0 ;; esac\n`
    + `printf '%s' '${stdout}'\n`
    + `printf '%s' '${stderr}' >&2\n`
    + `exit ${rc}\n`, 0o755);
  w(path.join(d, 'scripts', 'build-tjs.cjs'), '// stub\n');
  w(path.join(d, 'libexec', 'node-shim', 'loader.cjs'), '// stub\n');
  // Recorders. Each writes its own argv, one per line, so the test asserts the EXACT
  // invocation rather than "something ran".
  const rec = (name, exit) => w(path.join(d, 'bin', name),
    `#!/bin/sh\n: > '${d}/${name}.argv'\nfor a in "$@"; do printf '%s\\n' "$a" >> '${d}/${name}.argv'; done\nexit ${exit}\n`,
    0o755);
  rec('tjs', engineExit);
  if (node) rec('node', 0);
  return { dir: d, engine: path.join(d, 'bin', 'tjs'), binDir: path.join(d, 'bin') };
}

function run(sb, args) {
  const { spawnSync } = require('node:child_process');
  // A DELIBERATELY BARE environment: nothing about resolution may leak in from the suite
  // (run.mjs exports a real CLODE_TJS), and PATH holds only the sandbox's own bin — which
  // is how "there is no node on this machine" becomes expressible at all.
  // Invoked DIRECTLY, not through `sh <path>`: that exercises the exec bit and the
  // shebang, which is how CI calls it, and it keeps PATH free to be almost empty.
  const r = spawnSync(path.join(sb.dir, 'scripts', 'build-tjs-boot.sh'), args,
    { encoding: 'utf8', env: { PATH: sb.binDir, HOME: sb.dir } });
  return { status: r.status, out: (r.stdout || ''), err: (r.stderr || '') };
}

const argvOf = (sb, name) => {
  const p = path.join(sb.dir, `${name}.argv`);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean) : null;
};

// Parse the one greppable line out of a run's output, as a CI grep would.
function verdict(out) {
  const lines = out.split('\n').filter((l) => l.startsWith(LOG_PREFIX));
  assert.strictEqual(lines.length, 1,
    `expected exactly one ${LOG_PREFIX} line, got ${lines.length}:\n${out}`);
  const f = {};
  for (const kv of lines[0].slice(LOG_PREFIX.length).trim().split(/\s+/)) {
    const i = kv.indexOf('=');
    f[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return f;
}

// ---------------------------------------------------------------------------
// What the wrapper does.
//
// shTest, NOT test: every case below spawns scripts/build-tjs-boot.sh BY ITS OWN PATH,
// which on win32 is not an executable image at all — spawnSync answers `status: null`
// and all nine cases failed on `null !== 0` in CI run 35521083887 (tests 216-224). The
// skip, its stated reason, and the gate that keeps it from spreading live in
// test/posix-host.cjs; no Windows leg runs this wrapper (the msvc legs run
// `node scripts/build-tjs.cjs` natively — see SPLIT_BY_PLATFORM below, which records that
// as the reason step 4 is POSIX-only), and the ubuntu and darwin rows run all nine for
// real on every push. The GUARD below still runs here, because it READS the wrapper.
// ---------------------------------------------------------------------------

shTest('resolver exit 0 -> build-tjs.cjs runs UNDER the resolved engine, through the shim loader', () => {
  const sb = sandbox();
  fs.writeFileSync(path.join(sb.dir, 'scripts', 'bootstrap-engine.sh'),
    `#!/bin/sh\ncase "$1" in --print-target) echo linux-amd64; exit 0 ;; esac\nprintf '%s\\n' '${sb.engine}'\n`);
  fs.chmodSync(path.join(sb.dir, 'scripts', 'bootstrap-engine.sh'), 0o755);
  const r = run(sb, ['a-site', '--build-only']);
  assert.strictEqual(r.status, 0, r.err);
  assert.deepStrictEqual(argvOf(sb, 'tjs'), [
    'run',
    path.join(sb.dir, 'libexec', 'node-shim', 'loader.cjs'),
    path.join(sb.dir, 'scripts', 'build-tjs.cjs'),
    '--build-only',
  ], 'the engine must be handed `run <loader> <build-tjs.cjs> <flags>` — the exact shape '
    + 'test/build-tjs-no-node.test.cjs proved all three modes under');
  assert.strictEqual(argvOf(sb, 'node'), null, 'node must not have run at all');
  const v = verdict(r.out);
  assert.strictEqual(v.engine, 'tjs');
  assert.strictEqual(v.site, 'a-site');
  assert.strictEqual(v.path, sb.engine);
  assert.strictEqual(v['resolver-rc'], '0');
});

shTest('resolver exit 3 -> node, and the line says node so a green run cannot be mistaken for a tjs one', () => {
  const sb = sandbox({ rc: 3, stderr: 'bootstrap: no linux-brandnewarch in pack\\n' });
  const r = run(sb, ['a-site', '--build-only']);
  assert.strictEqual(r.status, 0, r.err);
  assert.deepStrictEqual(argvOf(sb, 'node'),
    [path.join(sb.dir, 'scripts', 'build-tjs.cjs'), '--build-only']);
  assert.strictEqual(argvOf(sb, 'tjs'), null);
  const v = verdict(r.out);
  assert.strictEqual(v.engine, 'node');
  assert.strictEqual(v['resolver-rc'], '3');
  assert.match(r.err, /no linux-brandnewarch in pack/,
    "the resolver's own reason must reach the log, not be swallowed by the wrapper");
});

shTest('a resolver REFUSAL (exit 1) does not fall back — it fails, and nothing runs', () => {
  // The distinction the whole design rests on: exit 3 is "this target has no slice yet,
  // build it under node once"; exit 1 is a finding (a bad digest, a lying hasher, an
  // engine that misses HEAD's API floor). Falling back on a finding would convert every
  // one of those into a silently-green build under node, which is precisely the gate that
  // cannot fail.
  const sb = sandbox({ rc: 1, stderr: 'bootstrap: sha256 mismatch\\n' });
  const r = run(sb, ['a-site', '--build-only']);
  assert.notStrictEqual(r.status, 0, 'a refusal must fail the step');
  assert.strictEqual(argvOf(sb, 'node'), null, 'node must NOT pick up after a refusal');
  assert.strictEqual(argvOf(sb, 'tjs'), null);
  assert.strictEqual(verdict(r.out).engine, 'none');
});

shTest('exit 3 with no node on the machine fails loudly rather than doing nothing', () => {
  // This is the alpine case after `nodejs` leaves its packages list: there is no node to
  // fall back to. The honest outcome is a red leg naming the situation, never a step that
  // exits 0 having built nothing.
  const sb = sandbox({ rc: 3, node: false });
  const r = run(sb, ['a-site', '--build-only']);
  assert.notStrictEqual(r.status, 0);
  assert.strictEqual(verdict(r.out).engine, 'none');
  assert.match(r.err, /no node/i);
});

shTest('the build\'s own exit status is the step\'s exit status', () => {
  const sb = sandbox({ engineExit: 7 });
  fs.writeFileSync(path.join(sb.dir, 'scripts', 'bootstrap-engine.sh'),
    `#!/bin/sh\ncase "$1" in --print-target) echo linux-amd64; exit 0 ;; esac\nprintf '%s\\n' '${sb.engine}'\n`);
  fs.chmodSync(path.join(sb.dir, 'scripts', 'bootstrap-engine.sh'), 0o755);
  const r = run(sb, ['a-site', '--build-only']);
  assert.strictEqual(r.status, 7,
    'the wrapper must not swallow or rewrite the build\'s status — a step that reports 0 '
    + 'for a failed build is the worst outcome available');
});

shTest('a resolver that exits 0 but prints nothing is refused, not run as ""', () => {
  const sb = sandbox({ rc: 0, stdout: '' });
  const r = run(sb, ['a-site', '--build-only']);
  assert.notStrictEqual(r.status, 0);
  assert.strictEqual(verdict(r.out).engine, 'none');
});

shTest('the log line is a flat key=value list: no field ever contains a space', () => {
  // `args=--source-only --build-only` would read as two fields to anything that splits on
  // whitespace — including verdict() above, which is deliberately written the way a CI
  // grep|awk would be. The one artifact this whole wave is accepted on has to parse.
  const sb = sandbox({ rc: 3 });
  const r = run(sb, ['a-site', '--source-only', '--build-only']);
  assert.strictEqual(r.status, 0, r.err);
  const v = verdict(r.out);
  assert.strictEqual(v.args, '--source-only,--build-only');
  assert.strictEqual(v.engine, 'node');
});

shTest('it takes a site label and at least one build-tjs argument, or exits 2', () => {
  const sb = sandbox();
  assert.strictEqual(run(sb, []).status, 2);
  assert.strictEqual(run(sb, ['a-site']).status, 2);
});

shTest('it runs identically under dash', (t) => {
  const { execFileSync, spawnSync } = require('node:child_process');
  let dash = '';
  try { dash = execFileSync('sh', ['-c', 'command -v dash'], { encoding: 'utf8' }).trim(); } catch { /* none */ }
  if (!dash) return t.skip('no dash on this box (the POSIX syntax floor is asserted by the guard below)');
  const sb = sandbox({ rc: 3 });
  const r = spawnSync(dash, [path.join(sb.dir, 'scripts', 'build-tjs-boot.sh'), 'a-site', '--build-only'],
    { encoding: 'utf8', env: { PATH: sb.binDir, HOME: sb.dir } });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(verdict(r.stdout).engine, 'node');
});

// ---------------------------------------------------------------------------
// How many legs still run build-tjs.cjs under node, and where.
// ---------------------------------------------------------------------------

// WHAT "THE CALL SITE" MEANS NOW (runner-step-mode, 2026-09-21). Every engine call site in
// this action NAMES A GRAPH STEP; none spells out a command, and test/build-graph-ci.test.cjs
// refuses one that does. So the two spellings this file's tables are about have MOVED, and
// the property they pin has not:
//
//   under a bootstrap engine   `./build.sh --only <id> [--needs assume]` — POSIX sh, the
//                              spelling for a machine that must build with no node. It
//                              resolves an engine and runs the graph under it, and the
//                              graph is what invokes scripts/build-tjs-boot.sh.
//   under node                 `node scripts/build-runner.cjs --only <id>` — the spelling
//                              for a machine that has to stay on node.
//
// The wrapper itself now has exactly ONE caller in the whole repo (build-graph.cjs's
// runBuildTjs), which is why the "three subtly different spellings" rule below is about the
// ENTRY POINT's idiom instead: that is where a per-call-site invention could appear today.
//
// The call sites in .github/actions/build-leg/action.yml that are DELIBERATELY not flipped
// yet, each with the reason, keyed by the step that contains them (a line number would rot
// on the next edit). This table is the whole point: it shrinks, and it cannot go stale in
// either direction — an entry with no matching site is a phantom and fails, and a site with
// no entry is an unexplained node and fails. The sequencing is
// .superpowers/sdd/node-removal-bootstrap-design.md §3, steps 3-6.
// Wave 1 flipped three sites and deleted their three entries from here, one commit each;
// what is left is what is still true, never a description of intent.
// EMPTY, and that is the milestone: every engine-build call site in the file now runs
// under a bootstrap engine on at least one platform. The table stays because the rule it
// feeds is what makes a NEW unflipped site fail instead of arriving unnoticed — with no
// entries it is strictly stronger, not weaker.
const NOT_YET_FLIPPED = {};

// A site can be flipped for SOME of the machines it runs on. `Build tjs (native)` is one
// step for ubuntu, macOS and Windows, and the flip is proven on POSIX and unproven on
// win32 — so it runs the wrapper on POSIX and stays on node for Windows. That is a THIRD
// state, and neither table above could express it: left in NOT_YET_FLIPPED a real flip
// would read as no flip at all, and deleted from it the surviving `node
// scripts/build-tjs.cjs` would read as an unexplained node.
//
// The entry costs what it should: the step must contain BOTH spellings. Delete the
// bootstrap half (`./build.sh`) and the split is a fiction, which is how a half-flip
// silently becomes an un-flip; delete the node half and the step is fully flipped and the
// entry is a phantom.
const SPLIT_BY_PLATFORM = {
  'Construct the patched tjs tree from pins (host, native speed)':
    'step 6, POSIX ONLY. The blocker is gone: scripts/provision-bundle-inputs.sh fetches '
    + 'esbuild and txiki\'s runtime dep closure with no npm and no node, reading every '
    + 'version/URL/sha512 out of the pinned checkout\'s own package-lock.json, and a cold '
    + 'checkout produces all 17 files under src/bundles/js/** byte-identical to the warm '
    + 'path (test/build-tjs-cold-provision.test.cjs). `--source-only` under the shim with '
    + 'no Node on PATH is the first row of test/build-tjs-no-node.test.cjs. Windows stays '
    + 'on node for TWO reasons, not one: the wrapper has never run on win32 (see the entry '
    + 'below), AND provisionBundleInputs returns immediately on win32 because there is no '
    + 'POSIX sh it can spawn by an absolute path — so a flipped Windows half would reach '
    + 'the gate\'s refusal, not a build. It costs nothing: --source-only runs once per '
    + 'matrix and the Windows runners have npm.',
  'Build tjs (native)':
    'step 4, POSIX ONLY. Flipped for ubuntu and macOS (`--build-only` under tjs is proven '
    + 'by test/build-tjs-no-node.test.cjs and measured at 68s in phase 1). The two MSVC '
    + 'legs are the SAME step and stay on node, stated not silent: nothing has run this '
    + 'wrapper on win32 — test/posix-host.cjs records that spawning it by its own path '
    + 'there gives status null, the pack\'s windows-amd64 slice has never been range-'
    + 'fetched by any leg, and there is no expression of "a PATH with no node" for win32. '
    + 'To cover Windows later: a win32 row for build-tjs-no-node.test.cjs, a wrapper '
    + 'invocation win32 can actually execute (the `bash` shell GitHub gives Windows '
    + 'runners is git-bash, so `sh scripts/build-tjs-boot.sh` is the candidate), and one '
    + 'leg proving the windows-amd64 slice resolves, passes the floor probe and builds.',
};

// A walk back to the nearest `- name:`, so a site is attributed to the STEP that contains
// it and never to a line number, which would rot on the next edit.
function sitesMatching(yaml, re) {
  const out = [];
  let step = '(before any step)';
  for (const line of yaml.split('\n')) {
    const m = /^\s*-\s+name:\s*(.+?)\s*$/.exec(line);
    if (m) step = m[1];
    const t = line.trim().replace(/^run:\s+/, '');
    if (!t.startsWith('#') && re.test(t)) out.push(step);
  }
  return out;
}

// Which step runs the engine build UNDER NODE. The runner is the graph's own entry point
// for a machine that has to keep one, so this is the same question it always was — the
// command it names has changed, not the property.
const NODE_SITE = /(^|\s)node\s+scripts\/build-runner\.cjs/;
function rawNodeSites(yaml) {
  return sitesMatching(yaml, NODE_SITE);
}

// And which step runs it under a bootstrap engine: the POSIX entry point, whose filename
// comes from the graph so a rename moves this rule with it.
//
// THE LEADING `./` IS REQUIRED, and that is a narrowing a false finding taught (this
// commit): NetBSD's OWN build.sh is named three times in this action's `description:`
// fields ("cross-build the engine with a NetBSD build.sh toolchain"), and a rule that
// matched the bare filename read three paragraphs of prose as three malformed call sites.
// Every real invocation spells the path, prose never does.
const BOOTED_SITE = new RegExp(`(^|\\s)\\./${G.ENTRY_REL.replace(/[.]/g, '\\$&')}(\\s|$)`);
function bootSiteSteps(yaml) {
  return sitesMatching(yaml, BOOTED_SITE);
}

// Which steps SET each of the two bootstrap target knobs. Same walk again; a step is
// counted once per knob.
function targetKnobSteps(yaml, knob) {
  const out = new Set();
  let step = '(before any step)';
  for (const line of yaml.split('\n')) {
    const m = /^\s*-\s+name:\s*(.+?)\s*$/.exec(line);
    if (m) step = m[1];
    const t = line.trim();
    if (t.startsWith('#')) continue;
    if (new RegExp(`(^|[\\s:])${knob}[=:]`).test(t)) out.add(step);
  }
  return out;
}

// Every step as { name, if, body } — the same walk once more, keeping each step's own
// `if:` so a rule can compare one step's gate against another's. The first `if:` key wins
// (a step has one); `if [ ... ]` inside a run: block is not an `if:` key and never matches.
function stepsOf(yaml) {
  const out = [];
  let cur = null;
  for (const line of yaml.split('\n')) {
    const m = /^\s*-\s+name:\s*(.+?)\s*$/.exec(line);
    if (m) { cur = { name: m[1], if: '', body: [] }; out.push(cur); continue; }
    if (!cur) continue;
    const g = /^\s+if:\s*(.+?)\s*$/.exec(line);
    if (g && !cur.if) cur.if = g[1];
    cur.body.push(line);
  }
  return out;
}

// Call sites only, and the COMMAND only. A YAML comment that names the entry point is
// prose about it, not an invocation of it, and demanding the idiom's shape of prose would
// make the rule unwritable-about; a one-line `run:` step carries the YAML key on the same
// line as the command. Both narrowings were found by the rule firing on a real flip, and
// neither loosens what is pinned: the command text itself still has to be identical modulo
// the step id and the needs mode.
function bootSites(yaml) {
  return yaml.split('\n').map((l) => l.trim().replace(/^run:\s+/, ''))
    .filter((l) => !l.startsWith('#') && BOOTED_SITE.test(l));
}

const BASHISMS = [
  [/^\s*\[\[/m, '[[ ]] test'], [/^\s*local\s/m, '`local`'], [/^\s*declare\s/m, '`declare`'],
  [/^\s*function\s+[A-Za-z_]/m, '`function` keyword'],
  [/\$\{[A-Za-z_][A-Za-z0-9_]*\[/, 'array subscript'],
];

// ONE idiom, six times: `./build.sh --only <step-id> [--needs assume]`. A per-call-site
// invention is how subtly different spellings end up in one file and only one of them is
// ever tested. The step id and the two `needs` modes come from the graph, so a renamed step
// or a third mode moves this rule instead of leaving it quietly matching nothing.
const IDIOM = new RegExp(`^\\./${G.ENTRY_REL.replace(/[.]/g, '\\$&')}`
  + ` --only (?:${G.steps().map((s) => s.id.replace(/[.]/g, '\\.')).join('|')})`
  + `(?: --needs (?:${G.NEEDS.join('|')}))?(?:\\s+#.*)?$`);

const GUARD = defineGuard({
  name: 'build-tjs-invocation-shape',
  floor: 13,
  read: () => ({
    sh: fs.readFileSync(BOOT, 'utf8'),
    // The SHIPPED bit, from git's index — not the checkout's. On win32 every file's
    // mode reads 0o666 (NTFS has no POSIX mode), so the fs answer turned this
    // structural rule into a platform report and the guard fired on Windows over a
    // file that is 100755 in the index. See test/posix-host.cjs.
    executable: committedExecBit('scripts/build-tjs-boot.sh'),
    yaml: fs.readFileSync(ACTION, 'utf8'),
    buildTjs: fs.readFileSync(path.join(REPO, 'scripts', 'build-tjs.cjs'), 'utf8'),
  }),
  scan: (i) => {
    const f = [];
    let examined = 0;
    const rule = (ok, finding) => { examined += 1; if (!ok) f.push(finding); };
    rule(/^#!\/bin\/sh$/.test(i.sh.split('\n')[0]) && i.executable,
      'the wrapper must be an executable #!/bin/sh script — it runs in alpine containers '
      + 'and in minimal VM guests where bash may be absent');
    const bashisms = BASHISMS.filter(([re]) => re.test(i.sh)).map(([, what]) => what);
    rule(bashisms.length === 0,
      `bash-only syntax (${bashisms.join(', ')}) in a file that must run under dash/ash`);
    rule(i.sh.includes(LOG_PREFIX),
      `the wrapper must print the one greppable \`${LOG_PREFIX}\` line — it is the whole `
      + 'answer to "did this leg really run under tjs, or did the fallback take over?"');
    rule(!/build-tjs-boot\.sh/.test(i.buildTjs),
      'scripts/build-tjs.cjs names its own wrapper. It is the program being bootstrapped; '
      + 'the wrapper lives in the CALLER, same rule as the resolver.');

    const bad = bootSites(i.yaml).filter((l) => !IDIOM.test(l));
    rule(bad.length === 0,
      `these ./${G.ENTRY_REL} call sites do not use the one idiom `
      + `(\`./${G.ENTRY_REL} --only <step-id> [--needs ${G.NEEDS.join('|')}]\`): `
      + `${bad.join(' / ')}`);

    // WHERE THE RESOLVER'S CACHE ACTUALLY IS. Every actions/cache entry for a bootstrap
    // slice names a directory scripts/bootstrap-engine.sh writes, and that path is
    // `<cache root>/bootstrap/<tag>/<target>` — the `bootstrap/` segment is the
    // resolver's, not the cache root's. An entry that leaves it out names a directory
    // that never exists: actions/cache warns and saves nothing, the key never hits, and
    // the leg re-fetches a byte-identical sha256-pinned slice every run while the log
    // reads exactly like a working cache. That is the alpine entry as wave 1 shipped it,
    // and it is the shape every later one would have been copied from.
    const slicePaths = i.yaml.split('\n').map((l) => l.trim())
      .filter((l) => /^path:/.test(l) && /bootstrap/.test(l));
    // The TARGET half is left open: it is steps.name.outputs.target where the machine
    // that runs the engine is the leg's own (alpine, the VM guests) and the RUNNER's
    // target where it is not (the cross-toolchain containers are x86_64 images on an
    // x86_64 runner, cross-compiling for somebody else). What is pinned is the shape:
    // <cache root>/bootstrap/<tag>/<one target expression>.
    const SLICE_PATH = /\/bootstrap\/\$\{\{ steps\.bootstrap-tag\.outputs\.tag \}\}\/\$\{\{ steps\.[a-z-]+\.outputs\.[a-z-]+ \}\}$/;
    const wrong = slicePaths.filter((l) => !SLICE_PATH.test(l));
    rule(slicePaths.length > 0 && wrong.length === 0,
      `these actions/cache entries do not name the directory the resolver writes `
      + `(<cache root>/bootstrap/<tag>/<target>): ${wrong.join(' / ')}. A cache keyed on `
      + 'bytes that are never stored there is a cache that cannot hit.');

    // AND WHICH TARGET, for the one case a rule can settle. An entry whose cache root is
    // the resolver's own default (~/.cache/clode) is a cache the RUNNER fills by running
    // the resolver with no target override — which always resolves the runner's own
    // target, never the leg's. Both host-side entries shipped keyed on the LEG's
    // (netbsd-sparc, netbsd-m68k) and so named directories that never exist, the same
    // way the alpine entry did. The workspace-mounted entries are left to the rule above:
    // there the target legitimately differs per consumer (the leg's own for alpine and
    // the VM guests, the runner's for the cross containers).
    const hostRooted = slicePaths.filter((l) => l.includes('~/.cache/clode/'));
    const misTargeted = hostRooted.filter((l) =>
      !l.endsWith('${{ steps.bootstrap-tag.outputs.host-target }}'));
    rule(misTargeted.length === 0,
      `these host-side bootstrap caches are keyed on the LEG's target, not the RUNNER's: `
      + `${misTargeted.join(' / ')}. The resolver runs here with no target override, so `
      + 'it resolves this runner — a netbsd-sparc directory under ~/.cache/clode is never '
      + 'written and the key never hits.');

    // AND HOW WIDE. The --source-only step has no leg condition at all: it constructs the
    // patched tree on the RUNNER for every leg in the matrix, cross-container and alpine
    // and VM-guest legs included. Since it flipped onto the wrapper, that means every
    // non-Windows leg now asks the resolver for an engine under the DEFAULT cache root,
    // and a host-side cache entry gated on a narrower set of legs than that is not a
    // wrong cache but a missing one — the three leg families it names hit, the other
    // thirty-odd silently re-fetch a byte-identical sha256-pinned slice on every engine
    // rebuild, which reads in the log exactly like no cache at all because it IS none.
    // The expectation is DERIVED from that step's own gate plus the platform split, not
    // spelled here, so narrowing the site narrows this too.
    const allSteps = stepsOf(i.yaml);
    // WHICH STEP IS THE SOURCE PHASE, asked of the graph rather than of a site label that
    // no longer exists: the engine-phase step that needs nothing is the one that runs on
    // the runner for every leg. A renamed step moves this; a hand-written 'source-only'
    // would have gone quietly blind the moment the call site named an id instead.
    const srcId = G.steps().find((s) => s.phase === 'engine' && !s.needs.length).id;
    const srcOnly = allSteps.find((s) =>
      s.body.some((l) => {
        const t = l.trim().replace(/^run:\s+/, '');
        return !t.startsWith('#') && BOOTED_SITE.test(t) && t.includes(`--only ${srcId}`);
      }));
    const expectedIf = srcOnly ? `${srcOnly.if} && runner.os != 'Windows'` : null;
    const hostSide = allSteps.filter((s) => s.body.some((l) =>
      /^\s*id:\s*bootstrap-tag\s*$/.test(l) || /^\s*path:\s*~\/\.cache\/clode\/bootstrap/.test(l)));
    const narrower = hostSide.filter((s) => s.if !== expectedIf)
      .map((s) => `${s.name} [if: ${s.if || '(none)'}]`);
    rule(srcOnly !== undefined && hostSide.length > 0 && narrower.length === 0,
      `the host-side bootstrap steps are gated more narrowly than the step that fills `
      + `that cache: ${narrower.join(' / ')}. --source-only runs the wrapper on EVERY `
      + `non-Windows leg, so both must be \`${expectedIf}\` — anything narrower leaves `
      + 'those legs re-fetching the slice every run.');

    const raw = rawNodeSites(i.yaml);
    const booted = bootSiteSteps(i.yaml);
    const unexplained = raw.filter((s) => !(s in NOT_YET_FLIPPED) && !(s in SPLIT_BY_PLATFORM));
    rule(unexplained.length === 0,
      `these steps still run the engine build under node with no recorded reason: `
      + `${unexplained.join(' / ')}. Either flip them onto ./${G.ENTRY_REL} (which resolves `
      + 'a bootstrap engine and runs the graph under it) or record why not.');

    // WHICH KNOB, AND THEREFORE WHO OWES THE ACCEPTANCE. A step that runs the wrapper is
    // a step on the machine that will EXECUTE the engine, and such a machine must name
    // itself with CLODE_BOOTSTRAP_HOST_TARGET. Naming itself with CLODE_BOOTSTRAP_TARGET
    // instead says "fetch somebody else's slice", which makes the resolver take the cross
    // path: sha-verified, floor probe DEFERRED to the target machine — which is this one.
    // The acceptance is then owed by nobody and the leg is green having never run the one
    // check that goes red when HEAD's node-shim outruns the last release. A pure host-side
    // FETCH for another machine is the opposite case and keeps CLODE_BOOTSTRAP_TARGET;
    // it is a step that calls the resolver and never the wrapper.
    const runnersNamingSomeoneElse = [...targetKnobSteps(i.yaml, 'CLODE_BOOTSTRAP_TARGET')]
      .filter((s) => booted.includes(s));
    rule(runnersNamingSomeoneElse.length === 0,
      `these steps RUN the engine but name themselves with CLODE_BOOTSTRAP_TARGET: `
      + `${runnersNamingSomeoneElse.join(' / ')}. That is the cross-fetch knob, so the `
      + 'floor probe is deferred to the machine that will run the engine — which is this '
      + 'one. Use CLODE_BOOTSTRAP_HOST_TARGET, which makes the probe fire here.');

    const fiction = Object.keys(SPLIT_BY_PLATFORM).filter((s) => !booted.includes(s));
    rule(fiction.length === 0,
      `these steps claim a per-platform SPLIT but never run the engine build under a `
      + 'bootstrap engine: '
      + `${fiction.join(' / ')}. A split whose flipped half is missing is an un-flip with `
      + 'a nicer name — the whole reason the entry has to cost both spellings.');
    // The alpine containers' ONLY node consumer was scripts/build-tjs.cjs, so flipping
    // that site let `nodejs` leave their apk list — the single removal in this wave. This
    // file has exactly one literal packages: list (the VM legs' comes through
    // inputs.guest-packages and those guests still need node), so the rule can be the
    // whole-file fact rather than a lookup that would rot: putting nodejs back here is
    // putting a node back on eight machines, and it should have to be deliberate.
    const withNode = i.yaml.split('\n').map((l) => l.trim())
      .filter((l) => /^packages:/.test(l) && /\bnodejs\b/.test(l));
    rule(withNode.length === 0,
      `a guest package list installs node again: ${withNode.join(' / ')}. The alpine `
      + 'containers stopped needing one when their build-tjs.cjs call site flipped; if a '
      + 'leg needs node back, that is a finding about the flip, not a package to re-add.');

    const phantom = [...Object.keys(NOT_YET_FLIPPED), ...Object.keys(SPLIT_BY_PLATFORM)]
      .filter((s) => !raw.includes(s));
    rule(phantom.length === 0,
      `NOT_YET_FLIPPED names steps that no longer run the engine build under node: `
      + `${phantom.join(' / ')}. A carve-out that outlives its reason is how an exception `
      + 'list rots; delete the entry when you flip the site.');
    return { findings: f, examined };
  },
  // Every rule violated at once, so a scan that has gone blind on any of them shows up as
  // a shortfall rather than a pass.
  control: () => ({
    sh: '#!/bin/bash\nif [[ -n "$x" ]]; then :; fi\necho no-verdict-here\n',
    executable: false,
    yaml: '    - name: A brand new step\n      run: node scripts/build-runner.cjs --only engine.compile\n'
      + '    - name: The source phase\n      if: never\n'
      + `        run: ./${G.ENTRY_REL} --only engine.source\n`
      + `    - name: Sloppy\n      run: bash ./${G.ENTRY_REL} --build-only\n`
      + '        export CLODE_BOOTSTRAP_TARGET=linux-i386\n'
      + '        packages: build-base cmake nodejs\n'
      + '        path: ${{ github.workspace }}/.matrix/bootstrap-cache/${{ steps.bootstrap-tag.outputs.tag }}/${{ steps.name.outputs.target }}\n'
      + '        path: ~/.cache/clode/bootstrap/${{ steps.bootstrap-tag.outputs.tag }}/${{ steps.name.outputs.target }}\n',
    buildTjs: "spawnSync('scripts/build-tjs-boot.sh');\n",
  }),
});

guardTests(GUARD);
