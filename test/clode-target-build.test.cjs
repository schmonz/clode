'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fuse = require('../libexec/clode-fuse.cjs');

function manifestFile() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tpl-'));
  const f = path.join(d, 'templates.json');
  fs.writeFileSync(f, JSON.stringify({
    schema: 1, tjsPin: '26.6.0-1a230d3',
    targets: {
      'linux-x64':    { tag: 'linux-glibc2.28-x64', engine: 'e1', sha256: 'a'.repeat(64), verified: 'smoke' },
      'netbsd-sparc': { tag: 'netbsd-10.1-sparc',    engine: 'e2', sha256: 'b'.repeat(64), verified: 'attest-only' },
    },
  }));
  return f;
}

function sink() { let s = ''; return { write: (x) => { s += x; return true; }, text: () => s }; }

test('clode build --list-targets prints the available targets', async () => {
  const out = sink(), err = sink();
  const status = await fuse.clodeBuild(['--list-targets'], {
    env: { CLODE_TEMPLATES_MANIFEST: manifestFile() },
    here: '/x', libexec: '/x', version: '0', stdout: out, stderr: err,
  });
  assert.strictEqual(status, 0, err.text());
  assert.match(out.text(), /linux-x64/);
  assert.match(out.text(), /netbsd-sparc/);
  assert.match(out.text(), /netbsd-10\.1-sparc/); // the tag renders (the build-verify annotation was intentionally dropped, 6122700)
});

test('clode build --list-targets without a manifest fails loud', async () => {
  const err = sink();
  const status = await fuse.clodeBuild(['--list-targets'], {
    env: {}, here: '/x', libexec: '/x', version: '0', stdout: sink(), stderr: err,
  });
  assert.strictEqual(status, 1);
  assert.match(err.text(), /manifest/i);
});

const crypto = require('node:crypto');
const REPO = path.resolve(__dirname, '..');
const LIBEXEC = path.join(REPO, 'libexec');

test('clode build --target <unknown> fails loud, names --list-targets', async () => {
  const err = sink();
  const status = await fuse.clodeBuild(['--target', 'no-such-plat'], {
    env: { CLODE_TEMPLATES_MANIFEST: manifestFile() },
    here: REPO, libexec: LIBEXEC, version: '0', stdout: sink(), stderr: err,
  });
  assert.strictEqual(status, 1);
  assert.match(err.text(), /unknown target 'no-such-plat'/);
  assert.match(err.text(), /--list-targets/);
});

test('clode build --target: resolves + obtains the engine, sets CLODE_TARGET_TEMPLATE', async () => {
  // Use a fake engine payload; pin matches PINS.md's derived pin (dev checkout).
  const engineBytes = Buffer.from('FAKE-ENGINE-FOR-Y');
  const sha = crypto.createHash('sha256').update(engineBytes).digest('hex');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tgt-'));
  const mf = path.join(d, 'm.json');
  fs.writeFileSync(mf, JSON.stringify({
    schema: 1, tjsPin: '26.6.0-1a230d3',   // matches spike/quickjs/PINS.md → thisTjsPin derives the same
    targets: { 'linux-x64': { tag: 'linux-glibc2.28-x64', engine: 'tjs-linux-x64-abc', sha256: sha, verified: 'smoke' } },
  }));
  const cacheDir = path.join(d, 'cache');
  // CLODE_STATE_ROOT: without it, clodeBuild's finally (Task 5's one
  // build-trace.jsonl line per build) resolves clodeDataDir off HOME/XDG —
  // and since this `env` has no HOME either, that falls all the way to
  // os.homedir(), the REAL one. This build fails downstream, but it still
  // reaches that finally, so without this override the test would silently
  // write into the real, shared ~/.local/share/clode.
  const env = { CLODE_TEMPLATES_MANIFEST: mf, CLODE_STATE_ROOT: d };
  // Injected fetch returns the fake engine; no payload/provider in this env, so the
  // build fails downstream — but the engine must be OBTAINED and the template SET first.
  await fuse.clodeBuild(['--target', 'linux-x64', '--out', path.join(d, 'q')], {
    env, here: REPO, libexec: LIBEXEC, version: '0', stdout: sink(), stderr: sink(),
    templateCacheDir: cacheDir, fetchEngine: async () => engineBytes,
  });
  const cached = path.join(cacheDir, 'tjs-linux-x64-abc');
  assert.ok(fs.existsSync(cached), 'engine was obtained + cached');
  assert.strictEqual(fs.readFileSync(cached).toString(), 'FAKE-ENGINE-FOR-Y');
  assert.strictEqual(env.CLODE_TARGET_TEMPLATE, cached, 'cross-fuse template set to the obtained engine');
});

test('parseBuildArgs: --naude --target composes (cross-build a naude)', () => {
  const r = fuse.parseBuildArgs(['--naude', '--target', 'linux-arm64']);
  assert.deepStrictEqual({ naude: r.naude, target: r.target, error: r.error },
    { naude: true, target: 'linux-arm64', error: undefined });
});

test('parseBuildArgs: --self stays exclusive with --naude and --target', () => {
  assert.match(fuse.parseBuildArgs(['--self', '--naude']).error, /different build targets/);
  assert.match(fuse.parseBuildArgs(['--self', '--target', 'linux-arm64']).error, /different build targets/);
});

test('parseBuildArgs: singletons unchanged', () => {
  assert.strictEqual(fuse.parseBuildArgs(['--naude']).error, undefined);
  assert.strictEqual(fuse.parseBuildArgs(['--target', 'linux-arm64']).error, undefined);
  assert.strictEqual(fuse.parseBuildArgs(['--self']).error, undefined);
});

// NOTE: the `clode build --naude --target` cross-build wiring test lives in
// test/clode-build-naude.test.cjs, where the hermetic seedProvider harness (a fake
// provider + pre-seeded extract cache) lets the naude branch reach the node-resolve
// step without a real provider on the box. An earlier version here passed `env:{}`
// and only stayed green on dev boxes that happened to have a provider installed —
// it went red on CI (ubuntu/windows) where none exists.
