'use strict';
// clode-main — the JS launcher spine. Ports bin/clode's main() control flow
// (bin/clode:549) faithfully, wiring the already-built sub-modules into a complete
// launcher. Entry is bin/clode (an ES5-safe prologue that require()s this and
// calls main()). This module runs on modern Node (>= bin/clode's inlined v20
// floor); the prologue guarantees that before it loads us.
//
// Dispatch order (exact, from main()):
//   1. --verbose (leading position only) -> CLODE_VERBOSE=1
//   2. resolve SELF / HERE / LIBEXEC / CLODE_SELF_VERSION
//   3. --version                -> print "clode <VERSION>", exit 0
//   4. --help                   -> print clodeHelp(), exit 0
//   5. fetch [channel]          -> clodeUpdate, exit status
//   6. --clode-internal-update  -> refuse (not a real update yet), exit 1
//   6b. build [--out PATH]      -> check watch signals, then clodeBuild (fuse a
//                                  quaude), exit status — this is the ONE place
//                                  upstream drift is checked (see step 7's note)
//   7. watch                    -> clodeWatch(manual), exit 0
//   8. anything else            -> usage error, exit 2 (clode BUILDS targets; it
//                                  never runs Claude Code itself — see clode-fuse.cjs
//                                  / naude-entry.cjs for what DOES run it)
//
// Pure Node stdlib + sibling .cjs requires (the sub-modules pull the ext-deps).

const fs = require('node:fs');
const path = require('node:path');

const update = require('./clode-update.cjs');
const watch = require('./clode-watch.cjs');

// clode's own help. Formerly a clode-specific subset of a passthrough launcher's
// help (Claude Code's own --help took over for anything clode didn't recognize);
// now that there's no passthrough, this IS clode's whole help. Task 6 dropped the
// --clode- prefix (no more argv collision to dodge) and the --self/CLODE_MAIN_BUNDLE
// entries (build --self left the user-facing surface — release tooling still calls
// it, it's just not advertised). Ends with a trailing newline (like the old heredoc).
function clodeHelp(version) {
  return `clode ${version} — build a standalone Claude Code binary for your machine.

Usage:
  clode build [--out PATH]                 build a standalone quaude binary (the pinned
                                           tjs runtime + the compiled Claude Code
                                           bundle) on this machine; default ./quaude
  clode build --naude [--out PATH]         bundle Claude Code as a Node SEA; Node hosts only
  clode fetch [channel|version]            fetch a fresh upstream provider, then exit
  clode watch                              run one update-signal check now (newer version
                                           + signals that bear on repackaging), print a
                                           summary, and exit

Options:
  --help              show this help and exit
  --version           print clode's own version and exit
  --verbose           show clode's progress (extract/deps/etc.); silent by default,
                      so a normal run emits only build/fetch's own output

Key environment overrides:
  CLODE_VERBOSE=1     same as --verbose
  CLODE_NO_WATCH=1    disable the opportunistic update-signal check that runs
                      during 'clode build'
  CLODE_CLAUDE_BIN    upstream claude binary to extract from
  CLODE_NODE          host node
  CLODE_CACHE         extracted-bundle cache dir
  CLODE_TJS           tjs template binary for 'clode build' (default: the fused
                      builder's own embedded template, else build/tjs/tjs)
  CLODE_CHANGELOG_URL release-notes source for the post-update signals digest
`;
}

