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

test('loader: require.main is the entry module (node semantics)', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-reqmain-'));
  // A required child sees require.main !== module (it is not the entry);
  // the entry sees require.main === module. Mirrors node's contract, which
  // extract-claude-js.cjs relies on via `if (require.main === module)`.
  fs.writeFileSync(path.join(dir, 'child.cjs'),
    'module.exports = { childIsMain: require.main === module };\n');
  fs.writeFileSync(path.join(dir, 'entry.cjs'), `
const child = require('./child.cjs');
console.log(JSON.stringify({
  entryIsMain: require.main === module,
  childIsMain: child.childIsMain,
  mainIsEntry: require.main === module,
  mainFilename: require.main && require.main.filename === __filename,
}));
`);
  const r = runLoader(path.join(dir, 'entry.cjs'));
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), {
    entryIsMain: true, childIsMain: false, mainIsEntry: true, mainFilename: true,
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

// Wall (Task 4): the -p bundle wraps some builtins with an ESM-interop helper
// `__toESM(require('http'))` that reads `.__esModule` FIRST. A real CJS builtin
// has no `__esModule` (reads as undefined), so the wallProxy must return
// undefined for that interop probe — NOT wall — while still walling loudly on
// any real API. This lets a module that merely *captures* an unimplemented
// builtin (but never calls it on the -p path) load.
test('loader: wallProxy is ESM-interop safe (__esModule undefined, real API walls)', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-interop-'));
  // The interop probe must NOT throw; the real method call still must.
  fs.writeFileSync(path.join(dir, 'ok.cjs'),
    'const h = require("node:dgram"); console.log(JSON.stringify({ esm: h.__esModule ?? null }));\n');
  const ok = runLoader(path.join(dir, 'ok.cjs'));
  assert.strictEqual(ok.status, 0, ok.stderr);
  assert.deepStrictEqual(JSON.parse(ok.stdout.trim()), { esm: null });
});
