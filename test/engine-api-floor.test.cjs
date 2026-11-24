'use strict';
// The engine API floor (scripts/engine-api-floor.cjs) and its three consumers.
//
// WHAT WENT WRONG. patches/txiki-engine-module-meta.patch has a C half
// (src/mod_engine.c) and a JS half (src/js/core/engine.js). The JS half reaches
// a binary only through a regen of txiki's git-tracked pre-compiled
// src/bundles/c/**. Every build path runs that regen from scripts/build-tjs.cjs
// — except the netbsd-sparc in-guest bake, which drives cmake by hand inside a
// 512MB sun4m guest with no node and skipped it ("canonical-LE: no regen
// needed"). So that leg shipped an engine with the C function and no binding
// onto it, and nothing said so until `quaude-blobulate: this engine does not report
// moduleMeta` — 927 seconds into the carve, at the last stage of the longest job
// in the matrix.
//
// Three separate engine sanity checks existed at the time (build-tjs.cjs's
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
const FLOOR_CJS = 'scripts/engine-api-floor.cjs';
const BAKE = 'spike/quickjs/qemu/ci-guest-bake.sh';
const ACTION = '.github/actions/build-leg/action.yml';
const BUILD_TJS = 'scripts/build-tjs.cjs';
const CLODE_BUILD = 'libexec/clode-build.cjs';
const BOOTSTRAP_SH = 'scripts/bootstrap-engine.sh';

// EVERY SPELLING OF "somebody regenerates the bytecode here", because the INVOCATION keeps
// moving and this rule must not move with it in either direction. What the rule below is
// about is that SOMETHING regenerates before the guest tarball is made; WHO interprets
// scripts/build-tjs.cjs is not its question. Matching only yesterday's spelling reads a
// correct change as a dropped regen -- that happened on 2026-09-20, when the site flipped
// onto scripts/build-tjs-boot.sh -- and dropping the rule, or widening it to "anything at
// all", would be the blind gate this whole file exists to prevent. So the list is CLOSED,
// and each entry is a real idiom this repo uses:
//   1. `node scripts/build-tjs.cjs --regen-only`             the original
//   2. `scripts/build-tjs-boot.sh <site> --regen-only`       under a bootstrap engine
//   3. `./build.sh --only <id>` (or the runner directly)     naming the GRAPH step
// The id in (3) and the entry point's filename are NOT written here. They are read out of
// scripts/build-graph.cjs -- the id being that of the step whose run() carries
// --regen-only, the filename being ENTRY_REL -- so renaming either moves this rule with it
// instead of turning a rename into a gate that silently matches nothing.
function regenSpellings(stepId, entryRel) {
  const out = [/(node scripts\/build-tjs\.cjs|scripts\/build-tjs-boot\.sh \S+) --regen-only/];
  if (stepId && entryRel) {
    const q = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out.push(new RegExp(`(build-runner\\.cjs|${q(entryRel)}) [^\\n]*--only[= ]${q(stepId)}`));
  }
  return out;
}

// The graph's own answer to "which step regenerates the bytecode", derived rather than
// transcribed, for the reason scripts/build-graph.cjs gives about every other list in it.
function graphRegen() {
  const G = require(path.join(repo, 'scripts/build-graph.cjs'));
  const s = G.steps().find((st) => typeof st.run === 'function' && /--regen-only/.test(String(st.run)));
  return { regenStepId: s ? s.id : '', entryRel: G.ENTRY_REL };
}
// engine-api-floor is CJS now: a plain require, no pathToFileURL/import() detour.
const load = async () => require(path.join(repo, FLOOR_CJS));

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
  // An engine whose sync stat has no identity boots fine and gives every file ino 0.
  const id = ENGINE_API_FLOOR.find((b) => b.name === '__tjs_fs_sync.stat identity');
  assert.ok(id, 'the sync stat\'s file identity is not in the floor');
  assert.strictEqual(id.kind, 'bigint');
  assert.match(id.from, /txiki-sync-stat-identity\.patch/);
});

