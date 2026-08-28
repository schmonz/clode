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

// THE SHAPE UPSTREAM ACTUALLY HAS. The test above hands the splice a bridge that
// records findings synchronously — a fixture that cannot fail, and it did not fail
// for the three releases this hook was dead. Upstream's shell-provider builder
// KICKS OFF snapshot generation and returns the descriptor without awaiting it (the
// snapshot promise is a closed-over local; same shape on 2.1.241 and 2.1.245). So
// the honest fixture is a bridge that resolves BEFORE the probe runs. Measured on a
// real quaude built from 2.1.245: with only the ensure-step, the splice read zero
// findings 7ms in and `claude doctor` reported 1 warning instead of 2.
test('spliced builder waits for the skew PROBE, not merely for generation to start', async () => {
  const g = {};
  let releaseProbe;
  g.__clodeEnsureSnapshot = async () => {
    // "generation started": the findings land on a LATER turn, as in the product.
    setTimeout(() => {
      g.__clodeDoctor = { appletSkew: [{ name: 'find', applet: 'bfs', why: 'late', fix: 'f' }] };
      releaseProbe();
    }, 5);
    return { provider: 'zsh' };
  };
  g.__clodeAwaitSkewProbe = () => new Promise((resolve) => { releaseProbe = () => resolve(true); });
  const diag = await runBuilder(g);
  assert.strictEqual(diag.warnings.length, 1, 'findings that arrive late must still be read');
  assert.ok(diag.warnings[0].issue.includes('late'));
});

test('spliced builder does not wait on the probe when there is no bridge', async () => {
  // No bridge means nothing started generation, so waiting for a probe could only
  // burn the shim's deadline on every warnings surface for no possible finding.
  let waited = false;
  const diag = await runBuilder({ __clodeAwaitSkewProbe: async () => { waited = true; } });
  assert.strictEqual(waited, false);
  assert.strictEqual(diag.warnings.length, 0);
});

