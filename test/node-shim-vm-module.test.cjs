'use strict';
// Characterization: node:vm (Script syntax-gate) and node:module
// (createRequire) must match host node's observable answers for the M1
// surface the toolchain uses. vm.Script here is a syntax-check-only shim
// (see modules/vm.cjs) — runInThisContext is a documented wall.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

// vm.Script: valid source constructs; invalid source throws SyntaxError.
// (runInThisContext is intentionally a wall in the shim, so we do NOT compare
// its behavior to node — that is a recorded divergence, not characterization.)
const VM_PROG = `
const vm = require('node:vm');
const out = {};
out.validOk = (() => { try { new vm.Script('const a = 1 + 2;'); return true; } catch { return false; } })();
out.badThrows = (() => { try { new vm.Script('const = ;'); return 'no-throw'; } catch (e) { return e instanceof SyntaxError ? 'SyntaxError' : e.constructor.name; } })();
console.log(JSON.stringify(out));
`;

test('vm.Script: syntax gate matches host node (valid ok, invalid -> SyntaxError)', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-vm-'));
  const f = path.join(dir, 'vm.cjs');
  fs.writeFileSync(f, VM_PROG);
  const nodeOut = require('node:child_process')
    .execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim();
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), nodeOut);
  // And pin the concrete answer so a future regression is visible in the diff.
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), { validOk: true, badThrows: 'SyntaxError' });
});

test('module.createRequire: resolves relative + node builtins from a given file', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-mod-'));
  fs.mkdirSync(path.join(dir, 'lib'));
  fs.writeFileSync(path.join(dir, 'lib/greet.cjs'),
    'module.exports = (n) => "hi " + n;\n');
  // The entry uses createRequire against a synthetic path inside lib/, so the
  // relative resolution base must be lib/ (not the entry's dir).
  fs.writeFileSync(path.join(dir, 'main.cjs'), `
const { createRequire } = require('node:module');
const url = require('node:url');
const path = require('node:path');
const req = createRequire(path.join(__dirname, 'lib', 'anchor.cjs'));
const greet = req('./greet.cjs');
const p = req('node:path');
// file:// form of createRequire, too.
const reqUrl = createRequire(url.pathToFileURL(path.join(__dirname, 'lib', 'anchor.cjs')).href);
const greet2 = reqUrl('./greet.cjs');
console.log(JSON.stringify({
  greet: greet('ada'),
  builtin: p.join('a', 'b'),
  fromUrl: greet2('grace'),
}));
`);
  const nodeOut = require('node:child_process')
    .execFileSync(process.execPath, [path.join(dir, 'main.cjs')], { encoding: 'utf8' }).trim();
  const r = runLoader(path.join(dir, 'main.cjs'));
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), nodeOut);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), {
    greet: 'hi ada', builtin: 'a/b', fromUrl: 'hi grace',
  });
});
