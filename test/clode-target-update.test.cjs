'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { targetUpdate } = require('../libexec/clode-target-update.cjs');

// A harness: everything is a seam, nothing touches the real fs/network. The
// "target" is a made-up path in a dir we pretend is writable.
function drive(env, over = {}) {
  const calls = { fetch: [], build: [], swap: [], rm: [] };
  const err = [], out = [];
  const p = targetUpdate('stable', {
    env,
    stderr: { write: (s) => err.push(s) },
    stdout: { write: (s) => out.push(s) },
    existsSync: over.existsSync || (() => true),
    accessSync: over.accessSync || (() => {}),          // writable dir
    rmSync: (p2) => calls.rm.push(p2),
    randToken: '7',
    fetch: over.fetch || (async (c) => { calls.fetch.push(c); return 0; }),
    build: over.build || (async (a) => { calls.build.push(a); return 0; }),
    swap: over.swap || ((t, tg, o) => calls.swap.push([t, tg, o])),
  });
  return { p, calls, err: () => err.join(''), out: () => out.join('') };
}

test('quaude: fetch -> build --out <temp in target dir> -> swap; exit 0', async () => {
  const d = drive({ CLODE_TARGET_KIND: 'quaude', CLODE_TARGET: '/usr/local/bin/quaude' });
  assert.strictEqual(await d.p, 0);
  assert.deepStrictEqual(d.calls.fetch, ['stable']);
  assert.deepStrictEqual(d.calls.build[0], ['--out', '/usr/local/bin/.quaude.update-7']);
  assert.strictEqual(d.calls.swap.length, 1);
  assert.strictEqual(d.calls.swap[0][1], '/usr/local/bin/quaude');
});

test('naude: build carries --naude', async () => {
  const d = drive({ CLODE_TARGET_KIND: 'naude', CLODE_TARGET: '/opt/naude' });
  assert.strictEqual(await d.p, 0);
  assert.deepStrictEqual(d.calls.build[0], ['--naude', '--out', '/opt/.naude.update-7']);
});

test('unknown kind: loud, non-zero, no fetch/build/swap', async () => {
  const d = drive({ CLODE_TARGET: '/x/t' });   // no KIND
  assert.strictEqual(await d.p, 1);
  assert.match(d.err(), /CLODE_TARGET_KIND/);
  assert.strictEqual(d.calls.fetch.length + d.calls.build.length + d.calls.swap.length, 0);
});

test('missing CLODE_TARGET: loud, non-zero, nothing spawned', async () => {
  const d = drive({ CLODE_TARGET_KIND: 'quaude' });
  assert.strictEqual(await d.p, 1);
  assert.match(d.err(), /CLODE_TARGET/);
  assert.strictEqual(d.calls.build.length, 0);
});

test('target no longer exists: loud, non-zero, no fetch/build/swap', async () => {
  const d = drive({ CLODE_TARGET_KIND: 'quaude', CLODE_TARGET: '/usr/local/bin/quaude' },
    { existsSync: () => false });
  assert.strictEqual(await d.p, 1);
  assert.match(d.err(), /no longer exists/);
  assert.strictEqual(d.calls.fetch.length + d.calls.build.length + d.calls.swap.length, 0);
});

test('unwritable target dir: fail BEFORE building', async () => {
  const d = drive({ CLODE_TARGET_KIND: 'quaude', CLODE_TARGET: '/usr/local/bin/quaude' },
    { accessSync: () => { throw new Error('EACCES'); } });
  assert.strictEqual(await d.p, 1);
  assert.match(d.err(), /not writable/i);
  assert.strictEqual(d.calls.build.length, 0, 'must not build when the dir is unwritable');
});

test('fetch returns non-zero status (no throw): loud, non-zero, NO build, NO swap', async () => {
  const d = drive({ CLODE_TARGET_KIND: 'quaude', CLODE_TARGET: '/usr/local/bin/quaude' },
    { fetch: async () => 1 });
  assert.strictEqual(await d.p, 1);
  assert.match(d.err(), /could not fetch/i);
  assert.strictEqual(d.calls.build.length, 0, 'a failed fetch must never build');
  assert.strictEqual(d.calls.swap.length, 0, 'a failed fetch must never swap');
});

test('rebuild fails (status != 0): loud, non-zero, temp removed, NO swap', async () => {
  const d = drive({ CLODE_TARGET_KIND: 'quaude', CLODE_TARGET: '/usr/local/bin/quaude' },
    { build: async () => 1 });
  assert.strictEqual(await d.p, 1);
  assert.strictEqual(d.calls.swap.length, 0, 'a failed build must never swap');
  assert.ok(d.calls.rm.includes('/usr/local/bin/.quaude.update-7'));
});

test('swap fails: loud, non-zero, temp removed (target unchanged is the swap seam\'s job)', async () => {
  const d = drive({ CLODE_TARGET_KIND: 'quaude', CLODE_TARGET: '/usr/local/bin/quaude' },
    { swap: () => { throw new Error('EBUSY'); } });
  assert.strictEqual(await d.p, 1);
  assert.match(d.err(), /swap/i);
  assert.ok(d.calls.rm.includes('/usr/local/bin/.quaude.update-7'));
});
