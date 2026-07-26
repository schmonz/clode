'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { _rewriteRgSpawn } = require('../libexec/bun-shim.cjs');

function withStubUgrep(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-spawn-'));
  const ugrep = path.join(dir, 'ugrep');
  fs.writeFileSync(ugrep, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const prev = process.env.CLODE_UGREP; process.env.CLODE_UGREP = ugrep;
  try { return fn(ugrep); } finally {
    if (prev === undefined) delete process.env.CLODE_UGREP; else process.env.CLODE_UGREP = prev;
  }
}

test('_rewriteRgSpawn: bare rg → ugrep with translated argv', () => {
  withStubUgrep((ugrep) => {
    assert.deepStrictEqual(_rewriteRgSpawn(['rg', '-n', 'foo']),
      [ugrep, '-r', '--ignore-files', '-I', '-n', 'foo']);
  });
});

test('_rewriteRgSpawn: leaves non-rg commands untouched', () => {
  withStubUgrep(() => {
    assert.deepStrictEqual(_rewriteRgSpawn(['grep', '-n', 'foo']), ['grep', '-n', 'foo']);
  });
});

test('_rewriteRgSpawn: ugrep absent → cmd untouched (app keeps its fallback)', () => {
  const prev = process.env.CLODE_UGREP; delete process.env.CLODE_UGREP;
  const prevPath = process.env.PATH; process.env.PATH = '/nonexistent';
  try {
    assert.deepStrictEqual(_rewriteRgSpawn(['rg', 'foo']), ['rg', 'foo']);
  } finally {
    if (prev !== undefined) process.env.CLODE_UGREP = prev; process.env.PATH = prevPath;
  }
});

const bun = require('../libexec/bun-shim.cjs');

// These two drive the REAL spawn path against an executable ugrep stub — a
// `#!/bin/sh` script, which Windows cannot exec (no shebang, no chmod bit), so
// the stub never returns exit 2 and nothing surfaces. The surfacing logic itself
// is OS-agnostic; only this harness (a shell-script stub) is POSIX-only. The
// unit translator tests above/below run everywhere.
const posixExec = { skip: process.platform === 'win32' ? 'needs an executable /bin/sh ugrep stub' : false };

test('rg spawn.sync: ugrep usage error (exit >=2) surfaces a clode diagnostic + /doctor', posixExec, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-skew-'));
  const ugrep = path.join(dir, 'ugrep');
  fs.writeFileSync(ugrep, '#!/bin/sh\necho "ugrep: unknown option" >&2\nexit 2\n', { mode: 0o755 });
  const prev = process.env.CLODE_UGREP; process.env.CLODE_UGREP = ugrep;
  const origErr = process.stderr.write; let buf = '';
  process.stderr.write = (s) => { buf += s; return true; };
  try {
    bun.spawnSync(['rg', '--surface-unique-xyz', 'foo']);
  } finally {
    process.stderr.write = origErr;
    if (prev === undefined) delete process.env.CLODE_UGREP; else process.env.CLODE_UGREP = prev;
  }
  assert.match(buf, /rg.*ugrep/i);
  assert.ok(globalThis.__clodeDoctor && Array.isArray(globalThis.__clodeDoctor.appletSkew));
  assert.ok(globalThis.__clodeDoctor.appletSkew.some((f) => f.name === 'rg'));
});

test('rg spawn.sync: ugrep exit 1 (no match) does NOT surface', posixExec, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-nomatch-'));
  const ugrep = path.join(dir, 'ugrep');
  fs.writeFileSync(ugrep, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const prev = process.env.CLODE_UGREP; process.env.CLODE_UGREP = ugrep;
  const origErr = process.stderr.write; let buf = '';
  process.stderr.write = (s) => { buf += s; return true; };
  try { bun.spawnSync(['rg', '--nomatch-unique-xyz', 'foo']); }
  finally {
    process.stderr.write = origErr;
    if (prev === undefined) delete process.env.CLODE_UGREP; else process.env.CLODE_UGREP = prev;
  }
  assert.doesNotMatch(buf, /surface/);
});

test('_rewriteRgSpawn: CLODE_RG_DEBUG logs the rewrite; unset is silent', () => {
  withStubUgrep(() => {
    const origErr = process.stderr.write; let buf = '';
    process.stderr.write = (s) => { buf += s; return true; };
    const prev = process.env.CLODE_RG_DEBUG;
    try {
      delete process.env.CLODE_RG_DEBUG;
      _rewriteRgSpawn(['rg', 'foo']);
      assert.doesNotMatch(buf, /rg-debug/);
      process.env.CLODE_RG_DEBUG = '1';
      _rewriteRgSpawn(['rg', 'bar']);
      assert.match(buf, /rg-debug:/);
    } finally {
      process.stderr.write = origErr;
      if (prev === undefined) delete process.env.CLODE_RG_DEBUG; else process.env.CLODE_RG_DEBUG = prev;
    }
  });
});
