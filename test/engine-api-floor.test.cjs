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

test('the real floor passes on a locally built engine (skipped if none)', async () => {
  const { engineFloorCheckFile, OK_TOKEN } = await load();
  const candidates = fs.existsSync(path.join(repo, 'build/tjs'))
    ? fs.readdirSync(path.join(repo, 'build/tjs')).map((d) => path.join(repo, 'build/tjs', d, 'tjs'))
    : [];
  const engine = candidates.find((p) => fs.existsSync(p) && !fs.statSync(p).isDirectory());
  if (!engine) return; // no locally built engine on this box — CI's host-exec smoke covers it
  const f = path.join(require('node:os').tmpdir(), `floor-engine-${process.pid}.js`);
  fs.writeFileSync(f, engineFloorCheckFile());
  try {
    assert.strictEqual(execFileSync(engine, ['run', f], { encoding: 'utf8' }).trim(), OK_TOKEN);
  } finally { fs.unlinkSync(f); }
});

// ---- every consumer GENERATES its check; none hand-writes one -------------

test('build-tjs.mjs smoke: generated from the floor, not an inline typeof', () => {
  const src = read(BUILD_TJS);
  assert.match(src, /import \{ engineFloorCheckJs, OK_TOKEN \} from '\.\/engine-api-floor\.mjs';/);
  assert.match(src, /const evalArgs = \['eval', engineFloorCheckJs\(\)\];/);
  assert.doesNotMatch(src, /typeof __tjs_fs_sync === "object" \? "tjs-shim-ok"/,
    'the inline copy of the engine check is back in build-tjs.mjs');
});

test('build-leg host-exec smoke: generated from the floor, not an inline typeof', () => {
  const yml = read(ACTION);
  assert.match(yml, /node scripts\/engine-api-floor\.mjs --emit-check > "\$RUNNER_TEMP\/engine-api-floor\.js"/);
  assert.doesNotMatch(yml, /typeof __tjs_fs_sync === "object" \? "tjs-shim-ok"/,
    'the inline copy of the engine check is back in build-leg/action.yml');
});

test('the guest bake runs the SHARED floor check, and the runner stages it', () => {
  const bake = read(BAKE);
  assert.match(bake, /f1 engine-api-floor\.js "\$S\/engine-api-floor\.js"/,
    'the bake must fetch the generated floor check from the served workspace');
  assert.match(bake, /\$TJS run "\$W\/engine-api-floor\.js"/);
  assert.match(bake, /echo "cle-floor-exit=\$\?"/,
    'the driver gates on <phase>-exit=0 markers — the floor check needs one or it is decorative');
  assert.doesNotMatch(bake, /typeof __tjs_spawn_sync/,
    'the bake is back to hand-writing its own engine sanity list');
  const yml = read(ACTION);
  assert.match(yml, /node scripts\/engine-api-floor\.mjs --emit-check > \.matrix\/qemu-bake\/engine-api-floor\.js/);
});

// ---- the bake compiles a COMPLETE tree; it never generates one ------------

test('the runner regenerates the guest tree before tarring it', () => {
  const yml = read(ACTION);
  const idx = yml.indexOf('tar czf .matrix/qemu-bake/txiki-canonical-le.tar.gz');
  assert.ok(idx > -1, 'the guest source tarball step was not found');
  const before = yml.slice(0, idx);
  assert.match(before.slice(-2000), /node scripts\/build-tjs\.mjs --regen-only/,
    'the tree must be bytecode-regenerated BEFORE it is tarred for the guest');
});

test('the guest bake refuses a tree that was never regenerated', () => {
  const bake = read(BAKE);
  assert.match(bake, /clode:bytecode-regen/,
    'the bake must demand the regen fingerprint trailer build-tjs.mjs stamps');
  assert.match(bake, /cle-regen-present=/,
    'the guard needs a marker so the console says which check failed');
  assert.match(bake, /bake-exit=1/);
  assert.doesNotMatch(bake, /canonical-LE: no regen needed/,
    'the claim that started all this must not survive the fix');
});
