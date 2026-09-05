'use strict';
// The engine API floor (scripts/engine-api-floor.mjs) and its three consumers.
//
// WHAT WENT WRONG. patches/txiki-engine-module-meta.patch has a C half
// (src/mod_engine.c) and a JS half (src/js/core/engine.js). The JS half reaches
// a binary only through a regen of txiki's git-tracked pre-compiled
// src/bundles/c/**. Every build path runs that regen from scripts/build-tjs.mjs
// — except the netbsd-sparc in-guest bake, which drives cmake by hand inside a
// 512MB sun4m guest with no node and skipped it ("canonical-LE: no regen
// needed"). So that leg shipped an engine with the C function and no binding
// onto it, and nothing said so until `quaude-fuse: this engine does not report
// moduleMeta` — 927 seconds into the carve, at the last stage of the longest job
// in the matrix.
//
// Three separate engine sanity checks existed at the time (build-tjs.mjs's
// post-build smoke, build-leg's host-exec smoke, ci-guest-bake.sh's ENGINE
// SANITY). All three were hand-written copies of one `typeof __tjs_fs_sync`
// test, and not one of them knew about moduleMeta. This file pins the two
// properties that keep that shape from coming back: ONE list of required
// bindings, and every consumer GENERATING its check from that list.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { defineGuard, guardTests } = require('./guard.cjs');

const repo = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(repo, rel), 'utf8');
const FLOOR_MJS = 'scripts/engine-api-floor.mjs';
const BAKE = 'spike/quickjs/qemu/ci-guest-bake.sh';
const ACTION = '.github/actions/build-leg/action.yml';
const BUILD_TJS = 'scripts/build-tjs.mjs';
const load = () => import(require('node:url').pathToFileURL(path.join(repo, FLOOR_MJS)).href);

test('the floor names moduleMeta, and says which patch provides it', async () => {
  const { ENGINE_API_FLOOR } = await load();
  const mm = ENGINE_API_FLOOR.find((b) => b.name === 'tjs.engine.moduleMeta');
  assert.ok(mm, 'the binding whose absence cost the sparc leg two days is not in the floor');
  assert.strictEqual(mm.kind, 'function');
  assert.match(mm.from, /txiki-engine-module-meta\.patch/);
  assert.match(mm.from, /REGEN/,
    'the entry must say the JS half needs a src/bundles/c/** regen — that is the whole lesson');
  // The two the old hand-written checks did cover are still covered.
  const names = ENGINE_API_FLOOR.map((b) => b.name);
  assert.ok(names.includes('__tjs_fs_sync'));
  assert.ok(names.includes('__tjs_spawn_sync'));
});

test('the generated check reports OK, and on a miss names the binding AND exits nonzero', async () => {
  const { engineFloorCheckFile, OK_TOKEN } = await load();
  // Both halves matter: build-tjs.mjs compares the printed token, and
  // ci-sparc-driver.py gates on a `<phase>-exit=0` marker (an exit status).
  const ok = engineFloorCheckFile([{ name: 'globalThis', expr: 'globalThis', kind: 'object', from: 'x', why: 'y' }]);
  assert.match(ok, new RegExp(OK_TOKEN));
  const bad = engineFloorCheckFile([{ name: 'nope', expr: 'globalThis.__no_such_binding__.deep', kind: 'function', from: 'x', why: 'y' }]);
  assert.match(bad, /MISSING-ENGINE-API/);
  assert.match(bad, /throw new Error/);
  // An expression that THROWS on the way (a missing intermediate, exactly what
  // `tjs.engine.moduleMeta` looks like on an engine with no `engine` object)
  // must be reported as missing, not blow up the check itself.
  const runNode = (src) => {
    const f = path.join(require('node:os').tmpdir(), `floor-${process.pid}.js`);
    fs.writeFileSync(f, src);
    try { return { out: execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim(), code: 0 }; }
    catch (e) { return { out: String(e.stdout || '').trim(), code: e.status }; }
    finally { fs.unlinkSync(f); }
  };
  const r = runNode(bad);
  assert.match(r.out, /MISSING-ENGINE-API: nope \(function\)/);
  assert.notStrictEqual(r.code, 0, 'a missing binding must be a nonzero exit, not just a printed line');
  assert.strictEqual(runNode(ok).code, 0);
});

test('the real floor passes on a locally built engine (skipped if none)', async (t) => {
  const { engineFloorCheckFile, OK_TOKEN } = await load();
  // Resolved through the SAME allocator every other consumer uses (Task 8: tjsDir()/
  // tjsBin() moved off-tree; test/node-shim-helper.cjs's tjsPath() is the one place
  // that already does CLODE_TJS-override-or-tjsBin(REPO) correctly — hand-joining
  // 'build/tjs' here was exactly the stale-path bug the migration was fixing
  // elsewhere and missed here: on a clean checkout (no local build) that directory
  // is simply absent, so a bare `return` reported an evergreen ✔ that never ran the
  // real check it claims to run.
  const { tjsPath } = require('./node-shim-helper.cjs');
  const engine = tjsPath();
  if (!engine) {
    // LOUD skip, not a silent `return` — a bare return under node:test reports as a
    // passing ✔, indistinguishable from having actually verified the real floor.
    t.skip('no locally built engine (CLODE_TJS or tjsBin(REPO)) — CI\'s host-exec smoke covers it');
    return;
  }
  const f = path.join(require('node:os').tmpdir(), `floor-engine-${process.pid}.js`);
  fs.writeFileSync(f, engineFloorCheckFile());
  try {
    assert.strictEqual(execFileSync(engine, ['run', f], { encoding: 'utf8' }).trim(), OK_TOKEN);
  } finally { fs.unlinkSync(f); }
});

