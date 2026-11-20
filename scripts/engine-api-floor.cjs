#!/usr/bin/env node
// ESM was implicitly strict, CommonJS is not: the .mjs -> .cjs rename must not
// silently loosen this file (undeclared globals, block-scoped fn decls). Ruling 2.
'use strict';
// engine-api-floor — ONE list of the engine bindings clode's blobulated runtime
// REQUIRES, and ONE generator for the check that proves an engine has them.
//
// THE BLINDNESS THIS CLOSES. `spike/quickjs/patches/txiki-engine-module-meta.patch`
// has two halves: a C half (src/mod_engine.c, compiled straight from source) and
// a JS half (src/js/core/engine.js, which only reaches the binary through a regen
// of txiki's git-tracked pre-compiled src/bundles/c/**). Every build path that
// runs scripts/build-tjs.cjs regenerates; the netbsd-sparc in-guest bake did not,
// so it shipped an engine with the C function and no JS binding onto it. Nothing
// noticed for a whole leg-lifetime: the engine built, booted, and carved 927s of
// bundle before `graph-meta: this engine does not report moduleMeta` — the LAST
// stage of the longest job in the matrix.
//
// The three existing engine sanity checks (build-tjs.cjs's post-build smoke,
// .github/actions/build-leg's host-exec smoke, ci-guest-bake.sh's ENGINE SANITY)
// were three hand-written copies of `typeof __tjs_fs_sync === "object"`, and not
// one of them knew about moduleMeta. Three copies of a list is the disease this
// repo keeps paying for, so there is now one list, here, and the three consumers
// generate their check from it.
//
// WHAT BELONGS HERE. A binding whose ABSENCE makes a blobulated quaude fail — not
// every nicety. Each entry names the patch that provides it, so a failure points
// at the build step that dropped it rather than at the symptom.
//
// NO NODE-ONLY ANYTHING IN HERE. This used to say "dev/CI tooling only, nothing on
// the `clode build` path imports this". That stopped being true when the build grew
// its own front-door capability gate (libexec/clode-build.cjs, spec 2026-09-14 §7.2):
// it requires this file to generate the probe it runs against the host engine, and
// esbuild inlines it into the clode-main bundle. So the constraint the old sentence
// was PROTECTING is now stricter, not gone — quaude must keep building on a host with
// no node at all, and a blobulated clode runs this module under tjs's node-shim. Pure
// stdlib and plain data: no npm, no child_process, nothing that only real node has.
// What it EMITS is likewise plain JS text that a bare tjs runs.

