'use strict';
// Unit tests for extract-claude-js.cjs's /doctor patch hooks — the applet-skew
// warnings contribution and the eager-snapshot bridge.
//
// History that shapes these tests:
//   * Upstream 2.1.205 reworked /doctor from a local-jsx screen (with a
//     `load:` site our old DOCTOR_LOAD anchor patched) into a prompt-driven
//     agent command with no load site at all. The eager-snapshot work now rides
//     the INSTALL_WARNINGS splice inside the diagnostics builder itself, which
//     every warnings-rendering surface calls (/doctor screen on <=2.1.204,
//     `claude doctor` terminal + /status warnings on 2.1.205+). DOCTOR_LOAD is
//     retired; SNAPSHOT_GEN only exposes the bridge.
//   * Since 2.1.203 the minified warnings array is named `s`, which SHADOWED
//     the old injection's forEach callback param (also `s`) — the injected
//     `s.push(...)` hit the finding object and threw. The callback param must
//     be un-minifiable (>6 chars) so it can never collide with the captured
//     array name.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const ex = require(path.join(ROOT, 'libexec', 'extract-claude-js.cjs'));
const FIX = path.join(__dirname, 'fixtures', 'doctor');
const read = (name) => fs.readFileSync(path.join(FIX, name), 'latin1');

// --- warnings splice: anchor matching on REAL minified neighborhoods ---------

