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
    schema: 1, tjsPin: 'v26.6.0-1a230d3',
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
  assert.match(out.text(), /attest-only/);
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
    schema: 1, tjsPin: 'v26.6.0-1a230d3',   // matches spike/quickjs/PINS.md → thisTjsPin derives the same
    targets: { 'linux-x64': { tag: 'linux-glibc2.28-x64', engine: 'tjs-linux-x64-abc', sha256: sha, verified: 'smoke' } },
  }));
  const cacheDir = path.join(d, 'cache');
  const env = { CLODE_TEMPLATES_MANIFEST: mf };
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
