'use strict';
// clode-main — the JS launcher spine. Ports bin/clode's main() control flow
// (bin/clode:549) faithfully, wiring the already-built sub-modules into a complete
// launcher. Entry is bin/clode (an ES5-safe prologue that require()s this and
// calls main()). This module runs on modern Node (>= MIN_NODE_MAJOR); the prologue
// guarantees that before it loads us.
//
// Dispatch order (exact, from main()):
//   1. strip --clode-verbose from argv (any position) -> CLODE_VERBOSE=1
//   2. resolve SELF / HERE / LIBEXEC / CLODE_SELF_VERSION
//   3. --clode-version         -> print "clode <VERSION>", exit 0
//   4. --clode-help            -> print clodeHelp(), exit 0
//   5. update [channel]        -> clodeUpdate, exit status
//   6. --clode-internal-update -> clodeUpdate, exit status
//   6b. build [--out PATH]     -> clodeBuild (fuse a quaude), exit status
//   7. --clode-watch           -> clodeWatch(manual), exit 0
//   8. default launch          -> require_node, resolve/extract/deps, watcher, run
//
// Pure Node stdlib + sibling .cjs requires (the sub-modules pull the ext-deps).

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const hosttools = require('./clode-hosttools.cjs');
const resolve = require('./clode-resolve.cjs');
const extract = require('./clode-extract.cjs');
const deps = require('./clode-deps.cjs');
const update = require('./clode-update.cjs');
const watch = require('./clode-watch.cjs');
const run = require('./clode-run.cjs');
const { clodeCacheDir, depsStore } = require('./clode-paths.cjs');

// clode's own help (clode-specific flags only — `clode --help` still passes
// through to Claude Code). Byte-for-byte the sh clode_help heredoc, version
// interpolated. Ends with a trailing newline (like the heredoc).
function clodeHelp(version) {
  return `clode ${version} — run the latest Claude Code under a host Node, no Bun runtime.

Usage:
  clode [clode-options] [claude args...]   launch Claude Code (args pass through)
  clode update [channel|version]           fetch a fresh upstream provider, then exit
  clode build [--out PATH]                 fuse a standalone quaude binary (the pinned
                                           tjs runtime + the compiled Claude Code
                                           bundle) on this machine; default ./quaude

clode-specific options (consumed by clode; everything else goes to Claude Code):
  --clode-help        show this help and exit
  --clode-version     print clode's own version and exit
  --clode-verbose     show clode's progress (extract/deps/etc.); silent by default,
                      so a normal launch emits only Claude Code's own output
  --clode-watch       run one update-signal check now (newer version + signals
                      that bear on running under Node), print a summary, and exit

Key environment overrides:
  CLODE_VERBOSE=1     same as --clode-verbose
  CLODE_NO_WATCH=1    disable the opportunistic on-launch update-signal check
  CLODE_CLAUDE_BIN    upstream claude binary to extract from
  CLODE_NODE          host node
  CLODE_CACHE         extracted-bundle cache dir
  CLODE_TJS           tjs template binary for 'clode build' (default build/tjs/tjs)
  CLODE_CHANGELOG_URL release-notes source for the post-update signals digest

Run 'clode --help' for Claude Code's own help.
`;
}

// Port of require_node's floor check for the RESOLVED bundle node.
//  - node === process.execPath: the launcher IS this node, so checkNodeVersion
//    on process.versions.node suffices (no subprocess).
//  - node differs (CLODE_NODE set): it must run AND meet the floor. If it won't
//    run (not executable, or the version probe fails) -> the exact "no usable
//    node" error; if it runs but is too old -> the exact two-line "too old" error.
// Prints the EXACT sh messages and exits 1 on failure; returns on success.
function requireNode(node, opts = {}) {
  const stderr = opts.stderr || process.stderr;
  const exit = opts.exit || process.exit;
  const spawn = opts.spawn || spawnSync;

  if (node === process.execPath) {
    return hosttools.requireNodeVersionOrExit({ stderr, exit });
  }

  // Alternate node (CLODE_NODE): probe its version by spawning it.
  let ver = '';
  if (hosttools.isExecutableFile(node)) {
    const r = spawn(node, ['-e', 'process.stdout.write(process.versions.node)'], { encoding: 'utf8' });
    if (r && r.status === 0 && r.stdout) ver = String(r.stdout).trim();
  }
  if (!ver) {
    stderr.write(`clode: no usable node at '${node}' (set CLODE_NODE)\n`);
    return exit(1);
  }
  return hosttools.requireNodeVersionOrExit({ versionString: ver, stderr, exit });
}

