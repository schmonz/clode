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
// `node scripts/build-tjs.cjs` natively — see NOT_YET_FLIPPED below, which records that
// as the reason step 4 is not flipped), and the ubuntu and darwin rows run all nine for
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

// The four call sites in .github/actions/build-leg/action.yml that are DELIBERATELY not
// flipped yet, each with the reason, keyed by the step that contains them (a line number
// would rot on the next edit). This table is the whole point: it shrinks, and it cannot
// go stale in either direction — an entry with no matching site is a phantom and fails,
// and a site with no entry is an unexplained node and fails. The sequencing is
// .superpowers/sdd/node-removal-bootstrap-design.md §3, steps 3-6.
// Wave 1 flipped three sites and deleted their three entries from here, one commit each;
// what is left is what is still true, never a description of intent.
const NOT_YET_FLIPPED = {
  'Construct the patched tjs tree from pins (host, native speed)':
    'step 6: --source-only is blocked on esbuild plus txiki\'s own JS dependency tree, '
    + 'which scripts/bundle-inputs-gate.cjs refuses loudly today. Independent of the '
    + 'bootstrap; flipping it would just move the refusal.',
  'Build + blobulate + smoke (inside the guest VM)':
    'step 5: a VM guest, reached only by the workspace rsync, and flipping it removes no '
    + 'node by itself (the same script still runs exec-probe.mjs, stage0.mjs and '
    + 'stage-provider.mjs under node). Sequence it with those three.',
};

// A site can be flipped for SOME of the machines it runs on. `Build tjs (native)` is one
// step for ubuntu, macOS and Windows, and the flip is proven on POSIX and unproven on
// win32 — so it runs the wrapper on POSIX and stays on node for Windows. That is a THIRD
// state, and neither table above could express it: left in NOT_YET_FLIPPED a real flip
// would read as no flip at all, and deleted from it the surviving `node
// scripts/build-tjs.cjs` would read as an unexplained node.
//
// The entry costs what it should: the step must contain BOTH spellings. Delete the
// wrapper half and the split is a fiction, which is how a half-flip silently becomes an
// un-flip; delete the node half and the step is fully flipped and the entry is a phantom.
const SPLIT_BY_PLATFORM = {
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

// Which step each `node scripts/build-tjs.cjs` lives in — derived by walking back to the
// nearest `- name:`, never hand-listed.
function rawNodeSites(yaml) {
  const out = [];
  let step = '(before any step)';
  for (const line of yaml.split('\n')) {
    const m = /^\s*-\s+name:\s*(.+?)\s*$/.exec(line);
    if (m) step = m[1];
    if (/(^|\s)node\s+scripts\/build-tjs\.cjs/.test(line)) out.push(step);
  }
  return out;
}

// The same walk for the wrapper's call sites: which step each one lives in.
function bootSiteSteps(yaml) {
  const out = [];
  let step = '(before any step)';
  for (const line of yaml.split('\n')) {
    const m = /^\s*-\s+name:\s*(.+?)\s*$/.exec(line);
    if (m) step = m[1];
    const t = line.trim().replace(/^run:\s+/, '');
    if (t.includes('build-tjs-boot.sh') && !t.startsWith('#')) out.push(step);
  }
  return out;
}

// Call sites only, and the COMMAND only. A YAML comment that names the wrapper is prose
// about it, not an invocation of it, and demanding the idiom's shape of prose would make
// the rule unwritable-about; a one-line `run:` step carries the YAML key on the same line
// as the command. Both narrowings were found by the rule firing on a real flip, and
// neither loosens what is pinned: the command text itself still has to be identical
// modulo the site label and the mode flag.
function bootSites(yaml) {
  return yaml.split('\n').map((l) => l.trim().replace(/^run:\s+/, ''))
    .filter((l) => l.includes('build-tjs-boot.sh') && !l.startsWith('#'));
}

const BASHISMS = [
  [/^\s*\[\[/m, '[[ ]] test'], [/^\s*local\s/m, '`local`'], [/^\s*declare\s/m, '`declare`'],
  [/^\s*function\s+[A-Za-z_]/m, '`function` keyword'],
  [/\$\{[A-Za-z_][A-Za-z0-9_]*\[/, 'array subscript'],
];

// ONE idiom, three times: `scripts/build-tjs-boot.sh <site> <flag>`. A per-call-site
// invention is how three subtly different spellings end up in one file and only one of
// them is ever tested.
const IDIOM = /^scripts\/build-tjs-boot\.sh [a-z0-9][a-z0-9-]* --[a-z-]+only$/;

const GUARD = defineGuard({
  name: 'build-tjs-invocation-shape',
  floor: 10,
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
      `these build-tjs-boot.sh call sites do not use the one idiom: ${bad.join(' / ')}`);

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

    const raw = rawNodeSites(i.yaml);
    const booted = bootSiteSteps(i.yaml);
    const unexplained = raw.filter((s) => !(s in NOT_YET_FLIPPED) && !(s in SPLIT_BY_PLATFORM));
    rule(unexplained.length === 0,
      `these steps still run build-tjs.cjs under node with no recorded reason: `
      + `${unexplained.join(' / ')}. Either flip them onto scripts/build-tjs-boot.sh or `
      + 'record why not.');

    const fiction = Object.keys(SPLIT_BY_PLATFORM).filter((s) => !booted.includes(s));
    rule(fiction.length === 0,
      `these steps claim a per-platform SPLIT but never run the wrapper: `
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
      `NOT_YET_FLIPPED names steps that no longer run build-tjs.cjs under node: `
      + `${phantom.join(' / ')}. A carve-out that outlives its reason is how an exception `
      + 'list rots; delete the entry when you flip the site.');
    return { findings: f, examined };
  },
  // Every rule violated at once, so a scan that has gone blind on any of them shows up as
  // a shortfall rather than a pass.
  control: () => ({
    sh: '#!/bin/bash\nif [[ -n "$x" ]]; then :; fi\necho no-verdict-here\n',
    executable: false,
    yaml: '    - name: A brand new step\n      run: node scripts/build-tjs.cjs --build-only\n'
      + '    - name: Sloppy\n      run: bash scripts/build-tjs-boot.sh --build-only\n'
      + '        packages: build-base cmake nodejs\n'
      + '        path: ${{ github.workspace }}/.matrix/bootstrap-cache/${{ steps.bootstrap-tag.outputs.tag }}/${{ steps.name.outputs.target }}\n',
    buildTjs: "spawnSync('scripts/build-tjs-boot.sh');\n",
  }),
});

guardTests(GUARD);
