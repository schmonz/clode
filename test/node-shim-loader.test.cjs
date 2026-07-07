'use strict';
// Loader contract: CJS semantics under tjs — relative requires, module
// cache, JSON, builtin registry, wall errors, process.argv shape.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

function fixtureTree() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-loader-'));
  fs.mkdirSync(path.join(dir, 'lib'));
  fs.mkdirSync(path.join(dir, 'node_modules/leftpad'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'lib/counter.cjs'),
    'let n = 0;\nmodule.exports = { bump: () => ++n };\n');
  fs.writeFileSync(path.join(dir, 'lib/data.json'), '{"answer": 42}\n');
  fs.writeFileSync(path.join(dir, 'node_modules/leftpad/package.json'),
    '{"name":"leftpad","main":"idx.cjs"}\n');
  fs.writeFileSync(path.join(dir, 'node_modules/leftpad/idx.cjs'),
    'module.exports = (s, w) => String(s).padStart(w, "0");\n');
  fs.writeFileSync(path.join(dir, 'main.cjs'), `#!/usr/bin/env node
const a = require('./lib/counter.cjs');
const b = require('./lib/counter.cjs');          // cache: same instance
a.bump(); b.bump();
const data = require('./lib/data.json');
const pad = require('leftpad');
const p = require('node:path');
console.log(JSON.stringify({
  cached: a === b, count: a.bump(), answer: data.answer,
  padded: pad(7, 3), joined: p.join('a', 'b'),
  argv2: process.argv[2] ?? null,
}));
`);
  return dir;
}

test('loader: CJS semantics under tjs', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fixtureTree();
  const r = runLoader(path.join(dir, 'main.cjs'), ['hello']);
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  assert.deepStrictEqual(out, {
    cached: true, count: 3, answer: 42, padded: '007', joined: 'a/b', argv2: 'hello',
  });
});

test('loader: unimplemented builtin fails loud with the contract message', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-wall-'));
  fs.writeFileSync(path.join(dir, 'w.cjs'), 'require("node:dgram").createSocket();\n');
  const r = runLoader(path.join(dir, 'w.cjs'));
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /node-shim: dgram\.createSocket not implemented/);
});