test('spliced builder survives a rejecting or throwing bridge', async () => {
  const rejected = await runBuilder({ __clodeEnsureSnapshot: async () => { throw new Error('boom'); } });
  assert.strictEqual(rejected.warnings.length, 0);
  const threw = await runBuilder({ __clodeEnsureSnapshot: () => { throw new Error('sync boom'); } });
  assert.strictEqual(threw.warnings.length, 0);
  // …and a probe signal that rejects or throws must not take the surface down either
  const finding = { name: 'find', applet: 'bfs', why: 'w', fix: 'f' };
  const probeRejected = await runBuilder({
    __clodeDoctor: { appletSkew: [finding] },
    __clodeEnsureSnapshot: async () => ({ provider: 'zsh' }),
    __clodeAwaitSkewProbe: async () => { throw new Error('probe boom'); },
  });
  assert.strictEqual(probeRejected.warnings.length, 1, 'already-recorded findings still land');
  const probeThrew = await runBuilder({
    __clodeEnsureSnapshot: async () => ({ provider: 'zsh' }),
    __clodeAwaitSkewProbe: () => { throw new Error('sync probe boom'); },
  });
  assert.strictEqual(probeThrew.warnings.length, 0);
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

// 2.1.243 gave the generator a `storageV5` parameter, which stopped the old
// `\(\)` anchor dead. Each fixture below is a byte slice cut out of that version's
// REAL darwin-arm64 bundle around `return{provider:await ` — not a hand-written
// approximation. All three carry the memoizing wrapper right after the generator,
// which is what makes the "never the wrapper" assertion below meaningful.
for (const [version, gen, wrapper] of [
  ['2.1.241', 'X5v', 'XUf'],   // no-arg generator, memo `Afe.shellConfig??=X5v()`
  ['2.1.243', 'iqo', 'ozn'],   // storageV5 arrives; memo `jC.shellConfig??=iqo(e)`
  ['2.1.245', 'iqo', 'ozn'],   // byte-identical shape to 2.1.243 in this window
]) {
  test(`patchSnapshotBridge applies to the REAL ${version} bundle shape`, () => {
    const src = read(`snapshot-gen-${version}.js`);
    const [out, applied] = ex.patchSnapshotBridge(src);
    assert.strictEqual(applied, true, `${version}: anchor did not apply`);
    assert.ok(out.includes(`globalThis.__clodeEnsureSnapshot=${gen};`),
      `${version}: bridge must expose the generator ${gen}`);
    // NEVER the memoizing wrapper: pre-warming through it would plant a
    // storageV5-less shellConfig in the memo that the app then uses all session.
    assert.ok(!out.includes(`globalThis.__clodeEnsureSnapshot=${wrapper};`),
      `${version}: bridge must not expose the memoizing wrapper ${wrapper}`);
    // The memo statement itself must come through untouched.
    assert.ok(out.includes(`shellConfig??=${gen}(`), `${version}: memo site was disturbed`);
  });
}

test('patchSnapshotBridge is fail-loud on absent/ambiguous generator', () => {
  for (const v of ['2.1.205', '2.1.241', '2.1.245']) {
    const gen = read(`snapshot-gen-${v}.js`);
    assert.strictEqual(ex.patchSnapshotBridge(gen + gen)[1], false, `${v}: doubled must not apply`);
  }
  assert.strictEqual(ex.patchSnapshotBridge('no generator here')[1], false);
  // The storageV5 tail is back-referenced to the generator's own parameter, so a
  // near-miss that threads someone ELSE's binding is not the generator we mean.
  assert.strictEqual(
    ex.patchSnapshotBridge('async function G9(e){let h9=await S9();return{provider:await I9(h9,{storageV5:zz})}}')[1],
    false);
});

test('exposed bridge is callable and runs the generator (no-arg shape)', async () => {
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

// The decision this hook rests on, executed rather than argued: pre-warming must
// NOT populate the wrapper's memo, so the app still builds its own shellConfig from
// its own storageV5. Shaped exactly like 2.1.245's generator+wrapper pair.
test('pre-warming through the bridge leaves the memo for the app (storageV5 fidelity)', async () => {
  const synth =
    'async function G9(e){let h9=await S9();return{provider:await I9(h9,{storageV5:e})}}'
    + 'function W9(e){return M9.shellConfig??=G9(e),M9.shellConfig}';
  const [patched, applied] = ex.patchSnapshotBridge(synth);
  assert.strictEqual(applied, true);
  const seen = [];
  const ctx = vm.createContext({
    M9: { shellConfig: null },
    S9: async () => 'zsh',
    I9: async (h, o) => { seen.push(o.storageV5); return 'snap'; },
  });
  vm.runInContext(patched, ctx);

  await vm.runInContext('globalThis.__clodeEnsureSnapshot()', ctx);
  assert.deepStrictEqual(seen, [undefined], 'the bridge generates with storageV5 undefined');
  assert.strictEqual(vm.runInContext('M9.shellConfig', ctx), null,
    'the pre-warm must NOT occupy the memo the app later fills');

  await vm.runInContext('W9("REAL_STORAGE")', ctx);
  assert.deepStrictEqual(seen, [undefined, 'REAL_STORAGE'],
    "the app's own call still runs with the app's own storageV5");
  assert.notStrictEqual(vm.runInContext('M9.shellConfig', ctx), null);
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

// --- Remote Control honest gate-off --------------------------------------------

test('patchRemoteControlUnavailable injects the wsUnavailable guard before the api.anthropic.com reason', () => {
  const [out, applied] = ex.patchRemoteControlUnavailable(read('cbo-remote-control-2.1.218.js'));
  assert.strictEqual(applied, true);
  // guard is injected as its own statement, immediately before the anchored reason
  assert.match(
    out,
    /if\(globalThis\.__clodeWsUnavailable\)return"Remote Control isn\\u2019t available in quaude yet \\u2014 its engine has no WebSocket transport\.";if\(!K8e\(\)\)return"Remote Control is only available when using Claude via api\.anthropic\.com\."/,
  );
});

// The availability gate as upstream now emits it (2.1.207-era): a minified
// `async function X(){...}` returning null when Remote Control is available or a
// reason string when not. The stable "not available inside a cloud session"
// literal pins it; minified ids vary.
const RC_GATE = 'async function VUo(){if(qUo())return null;if(!DVe())return H4_();'
  + 'if(qW())return"Remote Control is not available inside a cloud session.";'
  + 'if(!zUo())return"Remote Control requires a claude.ai subscription.";return null;}';

test('patchRemoteControlUnavailable injects the gate-off as the function\'s first statement', () => {
  const [out, applied] = ex.patchRemoteControlUnavailable('var x=1;' + RC_GATE);
  assert.strictEqual(applied, true);
  // The gate-off runs BEFORE the first `return null` (available) path.
  assert.match(out, /async function VUo\(\)\{if\(globalThis\.__clodeWsUnavailable\)return"Remote Control isn.*transport\.";if\(qUo\(\)\)return null;/);
});

const RC_INLINE = 'if(!K8e())return"Remote Control is only available when using Claude via api.anthropic.com.";';

test('patchRemoteControlUnavailable refuses ambiguous or absent anchors', () => {
  assert.strictEqual(ex.patchRemoteControlUnavailable('nothing to see')[1], false);
  assert.strictEqual(ex.patchRemoteControlUnavailable(RC_GATE + RC_GATE)[1], false);      // two gates
  assert.strictEqual(ex.patchRemoteControlUnavailable(RC_INLINE + RC_INLINE)[1], false);  // two inlines
});

test('patchRemoteControlUnavailable still supports the old inline shape (<=2.1.218)', () => {
  const [out, applied] = ex.patchRemoteControlUnavailable('x;' + RC_INLINE);
  assert.strictEqual(applied, true);
  // Gate-off spliced immediately before the inline api.anthropic.com reason guard.
  assert.match(out, /if\(globalThis\.__clodeWsUnavailable\)return"[^"]*";if\(!K8e\(\)\)return"Remote Control is only available/);
});

// FROM 2.1.251 THE BUNDLE READS EMBEDDED ASSETS WITH fs, NOT require(), and a target has no
// filesystem holding /$bunfs/root/... . 101 assets are read that way in 2.1.251 (72 still the old
// way), and the build smokes green right up to the first turn, where upstream throws its own
// "embedded text asset is missing or corrupt". The patch wraps the IMPORT BINDINGS rather than
// the readers, because the reader bodies are minified and rename every release while the import
// statements name what they bind.
const { patchEmbeddedAssetReader } = require('../libexec/extract-claude-js.cjs');

// The real 2.1.251 helper, verbatim (chunk-t0k3nmf2.js).
const ASSET_CHUNK = 'import{readFileSync as o}from"fs";import{readFile as i}from"fs/promises";'
  + 'import{isAbsolute as d,join as c}from"path";var u=[40,181,47,253];'
  + 'function s(t){return t.length>=4&&u.every((e,r)=>t[r]===e)}'
  + 'function Z2t(t,e){return d(t)?t:c(e,t)}'
  + 'async function RX(t,e){let r=await i(Z2t(t,e));return(s(r)?await Bun.zstdDecompress(r):r).toString("utf8")}'
  + 'function nt(t,e){let r=Z2t(t,e);try{let n=o(r);return(s(n)?Bun.zstdDecompressSync(n):n).toString("utf8")}'
  + 'catch(n){throw Object.assign(Error("embedded text asset is missing or corrupt",{cause:n}),{path:r})}}\n'
  + 'export{Z2t,RX,nt};\n';

test('embedded_asset_reader: an fs-read asset resolves through the embedded map', () => {
  const [patched, applied] = patchEmbeddedAssetReader(ASSET_CHUNK);
  assert.strictEqual(applied, true, 'the 2.1.251 helper must be recognised');

  // Evaluate the patched module the way the target does: __quaudeRequire answers embedded
  // names and fs is never reached.
  const calls = [];
  const mod = evalPatched(patched, {
    __quaudeRequire: (n) => {
      calls.push(n);
      if (n === '/$bunfs/root/SKILL.md.zst') return '# skill\n';
      throw new Error('Cannot find module ' + n);
    },
  }, { readFileSync: () => { throw new Error('fs must not be reached for an embedded asset'); } });

  assert.strictEqual(mod.nt('/$bunfs/root/SKILL.md.zst', '/base'), '# skill\n');
  assert.deepStrictEqual(calls, ['/$bunfs/root/SKILL.md.zst']);
});

test('embedded_asset_reader: a real path still falls through to fs', () => {
  const [patched] = patchEmbeddedAssetReader(ASSET_CHUNK);
  const mod = evalPatched(patched,
    { __quaudeRequire: (n) => { throw new Error('Cannot find module ' + n); } },
    { readFileSync: (p) => { assert.strictEqual(p, '/real/file.txt'); return 'from disk'; } });
  assert.strictEqual(mod.nt('/real/file.txt', '/base'), 'from disk');
});

test('embedded_asset_reader: a provider without the fs reader is left alone', () => {
  const [body, applied] = patchEmbeddedAssetReader('var x=1;export{x};\n');
  assert.strictEqual(applied, false);
  assert.strictEqual(body, 'var x=1;export{x};\n');
});

// Evaluate the patched ESM helper as CJS: rewrite its imports to the injected stubs and its
// export clause to module.exports. Small and local on purpose — the point is to RUN the patched
// code, not to re-test an ESM loader.
function evalPatched(src, globals, fsStub) {
  const body = src
    .replace(/import\{readFileSync as ([A-Za-z0-9_$]+)\}from"fs";/, 'const $1=__fs.readFileSync;')
    .replace(/import\{readFile as ([A-Za-z0-9_$]+)\}from"fs\/promises";/, 'const $1=__fsp.readFile;')
    .replace(/import\{isAbsolute as ([A-Za-z0-9_$]+),join as ([A-Za-z0-9_$]+)\}from"path";/,
      'const $1=__path.isAbsolute, $2=__path.join;')
    .replace(/export\{([^}]*)\};/, (m0, names) => 'module.exports={' + names + '};');
  const module = { exports: {} };
  const g = Object.assign(Object.create(globalThis), globals);
  new Function('module', '__fs', '__fsp', '__path', 'globalThis', body)(
    module, fsStub, { readFile: async () => { throw new Error('unused'); } }, path, g);
  return module.exports;
}
