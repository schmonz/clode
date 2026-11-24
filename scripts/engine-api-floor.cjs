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
    // Without it fs.utimesSync/lutimesSync could only start the engine's ASYNC utime, so a stat right after one read
    // the old times: a *Sync call that was not synchronous. node-shim now refuses such an engine at the call.
    name: '__tjs_fs_sync.utime',
    expr: 'globalThis.__tjs_fs_sync.utime',
    kind: 'function',
    from: 'txiki-sync-utime.patch',
    why: 'node-shim fs.utimesSync/lutimesSync: the times are set before the call returns, as node sets them (libuv uv_fs_utime/uv_fs_lutime, no callback)',
    buildHost: false,
    notForBuildHost: 'nothing the build runs calls fs.utimesSync or lutimesSync: no caller in scripts/, libexec/ '
      + '(outside node-shim\'s fs.cjs) or build.sh but scripts/lib/rg-probe.cjs, a test probe run under node. On an '
      + 'engine without it node-shim REFUSES the call (ERR_CLODE_ENGINE_FLOOR) and appends it to '
      + 'CLODE_ENGINE_FLOOR_LOG, so the gates listed above refuse a build path that ever reaches it',
  },
  {
    // Without it node-shim has no atomic exclusive create on Windows: the symlink claim + rename it uses on POSIX
    // cannot replace a link or an open file there (CI 44977529851), so every new file would fail.
    name: '__tjs_fs_sync.openFlags',
    expr: 'globalThis.__tjs_fs_sync.openFlags',
    kind: 'string',
    from: 'txiki-sync-open-excl.patch',
    why: 'node-shim\'s exclusive create on Windows: open(O_CREAT|O_EXCL), CreateFile CREATE_NEW, as node\'s \'wx\' is',
    buildHost: false,
    notForBuildHost: 'only Windows uses it; POSIX creates go through the symlink claim, which needs nothing new. A '
      + 'Windows engine without it is ALWAYS REFUSED by name at the first new file (ERR_CLODE_ENGINE_FLOOR), appended to '
      + 'CLODE_ENGINE_FLOOR_LOG, so the gates listed above refuse a build path that reaches it; no Windows leg builds '
      + 'on a bootstrap engine (they stay on node)',
  },
  {
    // Without it node-shim's os.machine() can only guess from process.arch ("x64" where node says "x86_64").
    name: '__tjs_uname',
    expr: 'globalThis.__tjs_uname',
    kind: 'function',
    from: 'txiki-uname-global.patch',
    why: 'node-shim os.machine(): uname\'s machine, as node answers it (libuv uv_os_uname)',
    buildHost: false,
    notForBuildHost: 'nothing the build runs calls os.machine(): no caller in scripts/, libexec/ (outside node-shim\'s '
      + 'os.cjs) or build.sh. On an engine without it node-shim REFUSES the call (ERR_CLODE_ENGINE_FLOOR) and appends '
      + 'it to CLODE_ENGINE_FLOOR_LOG, so the gates listed above refuse a build path that ever reaches it',
  },
  {
    // Without it the engine's fetch/XHR/WebSocket trust their compiled-in roots whatever the caller asks: 2.1.330 blocks
    // four of them (emSign) and passes its own list as setDefaultCACertificates + every fetch's tls.ca, so quaude
    // trusted servers native does not. node-shim refuses tls.setDefaultCACertificates (and so every such fetch) on an
    // engine without it.
    name: '__tjs_set_default_ca',
    expr: 'globalThis.__tjs_set_default_ca',
    kind: 'function',
    from: 'txiki-default-ca.patch',
    why: 'node-shim tls.setDefaultCACertificates: REPLACE the CA set every engine client trusts by default, so fetch\'s tls.ca can be honoured',
    buildHost: false,
    notForBuildHost: 'nothing the build runs calls tls.setDefaultCACertificates or passes a fetch tls option: no caller '
      + 'in scripts/, libexec/ (outside node-shim\'s tls.cjs and bun-shim\'s fetch check, which only the bundle reaches) '
      + 'or build.sh. On an engine without it node-shim REFUSES the call (ERR_CLODE_ENGINE_FLOOR) and appends it to '
      + 'CLODE_ENGINE_FLOOR_LOG, so the gates listed above refuse a build path that ever reaches it',
  },
  {
    // Without it node-shim has no process.resourceUsage(): 2.1.330's event-loop-stall sampler logs "not a function".
    name: '__tjs_getrusage',
    expr: 'globalThis.__tjs_getrusage',
    kind: 'function',
    from: 'txiki-rusage-global.patch',
    why: 'node-shim process.resourceUsage(): libuv uv_getrusage, in node\'s field names and units, as node answers it',
    buildHost: false,
    notForBuildHost: 'nothing the build runs calls process.resourceUsage(): no caller in scripts/, libexec/ (outside '
      + 'node-shim\'s process.cjs) or build.sh. On an engine without it node-shim REFUSES the call '
      + '(ERR_CLODE_ENGINE_FLOOR) and appends it to CLODE_ENGINE_FLOOR_LOG, so the gates listed above refuse a build '
      + 'path that ever reaches it',
  },
  {
    // Without it node-shim has no process.report: 2.1.330's linux agent SDK cannot tell glibc from musl, and
    // platform-tag/clode-update under tjs took a glibc-linked engine for musl.
    name: '__tjs_libc',
    expr: 'globalThis.__tjs_libc',
    kind: 'function',
    from: 'txiki-libc-global.patch',
    why: 'node-shim process.report.getReport().header: glibcVersionRuntime/glibcVersionCompiler, as node answers them '
      + '(gnu_get_libc_version() and __GLIBC__.__GLIBC_MINOR__, absent on any other C library)',
    buildHost: false,
    notForBuildHost: 'the build DOES read process.report (scripts/platform-tag.cjs linuxGlibc(), on linux), but on an '
      + 'engine without __tjs_libc node-shim answers process.report as undefined, exactly what every engine before '
      + '2026-11-23 answered, and refuses nothing: platform-tag takes the branch it always took on the bootstrap engine',
  },
  {
    // Without it node-shim's zlib.*Sync cannot answer: 2.1.330 gzips every first-party event batch with
    // zlib.gzipSync (and Bun.gzipSync), so every batch failed to export and piled up on disk.
    name: '__tjs_zlib_sync',
    expr: 'globalThis.__tjs_zlib_sync',
    kind: 'function',
    from: 'txiki-zlib-sync.patch',
    why: 'node-shim zlib.gzipSync/deflateSync/deflateRawSync/inflateSync/inflateRawSync/gunzipSync/unzipSync: miniz, synchronously, as node answers before the call returns',
    buildHost: false,
    notForBuildHost: 'nothing the build runs on an engine calls a zlib *Sync function: the one caller outside node-shim '
      + 'and bun-shim, scripts/build-templates-manifest.mjs, runs under node in pack.yml and release.yml. On an engine '
      + 'without it node-shim REFUSES the call (ERR_CLODE_ENGINE_FLOOR) and appends it to CLODE_ENGINE_FLOOR_LOG, so '
      + 'the gates listed above refuse a build path that ever reaches it',
  },
  {
    // Without it node-shim has no process.execve: 2.1.330's relaunch (`/tui classic`, `/tui fullscreen`) falls back
    // to spawnSync, and on such an engine that child renders into a pipe -- the dead terminal of 2026-11-22.
    name: '__tjs_execve',
    expr: 'globalThis.__tjs_execve',
    kind: 'function',
    from: 'txiki-sync-spawn.patch',
    why: 'node-shim process.execve(): replace the process image with sane stdio, as node and Bun do (the bundle\'s relaunch)',
    buildHost: false,
    notForBuildHost: 'nothing the build runs calls process.execve(): no caller in scripts/, libexec/ (outside '
      + 'node-shim\'s process.cjs) or build.sh. On an engine without it node-shim REFUSES the call '
      + '(ERR_CLODE_ENGINE_FLOOR) and appends it to CLODE_ENGINE_FLOOR_LOG, so the gates listed above refuse a build '
      + 'path that ever reaches it',
  },
  {
    // Without it every spawnSync slot is a pipe: an 'inherit' child writes into a buffer replayed after it exits.
    name: '__tjs_spawn_sync.stdio',
    expr: 'globalThis.__tjs_spawn_sync.stdio',
    kind: 'boolean',
    from: 'txiki-sync-spawn.patch',
    why: 'node-shim spawnSync stdio \'inherit\'/\'ignore\'/fd: the child gets the parent\'s own fd (a relaunched TUI owns the terminal; no maxBuffer on output it never captures)',
    buildHost: false,
    notForBuildHost: 'the build DOES reach spawnSync with stdio \'inherit\' (scripts/build-tjs.cjs runs every child '
      + 'through execFileSync(cmd, args, {stdio: \'inherit\'})), and on an engine without this node-shim keeps the '
      + 'route every build host ran on from 2026-09-20 to 2026-11-22: capture, then replay the bytes to the parent\'s '
      + 'fd after the child exits. Same bytes, not live; a child printing more than maxBuffer (1 MiB) would be '
      + 'killed there. Measured 2026-11-22 (darwin-arm64): a whole scripts/build-tjs.cjs run, every inherited child '
      + 'included, prints 77 KB. '
      + 'Not logged: it is a working route, not a refusal; test/node-shim-execve.test.cjs pins it on the stand-in',
  },
  {
    // Without it tjs.spawn drops detached/windowsHide/windowsVerbatimArguments/argv0: the Bash tool's detached child
    // led no process group, so its kill(-pid) of the command's tree reached nothing (node-shim options census).
    name: '__tjs_spawn_options',
    expr: 'globalThis.__tjs_spawn_options',
    kind: 'object',
    from: 'txiki-spawn-options.patch',
    why: 'node-shim child_process.spawn detached/windowsHide/windowsVerbatimArguments/argv0, applied by libuv as node applies them',
    buildHost: false,
    notForBuildHost: 'nothing the build runs passes those options to spawn: in scripts/, libexec/ (outside node-shim and '
      + 'bun-shim) and build.sh only libexec/clode-watch.cjs (the update notifier, which no build step runs) passes '
      + 'detached: true, and scripts/apicheck.mjs passes detached: false, which asks for nothing. On an engine without it '
      + 'node-shim REFUSES a caller\'s option by name (ERR_SHIM_UNSUPPORTED_OPTION) and appends it to '
      + 'CLODE_ENGINE_FLOOR_LOG, so the gates listed above refuse a build path that ever reaches it',
  },
  {
    // Without it __tjs_spawn_sync kills a timed-out child with SIGKILL whatever killSignal says, and runs it with the
    // executable as argv[0] whatever argv0 says (POSIX); on Windows it shows the console and re-quotes verbatim args.
    name: '__tjs_spawn_sync.options',
    expr: 'globalThis.__tjs_spawn_sync.options',
    kind: 'object',
    from: 'txiki-spawn-options.patch',
    why: 'node-shim spawnSync killSignal/argv0 (POSIX), windowsHide/windowsVerbatimArguments (Windows)',
    buildHost: false,
    notForBuildHost: 'nothing the build runs passes killSignal, argv0, windowsHide or windowsVerbatimArguments to '
      + 'spawnSync/execFileSync (grep of scripts/, libexec/ outside node-shim, bun-shim and rg-native, and build.sh). '
      + 'On an engine without it node-shim REFUSES a caller\'s option by name (ERR_SHIM_UNSUPPORTED_OPTION) and appends '
      + 'it to CLODE_ENGINE_FLOOR_LOG, so the gates listed above refuse a build path that ever reaches it',
  },
  {
    // Without it the engine cannot route a request through a proxy of the caller's: bun-shim REFUSES Bun's fetch and
    // WebSocket `proxy` by name (2.1.330 passes it on every API request when HTTPS_PROXY & co are set), and fetch
    // falls back to the engine's own reading of the proxy environment (once, at start; CONNECT even for http).
    name: '__tjs_proxy_routes',
    expr: 'globalThis.__tjs_proxy_routes',
    kind: 'object',
    from: 'txiki-fetch-proxy.patch',
    why: 'bun-shim fetch/WebSocket `proxy` and Bun\'s per-request proxy environment: the engine routes each connection '
      + '(absolute-form for http, a CONNECT with the caller\'s header block for https/ws/wss) as bun-shim decides',
    buildHost: false,
    notForBuildHost: 'only bun-shim reads it, and no build step loads bun-shim: the build\'s own fetches '
      + '(libexec/clode-build.cjs, clode-net.cjs, clode-templates.cjs) call the engine\'s fetch directly, with no proxy '
      + 'option, and keep its environment handling unchanged. On an engine without it bun-shim REFUSES an explicit proxy '
      + 'by name (ERR_CLODE_UNSUPPORTED_OPTION), so nothing goes direct in silence',
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
    // Without it a TLS stream's write() takes one record (~16 KiB) and drops the rest in silence: an https POST of
    // 16 KiB or more never finishes (2.1.330's Datadog log flush timed out). node-shim's https client cuts its writes
    // into 8 KiB pieces on such an engine, so it is a working route, and logs each cut.
    name: '__tjs_tls_write_all',
    expr: 'globalThis.__tjs_tls_write_all',
    kind: 'boolean',
    from: 'txiki-tls-write-all.patch',
    why: 'node-shim https: a TLS write sends every byte it was given, as node\'s does (mbedtls_ssl_write looped to the end)',
    buildHost: false,
    notForBuildHost: 'nothing the build runs writes to a tjs.connect(\'tls\') socket: its downloads go through the '
      + 'engine\'s fetch (libexec/clode-net.cjs, clode-build.cjs), which is lws, not mod_tls, and send no body. On an '
      + 'engine without it node-shim\'s https client cuts each TLS write over 8 KiB into pieces one record holds and '
      + 'appends that to CLODE_ENGINE_FLOOR_LOG, so the gates listed above refuse a build path that ever reaches it',
  },
  {
    // Without it every process.env read of an unset name costs a thrown and caught engine Error (~18 us, node 0.35
    // us); 2.1.330 makes thousands, and under load quaude's loop was held past axios's 5 s timers. node-shim keeps the
    // slow read (still right) on such an engine.
    name: '__tjs_getenv',
    expr: 'globalThis.__tjs_getenv',
    kind: 'function',
    from: 'txiki-getenv-global.patch',
    why: 'node-shim process.env reads: an unset name answers undefined without a thrown engine Error, at node\'s cost',
    buildHost: false,
    notForBuildHost: 'the build DOES read process.env, and on an engine without it node-shim reads through tjs.env, '
      + 'the route every build host ran on before this patch: the same answers, only slower. A working route, not a '
      + 'refusal, so it is not logged (the build host reads process.env on every run and would log on every leg); '
      + 'test/node-shim-env-read-cost.test.cjs pins both routes\' answers',
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
