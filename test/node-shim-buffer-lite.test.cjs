'use strict';
// internal/buffer-lite.cjs, the Buffer node-shim falls back to when the feross `buffer` package is not
// installed, judged against host node's Buffer (Task 7 re-review M2): toString(enc, start, end) ignored
// start and end, so a range of a buffer decoded as the whole of it. Under it quaude's rg's ugrep record
// parser (libexec/rg-native.cjs) read every record's file name as all of ugrep's output: every search
// refused, and Map keys hashed megabytes.
const { test } = require('node:test');
const assert = require('node:assert');
const Lite = require('../libexec/node-shim/internal/buffer-lite.cjs').Buffer;

test('buffer-lite toString(enc, start, end) answers as node does, on a buffer and on a subarray of one', () => {
  const bytes = [0x41, 0xc3, 0xa9, 0x00, 0x7a, 0xe2, 0x82, 0xac, 0x0a, 0xff, 0x62];
  const ranges = [[], [undefined, undefined], [0], [2], [3, 8], [1, 3], [4, 4], [5, 2], [-3, 5], [0, 99], [8, undefined], [undefined, 4]];
  for (const enc of ['utf8', 'latin1', 'hex', 'base64']) {
    for (const off of [0, 2]) {
      const n = Buffer.from([0x99, 0x98, ...bytes]).subarray(2 - off), l = Lite.from([0x99, 0x98, ...bytes]).subarray(2 - off);
      for (const r of ranges) assert.strictEqual(l.toString(enc, ...r), n.toString(enc, ...r), `${enc} offset ${off} range ${JSON.stringify(r)}`);
    }
  }
});

// quaude's rg's record parser, run with buffer-lite as the global Buffer: each record's name is its
// own bytes, from a buffer that is itself a view into a larger one (as ugrep's chunks are).
test('rg-native\'s ugrep record parser answers under buffer-lite', () => {
  const real = globalThis.Buffer;
  const key = require.resolve('../libexec/rg-native.cjs');
  const cached = require.cache[key];
  delete require.cache[key];
  globalThis.Buffer = Lite;
  try {
    const rgn = require('../libexec/rg-native.cjs');
    const whole = Lite.from('JUNK' + 'a.txt\u00000 6\nsub/b.txt\u00003 9\nsub/b.txt\u000012 18\n', 'latin1');
    const got = rgn.parseUgrepRanges(whole.subarray(4));
    assert.deepStrictEqual([...got].map(([k, v]) => [k, v.map((m) => [m.start, m.end])]), [['a.txt', [[0, 6]]], ['sub/b.txt', [[3, 9], [12, 18]]]]);
  } finally {
    globalThis.Buffer = real;
    delete require.cache[key];
    if (cached) require.cache[key] = cached;
  }
});
