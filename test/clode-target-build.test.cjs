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
