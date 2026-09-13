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
//   1. parseArgv(args, surfaceFor('shipped')) -> { verb, subject, flags, rest }
//   2. --verbose (leading, table-declared)    -> CLODE_VERBOSE=1
//   3. resolve SELF / HERE / LIBEXEC / VERSION
//   4. --version                -> print "clode <VERSION>", exit 0
//   5. --help                   -> print renderHelp(table), exit 0
//   6. no verb in the table     -> usage error, exit 2 (clode BUILDS targets; it
//                                  never runs Claude Code itself — see clode-build.cjs
//                                  / naude-entry.cjs for what DOES run it)
//   7. fetch <ingredient>       -> clodeUpdate / ensurePinnedNode, exit status
//   8. build <product>          -> check watch signals, then clodeBuild, exit status —
//                                  this is the ONE place upstream drift is checked
//   9. read-anthropic-tea-leaves -> clodeWatch(manual), exit 0
//
// Pure Node stdlib + sibling .cjs requires (the sub-modules pull the ext-deps).

const fs = require('node:fs');
const path = require('node:path');

const update = require('./clode-update.cjs');
const watch = require('./clode-watch.cjs');
const { renderHelp, parseArgv, surfaceFor } = require('./cli-surface.cjs');

// TRANSITIONAL (task 6 deletes this map together with the spellings it names): the
// verb names that came before the table. They are rewritten into table spelling
// BEFORE parseArgv runs, so dispatch below has exactly one router to read and the
// compatibility is one line of data rather than a second branch per verb.
const LEGACY_VERBS = { watch: 'read-anthropic-tea-leaves' };

// Rewrite the VERB POSITION only (leading globals skipped, so `clode --verbose watch`
// works the same as `clode watch`); anything after the verb belongs to the verb.
function withLegacyVerbs(args, surface) {
  const out = args.slice();
  for (let i = 0; i < out.length; i++) {
    if (Object.prototype.hasOwnProperty.call(surface.globals, out[i])) continue;
    if (Object.prototype.hasOwnProperty.call(LEGACY_VERBS, out[i])) out[i] = LEGACY_VERBS[out[i]];
    break;
  }
  return out;
}

// clode's own help — RENDERED FROM THE TABLE, never written here. Kept as a named
// function because callers (and tests) ask for "clode's help at version V"; the text
// itself is cli-surface.cjs's job, so help and the accepted argv cannot drift apart
// (test/cli-surface.test.cjs asserts every table verb and subject appears). Ends with
// a trailing newline, like the heredoc it replaced.
function clodeHelp(version) {
  return renderHelp(version, surfaceFor('shipped'));
}

