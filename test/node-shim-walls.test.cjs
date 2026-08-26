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
const REPO_ROOT = path.resolve(__dirname, '..');

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

// PROBE vs WALL. clode's generated per-specifier shims read every name the bundle
// imports at module-init and defer any failure to the CALL. Correct — but the read still
// reaches these traps, so a quaude that never opened a plugin sandbox was reporting
// vm.SourceTextModule as a wall it "exercised", and test/oracle-binaries.test.cjs failed
// a target that had just completed a full agentic turn. Third instrument fault of the
// day; the product was right every time.
//
// The exception is IDENTICAL in both modes. Only the label changes, and only the label
// is what the oracle counts.
test('a sealed miss traces as [probe] while flagged, and [wall] otherwise', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = writeProg(`
    const vm = require('node:vm');
    globalThis.__quaudeShimProbe = true;
    let probeThrew = false;
    try { vm.SourceTextModule; } catch (e) { probeThrew = true; }
    globalThis.__quaudeShimProbe = false;
    let useThrew = false;
    try { vm.SourceTextModule; } catch (e) { useThrew = true; }
    console.log(JSON.stringify({ probeThrew, useThrew }));`);
  const r = runLoader(f, [], { env: { CLODE_SHIM_TRACE: '1' } });
  assert.strictEqual(r.status, 0, r.stderr);
  // Behaviour is unchanged by the flag: a miss throws either way. If this ever goes
  // false, the flag has started SUPPRESSING walls rather than labelling them.
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), { probeThrew: true, useThrew: true },
    'the flag must change the LABEL, never whether the wall throws');
  const lines = r.stderr.split('\n');
  assert.strictEqual(lines.filter((l) => /\[probe\] vm\.SourceTextModule/.test(l)).length, 1,
    `flagged read must trace as [probe]:\n${r.stderr}`);
  assert.strictEqual(lines.filter((l) => /\[wall\] vm\.SourceTextModule/.test(l)).length, 1,
    `unflagged read must still trace as [wall]:\n${r.stderr}`);
});

// And the generator must actually set the flag — the loader half is useless alone.
test('the generated per-specifier shim flags its reads as probes, and restores', () => {
  const { shimSource } = require(path.join(REPO_ROOT, 'libexec/bun-graph-plan.cjs'));
  const src = shimSource('vm', ['createContext', 'SourceTextModule']);
  assert.match(src, /globalThis\.__quaudeShimProbe = true;/, 'reads are not flagged as probes');
  assert.match(src, /globalThis\.__quaudeShimProbe = __wasProbing;/,
    'the flag must be RESTORED, not cleared — nested shims would otherwise unflag an '
    + 'outer probe and a later real wall could be mislabelled');
  // The restore must come after the last read and before the exports, or the exported
  // bindings would be out of scope / still flagged.
  assert.ok(src.indexOf('__quaudeShimProbe = __wasProbing') > src.lastIndexOf('__m["SourceTextModule"]'),
    'the flag is restored before the last read');
  assert.ok(src.indexOf('__quaudeShimProbe = __wasProbing') < src.indexOf('export {'),
    'the flag is restored after the exports');
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
