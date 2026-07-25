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
