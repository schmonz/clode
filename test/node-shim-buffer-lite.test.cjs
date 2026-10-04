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

// Every encoding node names, each in the spellings node accepts (Task 8 Step 0; ruling G19, from Task 7's
// re-review): buffer-lite read ascii, ucs2/utf16le and base64url as utf8 (and base64url's url-safe
// alphabet as nothing), so toString, from and byteLength all answered differently from node (230 of these
// 462 answers before). Strings are built from code points (the \u tool hazard).
test('buffer-lite answers every node encoding as node does: toString, from and byteLength', () => {
  const encs = ['utf8', 'utf-8', 'UTF8', 'ascii', 'ASCII', 'latin1', 'binary', 'ucs2', 'ucs-2', 'utf16le', 'utf-16le', 'UTF16LE',
    'base64', 'base64url', 'hex'];
  const bufs = [[], [0x41], [0x41, 0x42, 0x43], [0xe9, 0x80, 0xff, 0x00, 0x7f], [0x3d, 0xd8, 0x00, 0xde, 0x41], [0xfb, 0xff, 0xbe, 0x01],
    [0xc3, 0xa9, 0x62, 0x0a], Array.from({ length: 300 }, (_, i) => (i * 37) & 0xff)];
  const cp = (...c) => String.fromCodePoint(...c);
  const strs = ['', 'A', `h${cp(0xe9)}llo`, `${cp(0x1f600)}x`, 'a-b_c', '+/+/', 'aGk', 'aGk=', 'aG k=\n', 'QUJD', 'zz12', '12z4', '123',
    String.fromCharCode(0xd800), '12345', 'a b\nc', `${cp(0x4e2d)}${cp(0x6587)}`];
  const diffs = [];
  for (const e of encs) {
    for (const b of bufs) {
      const n = Buffer.from(b).toString(e), l = Lite.from(b).toString(e);
      if (n !== l) diffs.push(`toString ${e} ${JSON.stringify(b.slice(0, 8))}: node ${JSON.stringify(n.slice(0, 40))}, lite ${JSON.stringify(l.slice(0, 40))}`);
    }
    for (const s of strs) {
      const n = [...Buffer.from(s, e)].join(), l = [...Lite.from(s, e)].join();
      if (n !== l) diffs.push(`from ${JSON.stringify(s)} ${e}: node [${n}], lite [${l}]`);
      if (Buffer.byteLength(s, e) !== Lite.byteLength(s, e)) diffs.push(`byteLength ${JSON.stringify(s)} ${e}: node ${Buffer.byteLength(s, e)}, lite ${Lite.byteLength(s, e)}`);
    }
  }
  for (const v of [Lite.from([1, 2, 3]), new Uint8Array(5), new ArrayBuffer(7)]) {
    if (Lite.byteLength(v) !== Buffer.byteLength(v)) diffs.push(`byteLength of a ${v.constructor.name}: node ${Buffer.byteLength(v)}, lite ${Lite.byteLength(v)}`);
  }
  assert.deepStrictEqual(diffs, []);
});