// ---- every consumer GENERATES its check; none hand-writes one -------------
// ---- the bake compiles a COMPLETE tree; it never generates one ------------
//
// PURE: every check below is a presence/absence assertion against the three
// already-read files (build-tjs.mjs, the build-leg action, the guest bake script).
function scanEngineFloorConsumers({ buildTjsSrc, actionYml, bakeSrc }) {
  const findings = [];
  let examined = 0;

  examined++;
  if (!/import \{ engineFloorCheckJs, OK_TOKEN \} from '\.\/engine-api-floor\.mjs';/.test(buildTjsSrc)) {
    findings.push('build-tjs.mjs no longer imports its smoke check from engine-api-floor.mjs');
  }
  examined++;
  if (!/const evalArgs = \['eval', engineFloorCheckJs\(\)\];/.test(buildTjsSrc)) {
    findings.push('build-tjs.mjs no longer generates its eval args from engineFloorCheckJs()');
  }
  examined++;
  if (/typeof __tjs_fs_sync === "object" \? "tjs-shim-ok"/.test(buildTjsSrc)) {
    findings.push('the inline copy of the engine check is back in build-tjs.mjs');
  }

  examined++;
  if (!/node scripts\/engine-api-floor\.mjs --emit-check > "\$RUNNER_TEMP\/engine-api-floor\.js"/.test(actionYml)) {
    findings.push('build-leg host-exec smoke is no longer generated from the floor');
  }
  examined++;
  if (/typeof __tjs_fs_sync === "object" \? "tjs-shim-ok"/.test(actionYml)) {
    findings.push('the inline copy of the engine check is back in build-leg/action.yml');
  }

  examined++;
  if (!/f1 engine-api-floor\.js "\$S\/engine-api-floor\.js"/.test(bakeSrc)) {
    findings.push('the guest bake no longer fetches the generated floor check from the served workspace');
  }
  examined++;
  if (!/\$TJS run "\$W\/engine-api-floor\.js"/.test(bakeSrc)) findings.push('the guest bake no longer runs the fetched floor check');
  examined++;
  if (!/echo "cle-floor-exit=\$\?"/.test(bakeSrc)) {
    findings.push('the guest bake driver no longer gates on a <phase>-exit=0 marker for the floor check');
  }
  examined++;
  if (/typeof __tjs_spawn_sync/.test(bakeSrc)) findings.push('the bake is back to hand-writing its own engine sanity list');
  examined++;
  if (!/node scripts\/engine-api-floor\.mjs --emit-check > \.matrix\/qemu-bake\/engine-api-floor\.js/.test(actionYml)) {
    findings.push('the runner no longer stages the generated floor check for the guest bake');
  }

  examined++;
  {
    const idx = actionYml.indexOf('tar czf .matrix/qemu-bake/txiki-canonical-le.tar.gz');
    if (idx === -1) {
      findings.push('the guest source tarball step was not found in build-leg/action.yml');
    } else if (!/node scripts\/build-tjs\.mjs --regen-only/.test(actionYml.slice(0, idx).slice(-2000))) {
      findings.push('the guest tree must be bytecode-regenerated BEFORE it is tarred for the guest');
    }
  }

  examined++;
  if (!/clode:bytecode-regen/.test(bakeSrc)) findings.push('the bake no longer demands the regen fingerprint trailer build-tjs.mjs stamps');
  examined++;
  if (!/cle-regen-present=/.test(bakeSrc)) findings.push('the regen-present marker is gone (the console can no longer say which check failed)');
  examined++;
  if (!/bake-exit=1/.test(bakeSrc)) findings.push('the bake no longer has a bake-exit=1 failure marker');
  examined++;
  if (/canonical-LE: no regen needed/.test(bakeSrc)) {
    findings.push('the claim that started this whole guard ("canonical-LE: no regen needed") is back');
  }

  return { findings, examined };
}

const consumersGuard = defineGuard({
  name: 'engine-api-floor-consumers',
  // 15 fixed presence/absence checks (examined++ once per check, unconditionally);
  // floor 14 (one under) fires if a check silently drops out of scanEngineFloorConsumers.
  floor: 14,
  read: () => ({
    buildTjsSrc: read(BUILD_TJS),
    actionYml: read(ACTION),
    bakeSrc: read(BAKE),
  }),
  scan: scanEngineFloorConsumers,
  // Models the exact regression this guard exists to catch: every consumer back
  // to a hand-written inline check, and the guest bake's "no regen needed" claim
  // (the one that cost the sparc leg two days) reintroduced.
  control: () => ({
    buildTjsSrc: 'typeof __tjs_fs_sync === "object" ? "tjs-shim-ok" : "tjs-shim-missing"',
    actionYml: 'typeof __tjs_fs_sync === "object" ? "tjs-shim-ok" : "tjs-shim-missing"',
    bakeSrc: 'echo "canonical-LE: no regen needed"',
  }),
});
guardTests(consumersGuard);