// main(argv, {self}) — async because it awaits clodeUpdate/clodeWatch.
async function main(argv, opts = {}) {
  const env = process.env;

  // 1. --verbose un-silences clode's progress chatter. It's an ordinary LEADING
  //    flag now (args[0] only) — the old any-position stripping loop existed
  //    solely to keep it from colliding with Claude Code's argv under
  //    passthrough; passthrough is gone, so there's nothing left to protect it
  //    from and no reason to scan the whole argv for it.
  let args = argv;
  if (args[0] === '--verbose') {
    env.CLODE_VERBOSE = '1';
    args = args.slice(1);
  }
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

  // 3. --version: print clode's own version, no launch (there is no launch).
  if (first === '--version') {
    process.stdout.write(`clode ${version}\n`);
    return process.exit(0);
  }

  // 4. --help: clode's own — and, since Task 5, ONLY — help.
  if (first === '--help') {
    process.stdout.write(clodeHelp(version));
    return process.exit(0);
  }

  const node = env.CLODE_NODE || process.execPath;

  // 5. `clode fetch [channel]`: fetch a fresh provider, then exit — no Node floor.
  if (first === 'fetch') {
    const status = await update.clodeUpdate(args[1], { env, libexec: LIBEXEC, here: HERE, node });
    return process.exit(status);
  }

  // 6. `clode --clode-internal-update [channel]`: the callback the built target's
  //    patched in-app updater invokes (via CLODE_SELF). It CANNOT be today's fetch:
  //    fetching a newer Claude Code into the provider store does nothing for a
  //    target that has the old one baked into its bytecode — it would report
  //    success and change nothing. The real thing (fetch -> rebuild the target ->
  //    swap it in place) is Phase 4; until then, refuse rather than lie.
  if (first === '--clode-internal-update') {
    process.stderr.write('clode: a built Claude Code binary cannot update itself in place.\n');
    process.stderr.write("clode: run 'clode fetch' to get a newer Claude Code, then 'clode build' to rebuild.\n");
    return process.exit(1);
  }

  // 6b. `clode build [--self] [--out PATH]`: fuse a standalone quaude binary —
  //     or, with --self, a standalone native clode builder — on this machine
  //     (builder namespace, not passthrough — Claude Code never sees it).
  if (first === 'build') {
    const buildArgs = args.slice(1);
    // Upstream drift threatens our ability to repackage, so check when we
    // repackage. (This ran on every launch when clode was a runner; there is
    // no launch anymore, so `build` — the moment upstream drift actually
    // matters — is where the check moved.) --self fuses the BUILDER, not a
    // Claude Code target: it has no upstream bundle to drift, and it is release
    // bootstrap (CI legs, cross-fuse guests) rather than a user invocation — so
    // it gets no watch trigger, never mind the network fetch inside one.
    if (!buildArgs.includes('--self')) {
      watch.clodeWatchBanner({ env, here: HERE });
      watch.clodeWatchMaybe({ env, self });
    }
    const fuse = require('./clode-fuse.cjs');
    const status = await fuse.clodeBuild(buildArgs, { env, libexec: LIBEXEC, here: HERE, version, self });
    return process.exit(status);
  }

  // 7. `clode watch`: one stateless update-signal cycle (manual: prints a
  //    summary to stderr), then exit 0.
  if (first === 'watch') {
    await watch.clodeWatch('manual', { env, libexec: LIBEXEC, here: HERE, node });
    return process.exit(0);
  }

  // 8. No default launch: clode BUILDS Claude Code targets, it never runs them.
  // (quaude runs it under tjs; naude under node.) An unrecognized argv is a
  // usage error — there is nothing to pass it through to.
  process.stderr.write(`clode: unknown command '${first ?? ''}'\n`);
  process.stderr.write(clodeHelp(version));
  return process.exit(2);
}

// Self-run entry: when this module is the process's main module (the esbuilt
// bundle, or `node libexec/clode-main.cjs`), behave like bin/clode's prologue caller.
// Guarded so it does NOT run when bin/clode require()s us and calls main() itself.
// Print-worthy rendering of a caught error. V8 stacks embed the `Error:
// message` header; QuickJS stacks are frames-only — printing e.stack alone
// there LOSES the message (v0.1.2 field report printed a bare wall of `at`
// lines). Prepend the message whenever the stack does not already carry it.
function formatError(e) {
  if (!e) return String(e);
  const stack = e.stack ? String(e.stack) : '';
  const msg = e.message ? String(e.message) : '';
  if (!stack) return msg || String(e);
  if (msg && stack.indexOf(msg) === -1) return (e.name || 'Error') + ': ' + msg + '\n' + stack;
  return stack;
}

if (require.main === module) {
  main(process.argv.slice(2), { self: process.execPath }).catch((e) => {
    process.stderr.write('clode: ' + formatError(e) + '\n');
    process.exit(1);
  });
}

module.exports = { formatError, main, clodeHelp };
