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

// Drive clodeBuild with the spawn seam captured. `runResult` is what the
// injected run() resolves to for every spawn (default success + no output).
async function runBuild(args, env, runResult = { status: 0, stdout: '', stderr: '' }) {
  const calls = [];
  const run = (cmd, cmdArgs, opts) => { calls.push({ cmd, args: cmdArgs, opts }); return Promise.resolve(runResult); };
  const stderrBuf = []; const stdoutBuf = [];
  const status = await clodeBuild(args, {
    here: REPO,
    version: 'clode-test',
    libexec: LIBEXEC,
    env,
    run,
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

    // It runs under this node, and passes the extracted cli.cjs via --cli.
    assert.strictEqual(naude.cmd, process.execPath);
    const cliIdx = naude.args.indexOf('--cli');
    assert.ok(cliIdx >= 0, `--cli not passed to build-naude; args: ${JSON.stringify(naude.args)}`);
    assert.strictEqual(naude.args[cliIdx + 1], cliPath,
      'the --cli value must be the cli.cjs the SAME extract path produced');
    assert.ok(fs.existsSync(cliPath), 'extracted cli.cjs should exist on disk');

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

// Bug 2: under a FUSED builder (a native clode running under tjs, VFS
// mounted with manifest.role 'builder'), there is no scripts/ dir on disk
// and process.execPath is tjs, not node — spawning build-naude.mjs would
// exec-fail with a mystery exit. Must fail loud and early, naming the real
// alternatives, instead of letting the user hit exec garbage.
test('clode build --naude under a fused builder: fails loud with the Node>=24 / quaude alternative', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-naude-fused-'));
  try {
    const { env } = seedProvider(dir);
    globalThis.__quaudeVFS = { manifest: { role: 'builder' } };
    try {
      const r = await runBuild(['--naude'], env);
      assert.strictEqual(r.status, 1);
      assert.match(r.stderr, /Node\s*>=\s*24/);
      assert.match(r.stderr, /fused builder/);
      assert.match(r.stderr, /clode build/, 'should name the quaude alternative');
      assert.strictEqual(r.calls.length, 0, `no subprocess should have been spawned; calls:\n${JSON.stringify(r.calls, null, 2)}`);
    } finally {
      delete globalThis.__quaudeVFS;
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
