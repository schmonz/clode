'use strict';
// Characterization of the node-shim readline module (libexec/node-shim/modules/
// readline.cjs). The bundle uses readline mostly for line-reading over a stream
// (NDJSON commands on the Remote Control bridge, child stderr lines, stdin):
// createInterface({input, output?, crlfDelay?}) -> 'line' events + async
// iteration + 'close'. Engine-agnostic pure JS, so tested under Node directly.
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const readline = require('../libexec/node-shim/modules/readline.cjs');

function fakeInput() {
  const e = new EventEmitter();
  e.resume = () => {};
  e.pause = () => {};
  return e;
}

test('createInterface emits a "line" event per newline-terminated line', () => {
  const input = fakeInput();
  const rl = readline.createInterface({ input });
  const lines = [];
  rl.on('line', (l) => lines.push(l));
  input.emit('data', 'alpha\nbeta\n');
  assert.deepStrictEqual(lines, ['alpha', 'beta']);
});

test('lines split across chunks are buffered until a newline arrives', () => {
  const input = fakeInput();
  const rl = readline.createInterface({ input });
  const lines = [];
  rl.on('line', (l) => lines.push(l));
  input.emit('data', 'hel');
  input.emit('data', 'lo\nwor');
  assert.deepStrictEqual(lines, ['hello']);
  input.emit('data', 'ld\n');
  assert.deepStrictEqual(lines, ['hello', 'world']);
});

test('crlfDelay: Infinity — \\r\\n yields a line without the trailing \\r', () => {
  const input = fakeInput();
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const lines = [];
  rl.on('line', (l) => lines.push(l));
  input.emit('data', 'one\r\ntwo\r\n');
  assert.deepStrictEqual(lines, ['one', 'two']);
});

test('a trailing line with no final newline is emitted on end, then "close"', () => {
  const input = fakeInput();
  const rl = readline.createInterface({ input });
  const lines = [];
  let closed = false;
  rl.on('line', (l) => lines.push(l));
  rl.on('close', () => { closed = true; });
  input.emit('data', 'a\nb');
  input.emit('end');
  assert.deepStrictEqual(lines, ['a', 'b']);
  assert.strictEqual(closed, true);
});

test('async iteration (for await ... of rl) yields the lines then completes', async () => {
  const input = fakeInput();
  const rl = readline.createInterface({ input });
  const got = [];
  const done = (async () => { for await (const l of rl) got.push(l); })();
  input.emit('data', 'x\ny\n');
  input.emit('end');
  await done;
  assert.deepStrictEqual(got, ['x', 'y']);
});

test('question(query, cb) writes the prompt to output and resolves on the next line', () => {
  const input = fakeInput();
  const written = [];
  const output = { write: (s) => written.push(s) };
  const rl = readline.createInterface({ input, output });
  let answer = null;
  rl.question('name? ', (a) => { answer = a; });
  input.emit('data', 'Ada\n');
  assert.deepStrictEqual(written, ['name? ']);
  assert.strictEqual(answer, 'Ada');
});

test('module-level cursor helpers exist and are safe no-ops', () => {
  assert.strictEqual(typeof readline.createInterface, 'function');
  for (const fn of ['clearLine', 'cursorTo', 'moveCursor', 'emitKeypressEvents']) {
    assert.strictEqual(typeof readline[fn], 'function', `readline.${fn} missing`);
    assert.doesNotThrow(() => readline[fn]({ write() {} }, 0));
  }
});
