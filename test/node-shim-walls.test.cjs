'use strict';
// M2 entry gate #1: partial builtins wall property-granular; Module.wrap and a
// fuller vm exist; require() routes through Module._load so a monkeypatch
// intercepts (the mechanism bun-shim needs for bun:ffi/ws/undici).
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
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

// module.isBuiltin — NOT a wall, and it should never have been one.
//
// clode's own graph runner calls it to route node builtins around its resolve hook, so
// when 2.1.246 first exercised a full round-trip the oracle reported OUR gap alongside
// upstream's: "the shim hit walls this round-trip exercised: module.isBuiltin,
// vm.SyntheticModule, vm.SourceTextModule". The vm entries are a real design question;
// this one was just missing.
//
// Asserted as a DIFFERENTIAL against host node rather than against a hand-written
// expectation, because the interesting property is agreement, and a hand-written table
// would be a third copy of the builtin list to drift.
test('module.isBuiltin agrees with host node, and with our own builtinModules', (t) => {
  if (skipUnlessTjs(t)) return;
  const prog = `
    const M = require('node:module');
    const names = ['fs', 'node:fs', 'path', 'node:path', 'util', 'events',
                   'definitely-not-a-builtin', 'node:definitely-not', ''];
    const out = {};
    for (const n of names) out[n] = M.isBuiltin(n);
    out.__type = typeof M.isBuiltin;
    // Every module we claim to provide must answer true — three lists (KNOWN,
    // builtinModules, isBuiltin) disagreeing is the bug this guards.
    out.__selfConsistent = M.builtinModules.every((x) => M.isBuiltin(x));
    console.log(JSON.stringify(out));`;
  const f = writeProg(prog);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout.trim());
  assert.strictEqual(got.__type, 'function', 'module.isBuiltin must exist, not throw a wall');
  assert.strictEqual(got.__selfConsistent, true,
    'a module in builtinModules that isBuiltin denies — the lists have drifted apart');

  // The reference: the same program under the node running this test.
  const ref = JSON.parse(execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim());
  for (const k of Object.keys(ref)) {
    if (k === '__selfConsistent') continue;   // node's builtin set is legitimately larger
    assert.strictEqual(got[k], ref[k], `isBuiltin(${JSON.stringify(k)}) disagrees with host node`);
  }
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
