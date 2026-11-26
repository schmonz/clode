'use strict';
// EVERY CONSTRUCTOR NODE LETS AN ES5 SUBCLASS CALL, THE SHIM LETS IT CALL TOO, and the call initializes the caller's
// object. Node defines EventEmitter, the stream classes, http.Agent, StringDecoder and the rest as functions, so npm
// code written before `class` subclasses them as `Base.call(this)`; the shim's ES classes threw "class constructors
// must be invoked with 'new'" there, and on a real Linux box (2026-11-25) that failed every Remote Control session
// create before a byte left the machine. The expected list is host node's own answer, asked at test time over every
// module the shim provides, never a list typed here. See libexec/node-shim/internal/callable.cjs.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');
// the modules the shim provides, as the shim-surface map counts them (one list, not a second directory walk)
const { shimModuleNames } = require('./shim-surface/collect.cjs');

const FIXTURE = path.join(__dirname, 'fixtures', 'callable-constructors.cjs');
const MODULES = shimModuleNames();

// Node constructors the shim does not provide AT ALL: a different gap (an absent API, not a refused call), recorded
// exactly so one appearing or being filled in is noticed. BACKLOG.md: "node constructors the shim lacks".
const ABSENT = [
  'assert.Assert', 'child_process.ChildProcess', 'crypto.Certificate', 'crypto.Cipheriv', 'crypto.Decipheriv',
  'crypto.DiffieHellman', 'crypto.DiffieHellmanGroup', 'crypto.ECDH', 'crypto.Hash', 'crypto.Hmac', 'crypto.Sign',
  'crypto.Verify', 'fs.WriteStream', 'http.OutgoingMessage', 'https.Server', 'module', 'module.Module',
  'sqlite.Session', 'stream.Readable.ReadableState', 'stream.Writable.WritableState', 'url.URLPattern',
  'zlib.BrotliCompress', 'zlib.BrotliDecompress',
];

function nodeCallable() {
  const r = spawnSync(process.execPath, ['--no-deprecation', FIXTURE, 'list', JSON.stringify(MODULES)], { encoding: 'utf8', timeout: 60000 });
  assert.strictEqual(r.status, 0, r.stderr);
  const list = JSON.parse(r.stdout);
  // nested statics (Readable.ReadableState) are node's too; list them as node reaches them
  for (const [owner, k] of [['stream.Readable', 'ReadableState'], ['stream.Writable', 'WritableState']]) {
    const v = require('node:stream')[owner.split('.')[1]][k];
    if (typeof v === 'function') list.push(`${owner}.${k}`);
  }
  return list;
}

test('node-shim: every constructor node lets an ES5 subclass call, the shim lets it call, and initializes `this`', (t) => {
  if (skipUnlessTjs(t)) return;
  const expected = nodeCallable();
  assert.ok(expected.includes('events.EventEmitter') && expected.includes('stream.Writable'), 'node answered');
  const r = runLoader(FIXTURE, [JSON.stringify(expected)], { timeout: 60000 });
  assert.strictEqual(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.deepStrictEqual(got.refused, [], 'refused with "class constructors must be invoked with \'new\'"');
  assert.deepStrictEqual(got.absent.sort(), [...ABSENT].sort(), 'the absent set moved: update ABSENT and BACKLOG.md');
  assert.deepStrictEqual(got.behaviour, {
    eventEmitter: [7, true], stringDecoder: 'hé', writable: ['a', 'b'], readable: ['p'],
  });
});

test('node-shim: the same subclasses behave the same under host node (the oracle answers what the gate asserts)', () => {
  const r = spawnSync(process.execPath, ['--no-deprecation', FIXTURE, '[]'], { encoding: 'utf8', timeout: 60000 });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout).behaviour, {
    eventEmitter: [7, true], stringDecoder: 'hé', writable: ['a', 'b'], readable: ['p'],
  });
});
