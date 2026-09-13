'use strict';
// clode-main — the JS launcher spine. Ports bin/clode's main() control flow
// (bin/clode:549) faithfully, wiring the already-built sub-modules into a complete
// launcher. Entry is scripts/stage0.mjs (an ES5-safe prologue that dynamically
// import()s this and calls main()). This module runs on modern Node (>=
// scripts/stage0.mjs's inlined v20 floor); the prologue guarantees that before
// it loads us.
//
// THE SURFACE IS NOT HERE. Which verbs exist, what positional each takes, which
// flags, and every line of --help all live in ONE literal: libexec/cli-surface.cjs.
// This file is the part that DOES things — it asks cli-surface which verb argv named
// and then runs it. Before task 5 the two were the same thing (a 213-line if-chain
// over args[0], each branch documenting itself in prose), which is how `--target`
// came to mean one thing with --naude and another without it. Add a verb by adding a
// table entry and ONE branch below; never by adding help text.
//
// Dispatch order (exact, from main()):
//   1. parseArgv(args, surfaceFor(kind)) -> { verb, subject, tail, flags, rest }
//   2. --verbose (leading, table-declared)    -> CLODE_VERBOSE=1
//   3. resolve SELF / HERE / LIBEXEC / VERSION
//   4. --version                -> print "clode <VERSION>", exit 0
//   5. --help                   -> print renderHelp(table), exit 0
//   6. no verb, or a positional the table rejects -> usage error, exit 2 (clode
//                                  BUILDS targets; it never runs Claude Code itself —
//                                  see clode-build.cjs / naude-entry.cjs for what DOES)
//   7. fetch <ingredient>       -> clodeUpdate / ensurePinnedNode, exit status
//   8. build <product>          -> check watch signals, then clodeBuild, exit status —
//                                  this is the ONE place upstream drift is checked
//   9. read-anthropic-tea-leaves -> clodeWatch(manual), exit 0
//  10. bootstrap                -> clodeBuild for the BUILDER; checkout entry only,
//                                  because the table it composes is the only one with
//                                  the verb (a shipped clode refuses it, from data)
//
// Pure Node stdlib + sibling .cjs requires (the sub-modules pull the ext-deps).

const fs = require('node:fs');
const path = require('node:path');

const update = require('./clode-update.cjs');
const watch = require('./clode-watch.cjs');
const { renderHelp, parseArgv, surfaceFor } = require('./cli-surface.cjs');

// THE BREAK (task 6): there is no legacy-spelling map here, and there is not meant to
// be one. `watch`, `build --naude`, `build --self`, bare `clode fetch` and `clode
// fetch <version>` are gone; each produces a GENERIC usage error, not a translation to
// the new form. The user's reasoning, adopted: with three verbs and four positionals
// the vocabulary is small enough that a usage message IS the mapping. Every in-repo
// caller moved in the same commit.

// clode's own help — RENDERED FROM THE TABLE, never written here. Kept as a named
// function because callers (and tests) ask for "clode's help at version V"; the text
// itself is cli-surface.cjs's job, so help and the accepted argv cannot drift apart
// (test/cli-surface.test.cjs asserts every table verb and subject appears). Ends with
// a trailing newline, like the heredoc it replaced.
function clodeHelp(version, kind) {
  return renderHelp(version, surfaceFor(kind || 'shipped'));
}