// kind: 'function' | 'object' | 'bigint' -- any `typeof` answer, compared
// exactly ('bigint' is the sync stat's ino); an 'object' entry also rejects
// null, which `typeof` alone would happily call an object.
//
// TWO ROLES, ONE LIST. An engine plays one of two parts, and they need different things:
//   'runtime'  the engine quaude SHIPS on (the blobulated template). Held to EVERY entry --
//              this is the floor build-tjs.cjs's post-build smoke, build-leg's host-exec
//              smoke, the guest bake and `clode build`'s front door all check, and it is
//              what every generator below produces when no role is named.
//   'build-host'  an engine that only HOSTS HEAD's build tooling: the one
//              scripts/bootstrap-engine.sh resolves -- in CI, the LAST release's. What runs
//              on it: build.sh's in-process build-runner/build-graph, build-tjs.cjs's three engine
//              phases (via build-tjs-boot.sh), and libexec/graph-meta.js (upstream-drift.yml's carve-probe
//              and regexp census). The root step's blobulate is NOT on it: stage0 runs under node, with the
//              BUILT engine as its template, and clode build's front door holds that template to 'runtime'
//              (an engine named by CLODE_TJS becomes the template, so a stale one is refused there).
//              It needs every entry whose `buildHost` is true. An entry with `buildHost: false` must say why
//              the build never reaches it, MEASURED, in `notForBuildHost`; test/engine-api-floor.test.cjs
//              refuses one that does not. WHAT IS GATED, and where:
//                * every leg, on the REAL bootstrap engine: the engine phases that run on the runner
//                  (source, regen, native and NetBSD-cross compile) -- build-leg fails on a non-empty
//                  CLODE_ENGINE_FLOOR_LOG (libexec/node-shim/internal/engine-floor-log.cjs);
//                * every push, on a stand-in: `./build.sh --plan` (resolver acceptance + graph PLANNING
//                  only, not a step's input/output checks) and graph-meta.js (test/node-shim-build-host);
//                * where a warm checkout exists, on a stand-in: source and regen, compile opt-in
//                  (test/build-host-stale-engine);
//                * measured ONCE by hand (2026-11-18), not gated: the whole ./build.sh root graph,
//                  including every step's input/output checks, on the stand-in -- nothing refused.
//              Anything new that runs on this engine is unmeasured until one of those covers it.
// The split exists because without it the bootstrap's floor was the shipped engine's, and
// the first engine patch after a release made every leg red with "cut a release" as the
// remedy -- while release.yml builds its engines through that same refusal (CI run
// 44443821699). The engine a build host BUILDS is still held to 'runtime' by the four checks
// above, so nothing ships on less than the full floor.
const ENGINE_API_FLOOR = [
  {
    name: '__tjs_fs_sync',
    expr: 'globalThis.__tjs_fs_sync',
    kind: 'object',
    from: 'txiki-sync-fs.patch',
    why: 'node-shim fs.*Sync — every synchronous file read the bundle makes',
    buildHost: true,
  },
  {
    // An engine without it boots and runs, and node-shim's Stats then had dev, ino and rdev 0
    // for every path: two files with one identity, every character device /dev/null. Now
    // node-shim refuses such an engine at its first stat, and this refuses it at build time.
    name: '__tjs_fs_sync.stat identity',
    expr: 'globalThis.__tjs_fs_sync.stat(".").ino',
    kind: 'bigint',
    from: 'txiki-sync-stat-identity.patch',
    why: 'node-shim Stats/BigIntStats: dev, ino, rdev, nlink and nanosecond times from libuv\'s uv_stat_t (file identity)',
    buildHost: false,
    notForBuildHost: 'node-shim gives an engine without it a Stats carrying only mode and size, which such an engine '
      + 'reports exactly, and refuses (ERR_CLODE_ENGINE_FLOOR) a read of any other field rather than inventing it. '
      + 'Measured 2026-11-18 on the v0.20260831.1 macos-arm64 slice: --source-only, --regen-only and --build-only '
      + 'read `mode` and no other Stats field (copyFileSync\'s executable bit, rmSync, findTool\'s isExecutableFile); '
      + 'libexec/graph-meta.js and the whole ./build.sh root graph (once, by hand) refuse nothing on a stand-in for that '
      + 'engine. Gated: build-leg\'s CLODE_ENGINE_FLOOR_LOG on the real engine; the stand-in rows listed above',
  },
  {
    // Without it quaude's rg falls back to libuv's error table, whose texts are not the OS's (ELOOP, ENAMETOOLONG,
    // an errno libuv cannot name): stderr unlike native rg's, which prints its libc's strerror.
    name: '__tjs_fs_sync.strerror',
    expr: 'globalThis.__tjs_fs_sync.strerror',
    kind: 'function',
    from: 'txiki-strerror.patch',
    why: 'quaude\'s rg error texts: the platform C library\'s strerror(3), as rg prints them (rg-native.cjs osErrorText)',
    buildHost: false,
    notForBuildHost: 'only quaude\'s rg (libexec/rg-native.cjs) calls it, and without it rg falls back to libuv\'s error '
      + 'table: text, never control flow. Nothing in the build runs rg; that fallback appends to CLODE_ENGINE_FLOOR_LOG, '
      + 'so the gates listed above refuse a build path that reaches it',
  },
  {
    // Without it node-shim's Timeout#unref STOPS the timer (the old route), so an unref'd timer never fires while
    // the loop stays alive: the TUI's nonblocking stdout then holds a turn's answer until the next keystroke.
    name: '__tjs_timer_setref',
    expr: 'globalThis.__tjs_timer_setref',
    kind: 'function',
    from: 'txiki-timer-ref-global.patch',
    why: 'node-shim Timeout#unref/ref: a real uv_unref, so an unref\'d timer still fires while other work keeps the loop alive (loader.cjs TIMER-UNREF-STILL-FIRES)',
    buildHost: false,
    notForBuildHost: 'without it node-shim keeps the old route (unref stops the timer, ref re-arms it), the one every '
      + 'build host ran on before this patch, and appends each such unref to CLODE_ENGINE_FLOOR_LOG, so the gates '
      + 'listed above refuse a build path that reaches it. Measured 2026-11-20 (darwin-arm64) on the stand-in with '
      + 'the binding removed (test/fixtures/stale-engine-prelude.js): source and regen, ./build.sh --plan and '
      + 'libexec/graph-meta.js log nothing, and the same stand-in logs an unref\'d timer in a three-line program',
  },
  {
    name: '__tjs_spawn_sync',
    expr: 'globalThis.__tjs_spawn_sync',
    kind: 'function',
    from: 'txiki-sync-spawn.patch',
    why: 'node-shim child_process.spawnSync/execFileSync — Bash, git, every stdio MCP',
    buildHost: true,
  },
  {
    name: 'tjs.engine.moduleMeta',
    expr: 'globalThis.tjs.engine.moduleMeta',
    kind: 'function',
    from: 'txiki-engine-module-meta.patch (JS half: src/js/core/engine.js — needs a src/bundles/c/** REGEN, not just a compile)',
    why: "quaude-blobulate's cyclic-group merge, which needs each module's real top-level bindings",
    buildHost: true,
  },
];