// Resolve where the bundle's runtime deps and support files come from, branching on
// SEA — but only to produce ON-DISK dirs that mirror the npm/source layout, so the
// rest of the launcher runs unchanged against them:
//   - SEA: materialize the ext-deps into a depsRoot-shaped dir (seaDepsRoot) and the
//     bun-shim + extractor into a libexec-shaped dir (seaLibexec), from embedded
//     assets (no npm).
//   - npm/source: ensureDeps installs the ext-deps; both dirs stay undefined so the
//     caller uses the real LIBEXEC and the default DEPS_ROOT.
// sea/deps are injected (default to the real modules) so the branch is unit-testable
// without a real SEA.
function prepareRuntimeDeps(opts) {
  const { sea, deps, cacheRoot, libexec, here, verbose, env } = opts;
  if (sea.isSea()) {
    const seaDepsRoot = sea.materializeDeps({ cacheDir: cacheRoot });   // holds node_modules/
    const seaLibexec = sea.materializeLibexec({ destDir: path.join(cacheRoot, 'sea-deps', 'libexec') });
    return { seaDepsRoot, seaLibexec };
  }
  deps.ensureDeps({ libexec, here, verbose, env });
  return { seaDepsRoot: undefined, seaLibexec: undefined };
}

// main(argv, {self}) — async because it awaits clodeUpdate/clodeWatch.
async function main(argv, opts = {}) {
  const env = process.env;

  // 1. Pull clode's own flags out of argv FIRST (any position) so the bundle never
  //    sees them. --clode-verbose un-silences clode's progress chatter; it is
  //    dropped, every other arg keeps its relative order (matches the sh rotate).
  let seenVerbose = false;
  const args = [];
  for (const a of argv) {
    if (a === '--clode-verbose') seenVerbose = true;
    else args.push(a);
  }
  if (seenVerbose) env.CLODE_VERBOSE = '1';
  const verbose = !!env.CLODE_VERBOSE;

  // 2. Resolve this launcher's real path + the shipped layout.
  //    clode-main lives in libexec/, so:
  //      LIBEXEC = CLODE_LIBEXEC | __dirname          (sh: $HERE/../libexec)
  //      ROOT    = resolve(__dirname, '..')           (the package root, sh: $HERE/..)
  //      HERE    = ROOT/bin                           (sh $HERE: the bin/ dir; HERE/.. = ROOT)
  //    SELF is the launcher path (symlink-resolved) for CLODE_SELF + the watcher fire.
  let self = opts.self || __filename;
  try { self = fs.realpathSync(self); } catch { /* keep as-is */ }
  const LIBEXEC = env.CLODE_LIBEXEC || __dirname;
  const ROOT = path.resolve(__dirname, '..');
  const HERE = path.join(ROOT, 'bin');

  // Version from the shipped VERSION file (command-sub strips trailing newlines).
  // The file wins in the npm/source layout; the esbuilt bundle/SEA can't find it
  // (__dirname is build/sea, not the package root), so it falls back to the version
  // esbuild injects via --define (undefined outside a bundle -> the typeof guard).
  let version = (typeof __CLODE_BUNDLE_VERSION__ !== 'undefined' && __CLODE_BUNDLE_VERSION__) || 'dev';
  try { version = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').replace(/\n+$/, '') || version; } catch { /* keep injected/dev */ }

  const first = args[0];

  // 3. --clode-version: print clode's own version, no launch.
  if (first === '--clode-version') {
    process.stdout.write(`clode ${version}\n`);
    return process.exit(0);
  }

  // 4. --clode-help: clode's own flags (Claude Code's --help still passes through).
  if (first === '--clode-help') {
    process.stdout.write(clodeHelp(version));
    return process.exit(0);
  }

  const node = env.CLODE_NODE || process.execPath;

  // 5. `clode update [channel]`: fetch a fresh provider, then exit — no Node floor.
  if (first === 'update') {
    const status = await update.clodeUpdate(args[1], { env, libexec: LIBEXEC, here: HERE, node });
    return process.exit(status);
  }

  // 6. `clode --clode-internal-update [channel]`: the non-interactive entry the
  //    in-TUI autoupdater spawns (via CLODE_SELF); same fetch as `update`, then exit.
  if (first === '--clode-internal-update') {
    const status = await update.clodeUpdate(args[1], { env, libexec: LIBEXEC, here: HERE, node });
    return process.exit(status);
  }

  // 6b. `clode build [--out PATH]`: fuse a standalone quaude binary on this
  //     machine (builder namespace, not passthrough — Claude Code never sees it).
  if (first === 'build') {
    const fuse = require('./clode-fuse.cjs');
    const status = await fuse.clodeBuild(args.slice(1), { env, libexec: LIBEXEC, here: HERE, version });
    return process.exit(status);
  }

  // 7. `clode --clode-watch`: one stateless update-signal cycle (manual: prints a
  //    summary to stderr), then exit 0.
  if (first === '--clode-watch') {
    await watch.clodeWatch('manual', { env, libexec: LIBEXEC, here: HERE, node });
    return process.exit(0);
  }

  // 8. DEFAULT LAUNCH.
  // Under a SEA the binary is its own node, so an external CLODE_NODE is irrelevant and
  // must not gate the launch (runBundle also forces node=self under SEA); otherwise the
  // resolved `node` applies.
  const sea = require('./clode-sea.cjs');
  const launchNode = sea.isSea() ? process.execPath : node;
  requireNode(launchNode);

  let bin = resolve.resolveClaudeBin({ env });
  if (bin == null) {
    process.stderr.write('clode: no Claude Code binary found.\n');
    process.stderr.write('clode: install the provider package (e.g. claude-code), or set\n');
    process.stderr.write('clode: CLODE_CLAUDE_BIN=/path/to/claude\n');
    return process.exit(1);
  }
  if (!resolve.pathExists(bin)) {
    process.stderr.write(`clode: claude binary not found at '${bin}'\n`);
    return process.exit(1);
  }
  // Follow a tiny exec-wrapper to the real single-file bundle, so we extract (and
  // cache-key off) the binary that actually carries the JS.
  bin = resolve.followWrapper(bin);

  const key = resolve.cacheKey(bin);
  const cacheRoot = clodeCacheDir(env);
  const cache = path.join(cacheRoot, key);

  // Under a SEA the ext-deps + support files are materialized from embedded assets
  // into dirs shaped like the npm/source layout (a depsRoot and a libexec); otherwise
  // ensureDeps installs and the real LIBEXEC/DEPS_ROOT apply. Everything downstream
  // then runs UNCHANGED against LAUNCH_LIBEXEC / depsRoot — no SEA-specific branches.
  const { seaDepsRoot, seaLibexec } = prepareRuntimeDeps({
    sea, deps, cacheRoot, libexec: LIBEXEC, here: HERE, verbose, env,
  });
  const LAUNCH_LIBEXEC = seaLibexec || LIBEXEC;

  extract.extractIfNeeded({ bin, cacheDir: cache, libexec: LAUNCH_LIBEXEC, verbose, key });

  // Where the runtime ext-deps (ws, yaml, string-width, ...) live: ensure_deps's
  // DEPS_ROOT in the npm/source path, or the materialized sea-deps dir under SEA. Its
  // node_modules joins NODE_PATH via runBundle -> applyNodePath, unchanged either way.
  const depsRoot = seaDepsRoot || depsStore(env);

  // Watcher: on real sessions only (never on print-and-exit, which run no model),
  // surface any prior HIGH notice, then maybe fire a fresh detached cycle.
  if (first !== '--version' && first !== '-v' && first !== '--help' && first !== '-h') {
    watch.clodeWatchBanner({ env, here: HERE });
    watch.clodeWatchMaybe({ env, self });
  }

  const settingsPath = run.guardSettingsForArgs(args, { node: launchNode, libexec: LAUNCH_LIBEXEC, env });
  run.runBundle({
    node: launchNode,
    cliPath: path.join(cache, 'cli.cjs'),
    args,
    settingsPath,
    self,
    libexec: LAUNCH_LIBEXEC,
    depsRoot,
    env,
  });
}

// SEA "run as node" mode: when clode-run spawns the SEA binary to execute the
// extracted cli.cjs, it sets CLODE_SEA_RUN_AS_NODE. In that mode, behave like plain
// `node <script> [args]`: strip the sentinel (the bundle must never see it), reshape
// argv, and run the script as the main module. Returns true when it handled the run.
function runAsNodeIfRequested() {
  if (process.env.CLODE_SEA_RUN_AS_NODE !== '1') return false;
  delete process.env.CLODE_SEA_RUN_AS_NODE;             // never leaks to the bundle
  const rest = process.argv.slice(2);                    // [script, ...args]
  const script = require('node:path').resolve(rest[0]);
  process.argv = [process.execPath, script, ...rest.slice(1)];
  // In a SEA the global `require` (embedderRequire) resolves ONLY built-in modules;
  // createRequire yields a filesystem-capable require for the extracted cli.cjs (and
  // it behaves identically outside a SEA, so this one path serves both).
  require('node:module').createRequire(script)(script);
  return true;
}

// Self-run entry: when this module is the process's main module (the esbuilt SEA
// bundle, or `node libexec/clode-main.cjs`), behave like bin/clode's prologue caller.
// Guarded so it does NOT run when bin/clode require()s us and calls main() itself.
// runAsNodeIfRequested runs FIRST: under SEA re-invocation it takes over the process.
if (require.main === module) {
  if (!runAsNodeIfRequested()) {
    main(process.argv.slice(2), { self: process.execPath }).catch((e) => {
      process.stderr.write('clode: ' + ((e && e.stack) || e) + '\n');
      process.exit(1);
    });
  }
}

module.exports = { main, clodeHelp, requireNode, runAsNodeIfRequested, prepareRuntimeDeps };