// main(argv, {self}) — async because it awaits clodeUpdate/clodeWatch.
async function main(argv, opts = {}) {
  const env = process.env;
  const args = Array.isArray(argv) ? argv : [];

  // 1. Match argv against the surface THIS entry point has. 'shipped' is the built
  //    clode binary's table; task 6 gives the checkout entry point 'checkout', which
  //    is the same table plus `bootstrap`. Everything below reads `cmd` — no branch
  //    here compares args[0] to a string, which is the whole point of the table.
  const surface = surfaceFor('shipped');
  const cmd = parseArgv(withLegacyVerbs(args, surface), surface);

  // cmd.error is deliberately NOT fatal when a verb resolved: each verb's own module
  // owns its argv contract (clode-build.cjs's parseBuildArgs is imported below, not
  // re-implemented, so there is ONE unknown-argument message), and until task 6 the
  // old spellings — `build --naude`, `build --self`, `fetch <channel>` — are argv the
  // table does not yet describe but clode still accepts. An unrecognised VERB is
  // fatal, at step 5.

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
      process.stdout.write(clodeHelp(version));
      return process.exit(0);
    }
  }

  // 5. Not a verb in this table: a usage error. There is no default launch — clode
  //    BUILDS Claude Code targets, it never runs them (quaude runs it under tjs,
  //    naude under node), so there is nothing to pass an unrecognised argv to.
  if (!cmd.verb) {
    process.stderr.write(`clode: ${cmd.error}\n`);
    process.stderr.write(clodeHelp(version));
    return process.exit(2);
  }

  // The table says what a bare verb means; dispatch applies it.
  const def = surface.verbs[cmd.verb];
  let subject = cmd.subject || def.defaultSubject;
  // TRANSITIONAL (task 6 deletes this): `--naude` named the product before the
  // subject did. Recognised HERE, at the one place a product is chosen, instead of
  // sniffed inside each branch (`args.slice(1).includes('--naude')` in two of them).
  if (!cmd.subject && cmd.rest.indexOf('--naude') !== -1) {
    if (cmd.verb === 'build') subject = 'naude';
    if (cmd.verb === 'fetch') subject = 'node';
  }

  const node = env.CLODE_NODE || process.execPath;

  // 6. `clode fetch <ingredient>`: fetch a build ingredient, then exit — no Node floor.
  //    `claude` is the upstream provider (the ~240MB binary quaude is built from);
  //    `node` is the PINNED NODE (clode-node.cjs) into the local store, so a later
  //    `clode build naude` can run without the user having Node installed.
  if (cmd.verb === 'fetch') {
    if (subject === 'node') {
      const p = await require('./clode-node.cjs').ensurePinnedNode({ env, log: (m) => process.stderr.write(m + '\n') });
      process.stdout.write('clode: pinned node ready at ' + p + '\n');
      return process.exit(0);
    }
    // TRANSITIONAL (task 6 deletes this): `clode fetch [channel|version]` — a
    // positional that is NOT a table ingredient is still a channel/version.
    const channel = cmd.rest[0];
    const status = await update.clodeUpdate(channel, { env, libexec: LIBEXEC, here: HERE, node });
    return process.exit(status);
  }

  // 7. `clode build <product> [--out PATH]`: blobulate a standalone quaude binary —
  //     or a naude, or (via --self, release bootstrap only, which task 6 moves to the
  //     checkout's `bootstrap` verb) the native clode builder itself — on this
  //     machine. Builder namespace, not passthrough: Claude Code never sees this argv.
  if (cmd.verb === 'build') {
    const build = require('./clode-build.cjs');
    // TRANSITIONAL (task 6 deletes this): clodeBuild's parser still names the product
    // with a FLAG, so the subject is translated back into the flag it understands —
    // and an argv that already used the flag passes through untouched.
    const buildArgs = (subject === 'naude' && cmd.rest.indexOf('--naude') === -1)
      ? ['--naude'].concat(cmd.rest)
      : cmd.rest;
    // Validate argv BEFORE anything else in this branch: a build that is
    // going to be REJECTED must not phone home or touch the cache. (Regression
    // fixed here: `clode build <bad-arg>` used to fire the watch trigger below
    // — spawning a detached network check and writing <cache>/clode/last-watch
    // — and only THEN discover the argv was invalid, i.e. a rejected command
    // mutated the user's cache anyway. parseBuildArgs is the SAME parser
    // clodeBuild itself uses — imported, not re-implemented, so there is one
    // unknown-arg contract, not two.)
    const parsed = build.parseBuildArgs(buildArgs);
    if (parsed.error) {
      process.stderr.write('clode: ' + parsed.error + '\n');
      return process.exit(1);
    }
    // Upstream drift threatens our ability to repackage, so check when we
    // repackage. (This ran on every launch when clode was a runner; there is
    // no launch anymore, so `build` — the moment upstream drift actually
    // matters — is where the check moved.) --self blobulates the BUILDER, not a
    // Claude Code target: it has no upstream bundle to drift, and it is release
    // bootstrap (CI legs, cross-blobulate guests) rather than a user invocation — so
    // it gets no watch trigger, never mind the network fetch inside one.
    if (!parsed.self) {
      watch.clodeWatchBanner({ env, here: HERE });
      watch.clodeWatchMaybe({ env, self });
    }
    const status = await build.clodeBuild(buildArgs, { env, libexec: LIBEXEC, here: HERE, version, self });
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