test('patchDoctorWarnings applies to the 2.1.179 shape (warnings var L)', () => {
  const [out, applied] = ex.patchDoctorWarnings(read('warnings-2.1.179.js'));
  assert.strictEqual(applied, true);
  assert.match(out, /forEach\(function\(__clodeSkw\)\{L\.push\(\{/);
});

test('patchDoctorWarnings applies to the 2.1.205 shape (warnings var s — the shadow case)', () => {
  const [out, applied] = ex.patchDoctorWarnings(read('warnings-2.1.205.js'));
  assert.strictEqual(applied, true);
  // The callback param must NOT be the captured array name: `s.push` must
  // reach the warnings array, so the param is the un-minifiable __clodeSkw.
  assert.match(out, /forEach\(function\(__clodeSkw\)\{s\.push\(\{/);
  assert.ok(!/function\(s\)\{s\.push/.test(out), 'callback param shadows the warnings array');
});

test('patchDoctorWarnings refuses ambiguous or absent anchors', () => {
  const one = read('warnings-2.1.205.js');
  assert.strictEqual(ex.patchDoctorWarnings('nothing to see')[1], false);
  assert.strictEqual(ex.patchDoctorWarnings(one + one)[1], false);
});

// --- warnings splice: FUNCTIONAL, against a synthetic async builder ----------
// The minified builder is `async function ...{...return{installationType:...,
// warnings:s,packageManager:...}}` in all of 2.1.203..205. Run the patched
// splice for real to lock (a) the shadow fix, (b) eager ensure-before-read,
// (c) failure isolation.

const BUILDER =
  'async function d0(){let s=[];await 0;'
  + 'return{installationType:"native",version:"9.9.9",warnings:s,packageManager:void 0}}';

function runBuilder(globals) {
  const [patched, applied] = ex.patchDoctorWarnings(BUILDER);
  assert.strictEqual(applied, true, 'synthetic builder must match the anchor');
  const ctx = vm.createContext(globals);
  return vm.runInContext(patched + ';d0()', ctx);
}

test('spliced builder pushes recorded findings onto the warnings array (shadow regression)', async () => {
  const finding = { name: 'find', applet: 'bfs', why: 'probe why', fix: 'install bfs >= 3.3' };
  const diag = await runBuilder({ __clodeDoctor: { appletSkew: [finding] } });
  assert.strictEqual(diag.warnings.length, 1);
  assert.ok(diag.warnings[0].issue.includes('host bfs rejects flags'));
  assert.ok(diag.warnings[0].issue.includes('probe why'));
  assert.strictEqual(diag.warnings[0].fix, 'install bfs >= 3.3');
});

test('spliced builder falls back to the generic CLODE_<APPLET> fix', async () => {
  const diag = await runBuilder({
    __clodeDoctor: { appletSkew: [{ name: 'grep', applet: 'ugrep', why: 'w' }] },
  });
  assert.strictEqual(diag.warnings[0].fix, 'set CLODE_UGREP to a compatible ugrep');
});

test('spliced builder awaits the snapshot bridge BEFORE reading findings (eager)', async () => {
  // The bridge populates __clodeDoctor only when awaited — a first-open /doctor:
  // no shell command has run yet, so findings exist only if the builder ensures
  // the snapshot (firing the skew probe) before it reads them.
  const g = {};
  g.__clodeEnsureSnapshot = async () => {
    g.__clodeDoctor = { appletSkew: [{ name: 'find', applet: 'bfs', why: 'eager', fix: 'f' }] };
    return { provider: 'zsh' };
  };
  const diag = await runBuilder(g);
  assert.strictEqual(diag.warnings.length, 1);
  assert.ok(diag.warnings[0].issue.includes('eager'));
});

test('spliced builder survives a rejecting or throwing bridge', async () => {
  const rejected = await runBuilder({ __clodeEnsureSnapshot: async () => { throw new Error('boom'); } });
  assert.strictEqual(rejected.warnings.length, 0);
  const threw = await runBuilder({ __clodeEnsureSnapshot: () => { throw new Error('sync boom'); } });
  assert.strictEqual(threw.warnings.length, 0);
});

test('spliced builder is a no-op without bridge or findings', async () => {
  const diag = await runBuilder({});
  assert.strictEqual(diag.warnings.length, 0);
  assert.strictEqual(diag.installationType, 'native');
});

// --- snapshot bridge ----------------------------------------------------------

test('patchSnapshotBridge exposes the real 2.1.205 generator as the bridge', () => {
  const [out, applied] = ex.patchSnapshotBridge(read('snapshot-gen-2.1.205.js'));
  assert.strictEqual(applied, true);
  assert.ok(out.includes('return{provider:await efu(e)}}globalThis.__clodeEnsureSnapshot=Bag;'));
});

test('patchSnapshotBridge is fail-loud on absent/ambiguous generator', () => {
  const gen = read('snapshot-gen-2.1.205.js');
  assert.strictEqual(ex.patchSnapshotBridge('no generator here')[1], false);
  assert.strictEqual(ex.patchSnapshotBridge(gen + gen)[1], false);
});

test('exposed bridge is callable and runs the generator', async () => {
  const synth = 'async function G9(){let h9=await S9();return{provider:await I9(h9)}}';
  const [patched, applied] = ex.patchSnapshotBridge(synth);
  assert.strictEqual(applied, true);
  const calls = [];
  const ctx = vm.createContext({
    S9: async () => { calls.push('S9'); return 'zsh'; },
    I9: async (h) => { calls.push('I9:' + h); return 'snap'; },
  });
  vm.runInContext(patched, ctx);
  const got = await vm.runInContext('globalThis.__clodeEnsureSnapshot()', ctx);
  // Field-wise: `got` was constructed in the vm realm, so its prototype differs.
  assert.strictEqual(got.provider, 'snap');
  assert.deepStrictEqual(calls, ['S9', 'I9:zsh']);
});

// --- the DOCTOR_LOAD hook is retired ------------------------------------------

test('DOCTOR_LOAD patch retired: no patchDoctorEager export, no load-site rewrite', () => {
  assert.ok(!('patchDoctorEager' in ex), 'patchDoctorEager should be gone');
  // 2.1.204's load site (as patched output documented it) must pass through
  // patchSnapshotBridge untouched — the bridge only touches the generator.
  const load = 'R4y={name:"doctor",type:"local-jsx",load:()=>Promise.resolve().then(() => (i3d(),n3d))}';
  const [out] = ex.patchSnapshotBridge(load);
  assert.strictEqual(out, load);
});
