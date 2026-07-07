'use strict';
// M2 entry gate #1: partial builtins wall property-granular; Module.wrap and a
// fuller vm exist; require() routes through Module._load so a monkeypatch
// intercepts (the mechanism bun-shim needs for bun:ffi/ws/undici).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

function writeProg(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-walls-'));
  const f = path.join(dir, 'p.cjs');
  fs.writeFileSync(f, body);
  return f;
}

test('sealed builtin: unimplemented prop throws the branded wall', (t) => {
  if (skipUnlessTjs(t)) return;
  // vm is sealed; vm.SourceTextModule is unimplemented -> branded, NOT bare TypeError.
  const f = writeProg('const vm=require("node:vm"); vm.SourceTextModule;');
  const r = runLoader(f);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /node-shim: vm\.SourceTextModule not implemented/);
});

test('Module.wrap + module builtinModules present', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = writeProg(`
    const M = require('node:module');
    const w = M.wrap('module.exports=1;');
    console.log(JSON.stringify({
      wrapsExports: w.includes('exports') && w.includes('require'),
      hasPath: M.builtinModules.includes('path'),
    }));`);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), { wrapsExports: true, hasPath: true });
});

test('require() routes through Module._load (monkeypatch intercepts)', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = writeProg(`
    const M = require('node:module');
    const orig = M._load;
    M._load = (req, parent, isMain) =>
      req === 'x:sentinel' ? { hit: true } : orig(req, parent, isMain);
    console.log(JSON.stringify(require('x:sentinel')));`);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), { hit: true });
});

test('vm.runInThisContext evaluates (documented global-context divergence)', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = writeProg('const vm=require("node:vm"); console.log(vm.runInThisContext("1+2"));');
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), '3');
});