// TWO ROLES (scripts/engine-api-floor.cjs's header): the engine quaude ships on ('runtime',
// every entry) and an engine that only hosts the build ('build-host'). The split is only honest
// if each entry SAYS which it is and an exemption carries its measured reason; an entry that
// does not say is a finding, not a default.
test('every floor entry declares its build-host role, and every build-host exemption says why', async () => {
  const { ENGINE_API_FLOOR, floorFor, ROLES } = await load();
  assert.deepStrictEqual(ROLES, ['runtime', 'build-host']);
  for (const b of ENGINE_API_FLOOR) {
    assert.strictEqual(typeof b.buildHost, 'boolean', `${b.name}: no \`buildHost: true|false\` -- an undeclared role is a guess`);
    if (b.buildHost) assert.strictEqual(b.notForBuildHost, undefined, `${b.name}: a build-host entry carries no exemption`);
    else assert.ok(typeof b.notForBuildHost === 'string' && b.notForBuildHost.length > 80, `${b.name}: a build-host exemption needs its MEASURED reason`);
  }
  // runtime IS the whole list -- the same array, so a shipped-engine check cannot drift from it.
  assert.strictEqual(floorFor(), ENGINE_API_FLOOR);
  assert.strictEqual(floorFor('runtime'), ENGINE_API_FLOOR);
  // Today's build-host exemptions, by name: widening this set is a decision, so it is a diff here.
  // __tjs_fs_sync.utime (2026-11-21, ruling: a *Sync that is not synchronous is a product bug): the last release's
  // engine, which CI bootstraps the build on, has none, and no build step sets times; the call is refused, not faked.
  // __tjs_fs_sync.openFlags (2026-11-22): Windows only (the exclusive create); POSIX needs nothing new, and a Windows
  // engine without it is always refused at the first new file; no Windows leg builds on a bootstrap engine.
  // __tjs_uname (2026-11-21): the same, for os.machine(), which no build step calls.
  // __tjs_getrusage (2026-11-21): the same, for process.resourceUsage(), which no build step calls (grepped: no caller
  // in scripts/, libexec/ outside node-shim, or build.sh); only the bundle's event-loop-stall sampler does.
  // __tjs_zlib_sync (2026-11-23): the same, for zlib's *Sync functions; their one caller outside the shims,
  // scripts/build-templates-manifest.mjs, runs under node.
  // __tjs_set_default_ca (2026-11-23): tls.setDefaultCACertificates, which only the bundle's CA loader calls; refused
  // (ERR_CLODE_ENGINE_FLOOR), never faked, on an engine without it.
  // __tjs_execve (2026-11-22): the same, for process.execve(), which no build step calls.
  // __tjs_spawn_sync.stdio (2026-11-22): the build DOES spawn with stdio 'inherit'; without it the shim keeps the
  // capture-and-replay route every build host already ran on (same bytes, not live), so it is not a refusal.
  // __tjs_libc (2026-11-23): the build DOES read process.report (platform-tag on linux); without it the shim answers
  // undefined, what every engine before it answered, so the bootstrap engine takes the branch it always took.
  assert.deepStrictEqual(ENGINE_API_FLOOR.filter((b) => !b.buildHost).map((b) => b.name),
    ['__tjs_fs_sync.stat identity', '__tjs_fs_sync.strerror', '__tjs_fs_sync.utime', '__tjs_fs_sync.openFlags', '__tjs_uname', '__tjs_set_default_ca', '__tjs_getrusage',
      '__tjs_libc', '__tjs_zlib_sync', '__tjs_execve', '__tjs_spawn_sync.stdio', '__tjs_timer_setref']);
  assert.deepStrictEqual(floorFor('build-host').map((b) => b.name), ['__tjs_fs_sync', '__tjs_spawn_sync', 'tjs.engine.moduleMeta']);
  assert.throws(() => floorFor('shipped'), /unknown role/);
});

test('the CLI: no role is the full floor; --role build-host is the build-host floor; anything else is refused', () => {
  const run = (...a) => execFileSync(process.execPath, [path.join(repo, FLOOR_CJS), ...a], { encoding: 'utf8' });
  const { ENGINE_API_FLOOR, floorFor } = require(path.join(repo, FLOOR_CJS));
  assert.strictEqual(run('--list').trim().split('\n').length, ENGINE_API_FLOOR.length);
  assert.strictEqual(run('--list', '--role', 'runtime'), run('--list'));
  assert.strictEqual(run('--list', '--role', 'build-host').trim().split('\n').length, floorFor('build-host').length);
  assert.match(run('--emit-check'), /stat\(".*"\)\.ino/);
  assert.doesNotMatch(run('--emit-check', '--role', 'build-host'), /\.ino|strerror/);
  for (const bad of [['--role', 'shipped'], ['--role'], ['--bogus']]) {
    assert.throws(() => execFileSync(process.execPath, [path.join(repo, FLOOR_CJS), '--emit-check', ...bad], { stdio: 'pipe' }),
      (e) => e.status === 2, `--emit-check ${bad.join(' ')} must be a usage error`);
  }
});

