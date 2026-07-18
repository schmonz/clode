'use strict';
// `clode build --naude` WIRING (Task 4). The naude SEA build itself
// (esbuild/postject/postject inject) only runs on a Node >= 24 host, so this
// suite does NOT build a real naude. It proves the WIRING: that --naude
//   1. resolves + extracts the user's Claude Code cli.cjs via the SAME
//      resolve/extract machinery the quaude build uses (landing cli.cjs at
//      <cache>/<key>/cli.cjs), then
//   2. invokes scripts/build-naude.mjs with that cli.cjs passed via --cli, and
//   3. does NOT run the quaude fuse (the fuse worker / quaude-fuse.js path).
//
// Both are exercised via clodeBuild's injectable subprocess seam (opts.run):
// clode-fuse's module-level async `run` is the ONE spawn seam every build step
// goes through (the fuse worker AND build-naude), so overriding it lets us
// capture every command clodeBuild tries to launch without spawning anything.
// The resolve/extract path is REAL: we point CLODE_CLAUDE_BIN at a fake provider
// and pre-seed the extract cache (cli.cjs + bun-shim.cjs + matching
// .extractor-sig) so extractIfNeeded takes its cache-HIT branch — no real
// extraction, but the genuine resolve -> cacheKey -> stageDir -> extract flow.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const LIBEXEC = path.join(REPO, 'libexec');
const { clodeBuild } = require('../libexec/clode-fuse.cjs');
const { cacheKey, sigOf } = require('../libexec/clode-resolve.cjs');

// Stand up a fake provider bin + a pre-seeded extract cache so the real
// resolve/extract path is a cache HIT (no extraction). Returns { env, cliPath }.
function seedProvider(dir) {
  const provider = path.join(dir, 'claude'); // a plain file: not an exec wrapper, passes followWrapper through
  fs.writeFileSync(provider, 'BOGUS PROVIDER BYTES (not really a bundle)\n');
  const cache = path.join(dir, 'cache');
  const key = cacheKey(provider);            // basename-<sig> (no /versions/ marker)
  const stageDir = path.join(cache, key);
  fs.mkdirSync(stageDir, { recursive: true });
  const cliPath = path.join(stageDir, 'cli.cjs');
  fs.writeFileSync(cliPath, '// extracted cli.cjs stub\n');
  // extractIfNeeded's cache-hit trio: cli.cjs + bun-shim.cjs + a matching sig.
  // The sig is sigOf() (size+mtime), NOT a sha256 — mirror extractIfNeeded.
  fs.copyFileSync(path.join(LIBEXEC, 'bun-shim.cjs'), path.join(stageDir, 'bun-shim.cjs'));
  fs.writeFileSync(path.join(stageDir, '.extractor-sig'),
    sigOf(path.join(LIBEXEC, 'extract-claude-js.cjs')));
  const env = {
    ...process.env,
    CLODE_CLAUDE_BIN: provider,
    CLODE_CACHE: cache,
    DYLD_INSERT_LIBRARIES: '',
  };
  return { env, cliPath, stageDir };
}

// A stand-in for the SMOKE spawn (`<bin> -p 'say PONG'`, clode-fuse's
// smokeTarget): `clode build --naude` now runs the same NODE_PATH-stripped
// PONG-against-the-mock proof the quaude path always ran (duplication audit
// §2), so a stub that merely returns status 0 no longer satisfies the build —
// and rightly so: that was exactly the hole (`--version` with ambient env
// proved almost nothing). This stub behaves like a WORKING target instead: it
// POSTs the mock's /messages (so the assert-the-POST-landed check sees real
// traffic) and prints PONG. Nothing about the smoke is weakened — the honest
// end-to-end version runs against a REAL naude in test/naude-smoke.test.cjs.
function fakeSmokeTarget(opts) {
  const base = (opts.env || {}).ANTHROPIC_BASE_URL;
  if (!base) return Promise.resolve({ status: 1, stdout: '', stderr: 'no ANTHROPIC_BASE_URL' });
  return new Promise((resolve) => {
    const req = require('node:http').request(`${base}/v1/messages`, { method: 'POST' }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: 0, stdout: 'PONG\n', stderr: '' }));
    });
    req.on('error', (e) => resolve({ status: 1, stdout: '', stderr: String(e) }));
    req.end('{}');
  });
}

// The pinned Node the naude branch now ALWAYS ensures (clode carries no Node;
// naude embeds a sha-verified pinned Node fetched into a versioned store). The
// wiring tests inject this via opts.ensureNode so they never touch the network:
// the naude build spawns UNDER this path and passes it down as --node.
const FAKE_NODE = path.join('/pinned', 'node', 'bin', 'node');

