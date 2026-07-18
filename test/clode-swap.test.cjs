'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { swapInPlace } = require('../libexec/clode-swap.cjs');

test('POSIX: a single rename(temp, target), same dir', () => {
  const calls = [];
  swapInPlace('/d/.t.update-9', '/d/t', { platform: 'linux', rename: (a, b) => calls.push(['rename', a, b]) });
  assert.deepStrictEqual(calls, [['rename', '/d/.t.update-9', '/d/t']]);
});

test('EXDEV guard: cross-dir temp/target throws and renames nothing', () => {
  const calls = [];
  assert.throws(() => swapInPlace('/tmp/t', '/usr/local/bin/t', { platform: 'linux', rename: (a, b) => calls.push([a, b]) }), /same directory|cross/i);
  assert.strictEqual(calls.length, 0);
});

test('Windows: rename target aside, then temp over, then delete .old', () => {
  const calls = [];
  swapInPlace('C:\\d\\.t.update-9', 'C:\\d\\t.exe', {
    platform: 'win32', randToken: '9',
    rename: (a, b) => calls.push(['rename', a, b]),
    rm: (p) => calls.push(['rm', p]),
  });
  assert.deepStrictEqual(calls, [
    ['rename', 'C:\\d\\t.exe', 'C:\\d\\t.exe.old-9'],
    ['rename', 'C:\\d\\.t.update-9', 'C:\\d\\t.exe'],
    ['rm', 'C:\\d\\t.exe.old-9'],
  ]);
});

test('Windows: if the temp->target rename fails, restore the original name (target unchanged)', () => {
  const calls = [];
  let n = 0;
  assert.throws(() => swapInPlace('C:\\d\\.t.update-9', 'C:\\d\\t.exe', {
    platform: 'win32', randToken: '9',
    rename: (a, b) => { calls.push([a, b]); if (++n === 2) throw new Error('EBUSY'); },
    rm: () => {},
  }), /EBUSY/);
  // moved aside, tried to put new one, failed -> restored
  assert.deepStrictEqual(calls, [
    ['C:\\d\\t.exe', 'C:\\d\\t.exe.old-9'],
    ['C:\\d\\.t.update-9', 'C:\\d\\t.exe'],
    ['C:\\d\\t.exe.old-9', 'C:\\d\\t.exe'],
  ]);
});