test('the generated check reports OK, and on a miss names the binding AND exits nonzero', async () => {
  const { engineFloorCheckFile, OK_TOKEN } = await load();
  // Both halves matter: build-tjs.cjs compares the printed token, and
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
// already-read files (build-tjs.cjs, the build-leg action, the guest bake script).
function scanEngineFloorConsumers({ buildTjsSrc, actionYml, bakeSrc, clodeBuildSrc, bootstrapSh,
  regenStepId, entryRel }) {
  const findings = [];
  let examined = 0;

  examined++;
  if (!/const \{ engineFloorCheckJs, OK_TOKEN \} = require\('\.\/engine-api-floor\.cjs'\);/.test(buildTjsSrc)) {
    findings.push('build-tjs.cjs no longer requires its smoke check from engine-api-floor.cjs');
  }
  examined++;
  if (!/const evalArgs = \['eval', engineFloorCheckJs\(\)\];/.test(buildTjsSrc)) {
    findings.push('build-tjs.cjs no longer generates its eval args from engineFloorCheckJs()');
  }
  examined++;
  if (/typeof __tjs_fs_sync === "object" \? "tjs-shim-ok"/.test(buildTjsSrc)) {
    findings.push('the inline copy of the engine check is back in build-tjs.cjs');
  }

  examined++;
  if (!/node scripts\/engine-api-floor\.cjs --emit-check > "\$RUNNER_TEMP\/engine-api-floor\.js"/.test(actionYml)) {
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
  if (!/node scripts\/engine-api-floor\.cjs --emit-check > \.matrix\/qemu-bake\/engine-api-floor\.js/.test(actionYml)) {
    findings.push('the runner no longer stages the generated floor check for the guest bake');
  }

  examined++;
  {
    const idx = actionYml.indexOf('tar czf .matrix/qemu-bake/txiki-canonical-le.tar.gz');
    if (idx === -1) {
      findings.push('the guest source tarball step was not found in build-leg/action.yml');
      // ANY OF THE THREE SPELLINGS, in the 2000 characters before the tar. See
      // regenSpellings() above for what the list is and why it is closed.
    } else if (!regenSpellings(regenStepId, entryRel)
      .some((re) => re.test(actionYml.slice(0, idx).slice(-2000)))) {
      findings.push('the guest tree must be bytecode-regenerated BEFORE it is tarred for the guest');
    }
  }

  examined++;
  // "fingerprint" was the pre-4c-2 name and it is now WRONG in the one place a
  // reader meets it: this string is what prints when the gate fires. The trailer
  // carries no hash any more — freshness became the cmake DEPENDS edge, and
  // ci-guest-bake.sh's own comment says "do not put the hash back". A finding
  // that names a mechanism the tree no longer has sends the reader looking for
  // it.
  if (!/clode:bytecode-regen/.test(bakeSrc)) findings.push('the bake no longer demands the hash-free clode:bytecode-regen PROVENANCE trailer build-tjs.cjs stamps (not a fingerprint: it answers "did anybody regenerate this tree at all", the one question the guest cannot answer for itself)');
  examined++;
  if (!/cle-regen-present=/.test(bakeSrc)) findings.push('the regen-present marker is gone (the console can no longer say which check failed)');
  examined++;
  if (!/bake-exit=1/.test(bakeSrc)) findings.push('the bake no longer has a bake-exit=1 failure marker');
  examined++;
  if (/canonical-LE: no regen needed/.test(bakeSrc)) {
    findings.push('the claim that started this whole guard ("canonical-LE: no regen needed") is back');
  }

  // THE FOURTH CONSUMER, added for spec 2026-09-14 §7.2: `clode build`'s own front door.
  // Everything above catches an engine that was BUILT wrong; this catches one that was
  // RESOLVED wrong, which is the failure that cost two agents a chase apiece (default
  // template resolution landing on a pre-2026-08-29 engine, surfacing ~900s later as
  // `graph-meta: this engine does not report moduleMeta`). It is a consumer on exactly
  // the same terms as the other three, so it is guarded on exactly the same terms:
  // it must GENERATE its probe from the one list, never carry a second copy.
  examined++;
  if (!/require\('\.\.\/scripts\/engine-api-floor\.cjs'\)/.test(clodeBuildSrc)) {
    findings.push('clode build no longer gets its engine capability gate from engine-api-floor.cjs');
  }
  examined++;
  // The CALL SITE, pinned exactly as build-tjs.cjs's is: a bare `engineFloorCheckJs()` anywhere in
  // the file (a comment, an unused line) must not stand in for the probe the template is held to.
  if (!/spawnSync\(template, \['eval', engineFloorCheckJs\(\)\]/.test(clodeBuildSrc)) {
    findings.push('clode build no longer GENERATES its template probe from the full floor (spawnSync(template, [\'eval\', engineFloorCheckJs()]))');
  }
  examined++;
  if (!/OK_TOKEN/.test(clodeBuildSrc)) {
    findings.push('clode build no longer compares the floor\'s own success token');
  }
  examined++;
  if (/moduleMeta/.test(clodeBuildSrc) && !/graph-meta/.test(clodeBuildSrc)) {
    findings.push('clode build has grown its own hand-written binding name — that is the second list this file exists to prevent');
  }

  // THE TWO ROLES. Exactly one consumer may take the build-host floor -- the bootstrap resolver,
  // whose engine hosts the build and never ships -- and every consumer that judges an engine
  // quaude WILL ship on must take the full one. A build-host role leaking into one of those is
  // the shipped engine quietly losing its floor.
  examined++;
  if (!/engine-api-floor\.cjs" --emit-check --role build-host >/.test(bootstrapSh)) {
    findings.push('scripts/bootstrap-engine.sh no longer accepts on the BUILD-HOST floor -- held to the runtime one, '
      + 'the first engine patch after a release makes every leg red and "cut a release" circular (CI run 44443821699)');
  }
  examined++;
  {
    const leaks = [['scripts/build-tjs.cjs', buildTjsSrc], ['build-leg/action.yml', actionYml],
      ['the guest bake', bakeSrc], ['libexec/clode-build.cjs', clodeBuildSrc]]
      // A role flag, the role helper, or ANY argument to a generator (a hand-filtered list --
      // `engineFloorCheckJs(ENGINE_API_FLOOR.filter(...))` -- is a role by another name).
      .filter(([, src]) => /--role|floorFor\(|engineFloorCheck(?:Js|File|Statements)\((?!\))/.test(src)).map(([n]) => n);
    if (leaks.length) findings.push(`a shipped-engine floor check names a role or narrows the list (${leaks.join(', ')}): those must take the FULL floor, i.e. no argument at all`);
  }

  return { findings, examined };
}

const consumersGuard = defineGuard({
  name: 'engine-api-floor-consumers',
  // 19 fixed presence/absence checks (examined++ once per check, unconditionally). The
  // floor is the EXACT count ON PURPOSE (fix round 2, coordinator correction): floor is a
  // MINIMUM, so legitimate growth only ever raises `examined` above it — there is no
  // headroom to leave below the real count. Losing even ONE check from
  // scanEngineFloorConsumers is supposed to report BROKEN. A legitimate retirement drops
  // `examined`, this fires, and a human lowers the floor deliberately — that is the
  // intended path, not a bug.
  floor: 21,
  read: () => Object.assign({
    buildTjsSrc: read(BUILD_TJS),
    actionYml: read(ACTION),
    bakeSrc: read(BAKE),
    clodeBuildSrc: read(CLODE_BUILD),
    bootstrapSh: read(BOOTSTRAP_SH),
  }, graphRegen()),
  scan: scanEngineFloorConsumers,
  // Models the exact regression this guard exists to catch: every consumer back
  // to a hand-written inline check, and the guest bake's "no regen needed" claim
  // (the one that cost the sparc leg two days) reintroduced.
  control: () => ({
    buildTjsSrc: 'typeof __tjs_fs_sync === "object" ? "tjs-shim-ok" : "tjs-shim-missing"; engineFloorCheckJs(floorFor(\'build-host\'))',
    actionYml: 'typeof __tjs_fs_sync === "object" ? "tjs-shim-ok" : "tjs-shim-missing"',
    bakeSrc: 'echo "canonical-LE: no regen needed"',
    // The build back to no engine gate at all: the door with the hole in it.
    clodeBuildSrc: '// no engine capability gate here',
    // The bootstrap back on the runtime floor, and the build-host role leaked into a shipped check.
    bootstrapSh: '"$REPO/scripts/engine-api-floor.cjs" --emit-check > "$TMP/floor.js"',
    // The graph's REAL answers, so the control's regen finding comes from the yaml having
    // no regen in any spelling -- not from the derivation having been fed a blank.
    ...graphRegen(),
  }),
});
guardTests(consumersGuard);

// The narrowing the review named: clode build's template probe handed a hand-filtered list. The
// real sources must be clean, and that one-line change must be a finding on BOTH checks above.
test('a narrowed shipped-engine probe in clode build is a finding, not a pass', () => {
  const real = consumersGuard.read();
  assert.deepStrictEqual(scanEngineFloorConsumers(real).findings, []);
  const narrowed = real.clodeBuildSrc.replace("spawnSync(template, ['eval', engineFloorCheckJs()]",
    "spawnSync(template, ['eval', engineFloorCheckJs(ENGINE_API_FLOOR.filter((b) => b.buildHost))]");
  assert.notStrictEqual(narrowed, real.clodeBuildSrc, 'the call site moved: re-point this test at it');
  const f = scanEngineFloorConsumers({ ...real, clodeBuildSrc: narrowed }).findings;
  assert.ok(f.some((x) => /template probe from the full floor/.test(x)), f.join('\n'));
  assert.ok(f.some((x) => /narrows the list \([^)]*clode-build/.test(x)), f.join('\n'));
});