const ROLES = ['runtime', 'build-host'];
function floorFor(role = 'runtime') {
  if (role === 'runtime') return ENGINE_API_FLOOR;
  if (role === 'build-host') return ENGINE_API_FLOOR.filter((b) => b.buildHost === true);
  throw new Error(`engine-api-floor: unknown role '${role}' (one of: ${ROLES.join(', ')})`);
}

// The success token. Deliberately the one the three call sites already printed
// and compared, so this change is a widening of what is checked and not a new
// protocol for the callers to get subtly wrong.
const OK_TOKEN = 'tjs-shim-ok';

// The check, as JS statements a bare tjs can run. It PRINTS its verdict (so a
// caller that captures stdout can name the missing binding) and THEN throws when
// something is missing (so a caller that only has an exit status still goes red).
// Both matter: build-tjs.cjs compares the string, ci-guest-bake.sh's driver gates
// on `<phase>-exit=0`.
function engineFloorCheckStatements(floor = ENGINE_API_FLOOR) {
  const probe = "const P=(f)=>{try{return f()}catch(e){return undefined}};const M=[];";
  const one = ({ name, expr, kind }) => {
    const v = `P(()=>${expr})`;
    const bad = kind === 'object'
      ? `(typeof ${v}!=='object'|| ${v}===null)`
      : `typeof ${v}!=='${kind}'`;
    return `if(${bad})M.push(${JSON.stringify(`${name} (${kind})`)});`;
  };
  const verdict = `if(M.length){console.log('MISSING-ENGINE-API: '+M.join(', '));`
    + `throw new Error('engine-api-floor: this engine is missing '+M.length+' required binding(s): '+M.join(', '))}`
    + `console.log(${JSON.stringify(OK_TOKEN)});`;
  return probe + floor.map(one).join('') + verdict;
}

// A single argv-safe line, for `tjs eval <js>`.
function engineFloorCheckJs(floor = ENGINE_API_FLOOR) {
  return engineFloorCheckStatements(floor);
}

// A standalone file, for `tjs run <file>` (the guest bake, which fetches it over
// the same served workspace as its source tarballs).
function engineFloorCheckFile(floor = ENGINE_API_FLOOR) {
  const header = [
    '// GENERATED by scripts/engine-api-floor.cjs --emit-check — do not edit.',
    '// Proves a freshly built tjs carries every binding clode\'s blobulated runtime needs.',
    ...floor.map((b) => `//   ${b.name} (${b.kind}) <- ${b.from}: ${b.why}`),
  ].join('\n');
  return `${header}\n${engineFloorCheckStatements(floor)}\n`;
}

// `--role build-host` is spelled out by its one caller (scripts/bootstrap-engine.sh); no role is
// the full 'runtime' floor, so every other consumer stays on it without saying anything.
function main(argv) {
  const usage = () => { process.stderr.write('usage: engine-api-floor.cjs [--emit-check|--emit-eval|--list] [--role runtime|build-host]\n'); process.exit(2); };
  const mode = argv[0] || '--emit-check';
  let role = 'runtime';
  if (argv.length > 1) {
    if (argv.length !== 3 || argv[1] !== '--role' || !ROLES.includes(argv[2])) usage();
    role = argv[2];
  }
  const floor = floorFor(role);
  if (mode === '--emit-check') process.stdout.write(engineFloorCheckFile(floor));
  else if (mode === '--emit-eval') process.stdout.write(engineFloorCheckJs(floor) + '\n');
  else if (mode === '--list') process.stdout.write(floor.map((b) => `${b.name}\t${b.kind}\t${b.from}`).join('\n') + '\n');
  else usage();
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { ENGINE_API_FLOOR, ROLES, floorFor, OK_TOKEN, engineFloorCheckStatements, engineFloorCheckJs, engineFloorCheckFile };
