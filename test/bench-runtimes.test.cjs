'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { resolveRuntimes, presentRuntimes } = require('../bench/lib/runtimes.cjs');

test('env override wins and marks present', () => {
  const list = resolveRuntimes({
    env: { QUAUDE_BIN: '/x/quaude' },
    buildDir: '/build',
    existsSync: (p) => p === '/x/quaude',
  });
  const q = list.find((r) => r.name === 'quaude');
  assert.strictEqual(q.bin, '/x/quaude');
  assert.strictEqual(q.present, true);
});

test('build-dir fallback probes default artifact name', () => {
  // resolveRuntimes joins buildDir + basename with path.join, so the default is
  // OS-native (\build\quaude on Windows). Compute the expectation the same way
  // rather than hardcoding a POSIX separator.
  const want = path.join('/build', 'quaude');
  const list = resolveRuntimes({
    env: {},
    buildDir: '/build',
    existsSync: (p) => p === want,
  });
  const q = list.find((r) => r.name === 'quaude');
  assert.strictEqual(q.bin, want);
  assert.strictEqual(q.present, true);
});

test('absent runtime is present:false, not dropped', () => {
  const list = resolveRuntimes({ env: {}, buildDir: '/build', existsSync: () => false });
  assert.strictEqual(list.length, 3);
  assert.ok(list.every((r) => r.present === false));
});

test('presentRuntimes filters to present only', () => {
  const list = resolveRuntimes({
    env: { NAUDE_BIN: '/n/naude' },
    buildDir: '/build',
    existsSync: (p) => p === '/n/naude',
  });
  const present = presentRuntimes(list);
  assert.deepStrictEqual(present.map((r) => r.name), ['naude']);
});