// Drive clodeBuild with the spawn seam captured. `runResult` is what the
// injected run() resolves to for every NON-smoke spawn (default success + no
// output); smoke spawns (`-p`) are answered by fakeSmokeTarget above.
// `ensureNode` is the injected pinned-node seam (default: resolves FAKE_NODE);
// pass a thrower to exercise the "pinned node unavailable" refusal.
async function runBuild(args, env, runResult = { status: 0, stdout: '', stderr: '' },
  ensureNode = async () => FAKE_NODE) {
  const calls = [];
  const run = (cmd, cmdArgs, opts) => {
    calls.push({ cmd, args: cmdArgs, opts });
    if (Array.isArray(cmdArgs) && cmdArgs[0] === '-p') return fakeSmokeTarget(opts);
    return Promise.resolve(runResult);
  };
  const stderrBuf = []; const stdoutBuf = [];
  const status = await clodeBuild(args, {
    here: REPO,
    version: 'clode-test',
    libexec: LIBEXEC,
    env,
    run,
    ensureNode,
    stderr: { write: (s) => stderrBuf.push(s) },
    stdout: { write: (s) => stdoutBuf.push(s) },
  });
  return { status, calls, stderr: stderrBuf.join(''), stdout: stdoutBuf.join('') };
}

test('clode build --naude: extracts cli.cjs and invokes build-naude.mjs with it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-naude-wire-'));
  try {
    const { env, cliPath } = seedProvider(dir);
    const r = await runBuild(['--naude'], env);

    // Exactly the build-naude invocation ran through the spawn seam.
    const naude = r.calls.find((c) => Array.isArray(c.args)
      && c.args.some((a) => typeof a === 'string' && a.endsWith(path.join('scripts', 'build-naude.mjs'))));
    assert.ok(naude, `build-naude.mjs was not invoked; calls:\n${JSON.stringify(r.calls, null, 2)}`);

    // It runs UNDER the pinned node (not process.execPath — clode carries no
    // Node; naude embeds the fetched pinned Node), passes that same node as
    // --node, and passes the extracted cli.cjs via --cli.
    assert.strictEqual(naude.cmd, FAKE_NODE, 'build-naude must run under the pinned node');
    const nodeIdx = naude.args.indexOf('--node');
    assert.ok(nodeIdx >= 0 && naude.args[nodeIdx + 1] === FAKE_NODE,
      `--node must be the pinned node; args: ${JSON.stringify(naude.args)}`);
    const cliIdx = naude.args.indexOf('--cli');
    assert.ok(cliIdx >= 0, `--cli not passed to build-naude; args: ${JSON.stringify(naude.args)}`);
    assert.strictEqual(naude.args[cliIdx + 1], cliPath,
      'the --cli value must be the cli.cjs the SAME extract path produced');
    assert.ok(fs.existsSync(cliPath), 'extracted cli.cjs should exist on disk');

    // The assembler inputs are passed explicitly (Task 5/6): the prebuilt
    // bundle, a resolved node_modules, the postject dir, and the builder path.
    for (const flag of ['--bundle', '--nmdir', '--postject', '--builder']) {
      assert.ok(naude.args.includes(flag), `${flag} not passed to build-naude; args: ${JSON.stringify(naude.args)}`);
    }

    assert.strictEqual(r.status, 0, `stderr:\n${r.stderr}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('clode build --naude: does NOT run the quaude fuse', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-naude-nofuse-'));
  try {
    const { env } = seedProvider(dir);
    const r = await runBuild(['--naude'], env);

    const fuse = r.calls.find((c) => Array.isArray(c.args)
      && c.args.some((a) => typeof a === 'string' && /quaude-fuse\.js/.test(a)));
    assert.ok(!fuse, `the quaude fuse worker must NOT run under --naude; calls:\n${JSON.stringify(r.calls, null, 2)}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('clode build (no --naude): never invokes build-naude.mjs (regression guard)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-naude-default-'));
  try {
    const { env } = seedProvider(dir);
    // Point CLODE_TJS at the fake provider file so the template existence gate
    // passes without a real tjs; downstream spawns go through the captured seam.
    // (On darwin the fake-Mach-O codesign step may fail before the fuse spawn —
    // that's fine: this guard only asserts the naude branch stays untaken.)
    env.CLODE_TJS = env.CLODE_CLAUDE_BIN;
    const r = await runBuild(['--out', path.join(dir, 'quaude')], env);

    const naude = r.calls.find((c) => Array.isArray(c.args)
      && c.args.some((a) => typeof a === 'string' && a.endsWith(path.join('scripts', 'build-naude.mjs'))));
    assert.ok(!naude, `default build must NOT invoke build-naude.mjs; calls:\n${JSON.stringify(r.calls, null, 2)}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// Bug 1: --naude used to short-circuit BEFORE the shared argv validation loop,
// so an unknown flag after --naude was silently ignored instead of failing
// loud like the quaude path does. Argv is now parsed ONCE, before either
// branch, so both get the same unknown-arg contract. No provider/env setup
// needed — an unknown arg must fail before any resolve/extract work happens.
test('clode build --naude --bogus: unknown argument fails loud (no spawn, no resolve)', async () => {
  const r = await runBuild(['--naude', '--bogus'], { ...process.env, DYLD_INSERT_LIBRARIES: '' });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /unknown argument '--bogus'/);
  assert.strictEqual(r.calls.length, 0, `no subprocess should have been spawned; calls:\n${JSON.stringify(r.calls, null, 2)}`);
});

// --naude and --self are different build TARGETS (Node SEA vs the native
// clode builder) — silently picking one for the user (the old behavior:
// --naude won, --self was dropped) is exactly the kind of silent-wrong-output
// this task flags. Must fail loud instead.
test('clode build --naude --self: different targets, fails loud (does not silently pick one)', async () => {
  const r = await runBuild(['--naude', '--self'], { ...process.env, DYLD_INSERT_LIBRARIES: '' });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /--naude/);
  assert.match(r.stderr, /--self/);
  assert.strictEqual(r.calls.length, 0, `no subprocess should have been spawned; calls:\n${JSON.stringify(r.calls, null, 2)}`);
});

// Bug 1 continued: --naude --out used to be silently swallowed by
// build-naude.mjs's parseCliArg (which only reads --cli) — the build would
// exit 0, print success, and write to build/<tag>/naude instead of the path
// the user asked for. --out must now actually be forwarded.
test('clode build --naude --out PATH: forwards --out to build-naude.mjs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-naude-out-'));
  try {
    const { env } = seedProvider(dir);
    const wantOut = path.join(dir, 'somewhere', 'naude-out');
    const r = await runBuild(['--naude', '--out', wantOut], env);

    const naude = r.calls.find((c) => Array.isArray(c.args)
      && c.args.some((a) => typeof a === 'string' && a.endsWith(path.join('scripts', 'build-naude.mjs'))));
    assert.ok(naude, `build-naude.mjs was not invoked; calls:\n${JSON.stringify(r.calls, null, 2)}`);
    const outIdx = naude.args.indexOf('--out');
    assert.ok(outIdx >= 0, `--out not forwarded to build-naude; args: ${JSON.stringify(naude.args)}`);
    assert.strictEqual(naude.args[outIdx + 1], wantOut);

    assert.strictEqual(r.status, 0, `stderr:\n${r.stderr}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// Duplication audit §2: `clode build --naude` used to run NO smoke of its own
// — it only checked build-naude.mjs's exit status. So it printed success for a
// naude that could not reach the API, could not resolve a dep `--version`
// never touches, or that only worked because the build machine's ambient
// NODE_PATH leaked in. (build-naude.mjs's own self-check was
// `spawnSync(bin, ['--version'])` with `{...process.env}` INHERITED, grepping
// stderr for /Cannot find module/.) The equivalent quaude bug was impossible.
// Both paths now go through the SAME shared smokeTarget.
test('clode build --naude: runs the shared PONG smoke on the binary it just built', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-naude-smoke-'));
  try {
    const { env } = seedProvider(dir);
    const wantOut = path.join(dir, 'naude-out');
    const r = await runBuild(['--naude', '--out', wantOut], env);
    assert.strictEqual(r.status, 0, `stderr:\n${r.stderr}`);

    const smoke = r.calls.find((c) => Array.isArray(c.args) && c.args[0] === '-p');
    assert.ok(smoke, `no smoke spawn; calls:\n${JSON.stringify(r.calls.map((c) => c.args), null, 2)}`);
    // It smokes the binary that was just BUILT, not some other path.
    assert.strictEqual(smoke.cmd, wantOut);
    assert.deepStrictEqual(smoke.args, ['-p', 'say PONG']);
    // Pointed at the canned in-process mock, with a dummy key — never the real API.
    assert.match(smoke.opts.env.ANTHROPIC_BASE_URL, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.ok(smoke.opts.env.ANTHROPIC_API_KEY, 'the smoke needs a (dummy) key set');
    // And it says PONG round-trip, not just "built".
    assert.match(r.stdout, /PONG round-trip ok/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// The self-containment proof, and the whole reason the old --version check was
// worthless: with the build host's NODE_PATH inherited, a naude missing a dep
// from its own payload can still resolve it from the ambient env and look fine.
test('clode build --naude: the smoke strips NODE_PATH (self-containment proof)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-naude-nodepath-'));
  try {
    const { env } = seedProvider(dir);
    env.NODE_PATH = '/some/ambient/node_modules';   // the build host's leak
    const r = await runBuild(['--naude', '--out', path.join(dir, 'naude-out')], env);
    assert.strictEqual(r.status, 0, `stderr:\n${r.stderr}`);

    const smoke = r.calls.find((c) => Array.isArray(c.args) && c.args[0] === '-p');
    assert.ok(smoke, 'no smoke spawn');
    assert.ok(!('NODE_PATH' in smoke.opts.env),
      `NODE_PATH leaked into the naude smoke — a pass would no longer prove self-containment; env had: ${smoke.opts.env.NODE_PATH}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// The failure the old wiring could not produce: a built naude that boots but
// never completes the round-trip must FAIL the build, not print success.
test('clode build --naude: a naude that never POSTs fails the build loudly', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-naude-nopost-'));
  try {
    const { env } = seedProvider(dir);
    const calls = [];
    // Every spawn "succeeds" with no output — exactly what the OLD --naude
    // branch accepted as proof (it checked only the child's exit status).
    const run = (cmd, cmdArgs, opts) => {
      calls.push({ cmd, args: cmdArgs, opts });
      return Promise.resolve({ status: 0, stdout: '', stderr: '' });
    };
    const stderrBuf = []; const stdoutBuf = [];
    const status = await clodeBuild(['--naude', '--out', path.join(dir, 'naude-out')], {
      here: REPO, version: 'clode-test', libexec: LIBEXEC, env, run,
      // Inject the pinned-node seam — WITHOUT it the naude branch calls the real
      // ensurePinnedNode, which fetches Node from the network into the default
      // store: a hidden network hit + a hermeticity violation (it writes
      // ~/.local/share/clode/nodes). This test is about the smoke, not the node.
      ensureNode: async () => FAKE_NODE,
      stderr: { write: (s) => stderrBuf.push(s) },
      stdout: { write: (s) => stdoutBuf.push(s) },
    });
    assert.strictEqual(status, 1, 'a naude that never POSTed must fail the build');
    assert.match(stderrBuf.join(''), /SMOKE FAILED/);
    assert.match(stderrBuf.join(''), /posted=false/);
    assert.doesNotMatch(stdoutBuf.join(''), /built naude/, 'must not claim success');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// The old fused-builder refusal ("naude requires a Node >= 24 host") is GONE:
// clode carries no Node, and the naude branch now FETCHES a sha-verified pinned
// Node into a versioned store (Task 1). The only remaining refusal is "the
// pinned node could not be obtained" — first build, offline — and it must name
// the fix (`clode fetch --naude` with network), not spawn anything.
test('clode build --naude: pinned node unavailable fails loud, names `clode fetch --naude`', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-naude-nonode-'));
  try {
    const { env } = seedProvider(dir);
    const boom = async () => { throw new Error('offline: getaddrinfo ENOTFOUND nodejs.org'); };
    const r = await runBuild(['--naude'], env, undefined, boom);
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /pinned node/i);
    assert.match(r.stderr, /clode fetch --naude/, 'should name the fetch fix');
    const naude = r.calls.find((c) => Array.isArray(c.args)
      && c.args.some((a) => typeof a === 'string' && a.endsWith(path.join('scripts', 'build-naude.mjs'))));
    assert.ok(!naude, `no build-naude should have been spawned; calls:\n${JSON.stringify(r.calls, null, 2)}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// The FUSED-builder naude path (native clode under tjs, no checkout on disk:
// materialize the carried assembler + bundle + postject + ext-deps, then spawn
// build-naude UNDER the fetched pinned node with node ABSENT from PATH) is
// proven end-to-end, for real, in test/clode-native.test.cjs "acceptance 4".
// It is NOT re-proven here as a unit test on purpose: the fused branch stages
// the provider through the MATERIALIZED libexec, whose extractor cache key is
// size+mtime of a freshly-written file — un-seedable from a unit test without
// reproducing the exact flake this suite exists to avoid. The wiring decisions
// (runs under the pinned node, passes --node/--bundle/--nmdir/--postject/
// --builder, no old refusal) are covered by the non-fused cases above; the
// fused materialization is covered by the acceptance.