// main(argv, {self, kind}) — async because it awaits clodeUpdate/clodeWatch.
//
// `kind` is WHICH ENTRY POINT this is, and therefore which table: 'shipped' (the
// built clode binary — the default, and what the esbuilt bundle's own self-run below
// passes) or 'checkout' (scripts/stage0.mjs, which has `bootstrap` besides). It is an
// argument rather than a sniff (no __dirname heuristic, no env var) because the entry
// point is the one thing that genuinely knows.
async function main(argv, opts = {}) {
  const env = process.env;
  const args = Array.isArray(argv) ? argv : [];

  // 1. Match argv against the surface THIS entry point has. Everything below reads
  //    `cmd` — no branch here compares args[0] to a string, which is the whole point
  //    of the table.
  const kind = opts.kind === 'checkout' ? 'checkout' : 'shipped';
  const surface = surfaceFor(kind);
  const cmd = parseArgv(args, surface);

  // cmd.error is FATAL (step 5) unless the verb declares ownsArgv and the complaint is
  // flag-level: build and bootstrap hand cmd.rest to clode-build.cjs's parseBuildArgs,
  // which is imported rather than re-implemented, so there is ONE unknown-argument
  // message with ONE usage line, printed by the module whose argv it is. Every other
  // verb's contract is the table itself, so an argument it does not recognise is
  // refused here rather than silently ignored — which is what `clode fetch claude
  // --bogus` used to be.

  // 2. --verbose un-silences clode's progress chatter. A LEADING flag (the table's
  //    globals are leading-only): the old any-position stripping loop existed solely
  //    to keep it from colliding with Claude Code's argv under passthrough, and
  //    passthrough is gone.
  if (cmd.flags['--verbose']) env.CLODE_VERBOSE = '1';

  // 3. Resolve this launcher's real path + the shipped layout.
  //    clode-main lives in libexec/, so:
  //      LIBEXEC = CLODE_LIBEXEC | __dirname          (sh: $HERE/../libexec)
  //      ROOT    = resolve(__dirname, '..')           (the package root, sh: $HERE/..)
  //      HERE    = ROOT/bin                           (sh $HERE: the bin/ dir; HERE/.. = ROOT)
  //    SELF is the launcher path (symlink-resolved), threaded to clodeBuild + the watcher fire.
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

  // 4. The print-and-exit globals, acted on in the order ARGV gave them (parseArgv's
  //    globalOrder), which is the order the old first-arg-only dispatch effectively
  //    used: `clode --help --version` prints help, `clode --version --help` prints the
  //    version, and either beats a verb (`clode --version build` prints the version, as
  //    it always has). Nonsense argv, but it used to have an answer and it keeps the
  //    same one — a table-driven dispatch should not quietly re-decide such things.
  for (const flag of cmd.globalOrder) {
    if (flag === '--version') {
      process.stdout.write(`clode ${version}\n`);
      return process.exit(0);
    }
    if (flag === '--help') {
      process.stdout.write(clodeHelp(version, kind));
      return process.exit(0);
    }
  }

  // 5. Not a verb in this table, or a positional the table rejects: a usage error,
  //    exit 2, with the help under it. There is no default launch — clode BUILDS
  //    Claude Code targets, it never runs them (quaude runs it under tjs, naude under
  //    node), so there is nothing to pass an unrecognised argv to. This is also where
  //    every spelling task 6 removed lands, and why each gets a GENERIC message: the
  //    table says what exists, and with three verbs that is the whole mapping.
  // The verb's table entry (null when argv named no verb): what dispatch reads for
  // everything below, starting with whether the verb parses its own argv.
  const def = cmd.verb ? surface.verbs[cmd.verb] : null;
  if (!cmd.verb || (cmd.error && !(cmd.errorKind === 'flag' && def.ownsArgv))) {
    process.stderr.write(`clode: ${cmd.error}\n`);
    process.stderr.write(clodeHelp(version, kind));
    return process.exit(2);
  }

  // The table says what a bare verb means; dispatch applies it. There is no other way
  // to name a product or an ingredient — the flags that used to (`--naude`, `--self`)
  // are gone, which is what makes `build quaude --naude` impossible rather than
  // merely discouraged: the positional is the only lever, and the flag is now an
  // unknown argument to the build parser.
  const subject = cmd.subject || def.defaultSubject;

  const node = env.CLODE_NODE || process.execPath;
  // Usage errors from a verb's OWN argv parser: same exit code as the table's (2),
  // because they are the same kind of mistake, and the module's message (which
  // carries its usage line) is the one printed.
  const usage = (message) => { process.stderr.write('clode: ' + message + '\n'); return process.exit(2); };

  // 6. `clode fetch <ingredient>`: fetch a build ingredient, then exit — no Node floor.
  //    `claude` is the upstream provider (the ~240MB binary quaude is built from);
  //    `node` is the PINNED NODE (clode-node.cjs) into the local store, so a later
  //    `clode build naude` can run without the user having Node installed.
  if (cmd.verb === 'fetch') {
    const target = cmd.flags['--target'];
    if (subject === 'node') {
      // The table's second positional belongs to `claude` alone (tail.only), and an
      // accepted-but-ignored argument is the same lie as an ignored flag. Checked
      // BEFORE any work, like every other argv complaint in this file.
      if (cmd.tail) {
        return usage(`fetch node takes no release argument, got '${cmd.tail}' — the pinned Node's version is clode's own pin, not a channel`);
      }
      // --target crosses HONESTLY here, with plumbing that already existed: the
      // pinned-node store is per-(version, platform, arch) precisely because a naude
      // cross-build fetches a Node for a machine that is not this one
      // (clode-node.cjs's nodeBinPath), so all --target has to do is name the pair.
      // A well-formed target with no Node (netbsd, …) is a loud refusal, not a
      // silent host fetch.
      let platform = process.platform;
      let arch = process.arch;
      if (target) {
        const nt = require('../scripts/canonical-name.cjs').targetToNode(target);
        if (!nt) {
          return usage(`fetch node --target: '${target}' is not a Node platform — there is no pinned Node for it (quaude is the product that targets it: clode build quaude --target ${target})`);
        }
        platform = nt.platform;
        arch = nt.arch;
      }
      const p = await require('./clode-node.cjs').ensurePinnedNode({
        env, platform, arch, log: (m) => process.stderr.write(m + '\n'),
      });
      process.stdout.write('clode: pinned node ready at ' + p + '\n');
      return process.exit(0);
    }
    // The OTHER ingredient cannot cross, and says so rather than accepting a flag it
    // would ignore. MEASURED (libexec/clode-update.cjs): the provider store is keyed
    // by VERSION ALONE — providers/<version>/claude — and a fetch re-points `current`
    // at what it wrote, so a foreign-OS fetch would overwrite this machine's provider
    // in place and leave every later build carving the wrong OS branches. The missing
    // platform axis is the limitation, so the refusal names it, and names the one
    // override that does exist.
    if (target) {
      return usage(`fetch claude --target: the provider store has no platform axis — it is keyed by version alone (providers/<version>/claude) and a fetch re-points 'current' at it, so fetching ${target}'s provider would replace this machine's. Set CLODE_FETCH_PLATFORM to choose the upstream build deliberately; 'clode fetch node --target' is the ingredient that crosses.`);
    }
    // The declared second positional (SURFACE.verbs.fetch.tail): which upstream
    // release. Absent -> clodeUpdate resolves the configured channel, as before.
    const status = await update.clodeUpdate(cmd.tail, { env, libexec: LIBEXEC, here: HERE, node });
    return process.exit(status);
  }

  // 7. `clode build <product> [--out PATH]`: blobulate a standalone quaude binary, or
  //     a naude, on this machine. The PRODUCT is the positional, threaded to
  //     clodeBuild as `product` — not a flag in the argv it parses, which is what
  //     makes `build quaude --naude` an unknown argument instead of a naude.
  //     Builder namespace, not passthrough: Claude Code never sees this argv.
  if (cmd.verb === 'build') {
    const build = require('./clode-build.cjs');
    const buildArgs = cmd.rest;
    // Validate argv BEFORE anything else in this branch: a build that is
    // going to be REJECTED must not phone home or touch the cache. (Regression
    // fixed here: `clode build <bad-arg>` used to fire the watch trigger below
    // — spawning a detached network check and writing <cache>/clode/last-watch
    // — and only THEN discover the argv was invalid, i.e. a rejected command
    // mutated the user's cache anyway. parseBuildArgs is the SAME parser
    // clodeBuild itself uses — imported, not re-implemented, so there is one
    // unknown-arg contract, not two.)
    const parsed = build.parseBuildArgs(buildArgs, subject);
    if (parsed.error) return usage(parsed.error);
    // Upstream drift threatens our ability to repackage, so check when we
    // repackage. (This ran on every launch when clode was a runner; there is
    // no launch anymore, so `build` — the moment upstream drift actually
    // matters — is where the check moved.) `bootstrap` (step 10) builds the BUILDER,
    // which has no upstream bundle to drift and is release plumbing rather than a user
    // invocation, so it gets no watch trigger and never mind the network fetch inside
    // one — that is now a difference between two BRANCHES, not a flag this one tests.
    watch.clodeWatchBanner({ env, here: HERE });
    watch.clodeWatchMaybe({ env, self });
    const status = await build.clodeBuild(buildArgs, { env, libexec: LIBEXEC, here: HERE, version, self, product: subject });
    return process.exit(status);
  }

  // 8. `clode read-anthropic-tea-leaves`: one stateless update-signal cycle — it greps
  //    the changelog for phrases that bear on repackaging and INFERS Anthropic's
  //    direction of travel (warn-only, never authoritative, never downloads the
  //    binary). Prints a summary to stderr, then exits 0.
  if (cmd.verb === 'read-anthropic-tea-leaves') {
    await watch.clodeWatch('manual', { env, libexec: LIBEXEC, here: HERE, node });
    return process.exit(0);
  }

  // 10. `node scripts/stage0.mjs bootstrap [--target P] [--out PATH]`: build clode
  //     ITSELF from this checkout. Checkout-only, and not because of a conditional
  //     here — the shipped table simply has no such verb (cli-surface.cjs's
  //     CHECKOUT_ONLY_VERBS), so a shipped clode says where bootstrap lives and exits
  //     2 at step 5. Every real caller is CI release plumbing (.github/actions/
  //     build-leg, .github/actions/cross-blobulate, .github/workflows/release.yml),
  //     which is why it takes no watch trigger: it repackages nothing of Anthropic's.
  if (cmd.verb === 'bootstrap') {
    const build = require('./clode-build.cjs');
    const parsed = build.parseBuildArgs(cmd.rest, 'clode');
    if (parsed.error) return usage(parsed.error);
    const status = await build.clodeBuild(cmd.rest, { env, libexec: LIBEXEC, here: HERE, version, self, product: 'clode' });
    return process.exit(status);
  }

  // A verb the table declares and dispatch forgot to wire. Not reachable by argv —
  // only by editing the table and stopping halfway — so it says exactly that.
  process.stderr.write(`clode: internal error: no dispatch for the declared verb '${cmd.verb}'\n`);
  return process.exit(70);
}

// Self-run entry: when this module is the process's main module (the esbuilt
// bundle, or `node libexec/clode-main.cjs`), behave like scripts/stage0.mjs's
// prologue caller. Guarded so it does NOT run when scripts/stage0.mjs imports
// us and calls main() itself.
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
