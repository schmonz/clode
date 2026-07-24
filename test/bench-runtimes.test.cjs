'use strict';
const test = require('node:test');
const assert = require('node:assert');
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
  const list = resolveRuntimes({
    env: {},
    buildDir: '/build',
    existsSync: (p) => p === '/build/quaude',
  });
  const q = list.find((r) => r.name === 'quaude');
  assert.strictEqual(q.bin, '/build/quaude');
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
