'use strict';
// build-graph — the ONE declaration of what building `clode` from a clean checkout does.
//
// WHY THIS EXISTS. BACKLOG.md's "name the steps, show how done we are" item: "Steps you
// can show are steps you have named, and steps you have named are a build graph. We do not
// have one." What a developer needs in order to build this repo is spread across 51
// scripts, six npm scripts that build
// nothing, an 8,756-line BACKLOG.md and code comments. Prose describing an undeclared
// pipeline would be a FOURTH hand-maintained list of what the build does, going stale the
// same silent way as the other three. So the build declares its steps here, and the
// developer entry point, CI's call sites and the diagrams all read this file. Nothing else
// describes the pipeline's shape.
//
// THIS FILE IS A TRANSCRIPTION, NOT A REDESIGN. Every `run` shells out to the script that
// does that work today, unchanged and with the flags CI passes today. The graph becomes
// TRUE before anything is rewritten; steps convert one at a time behind a stable
// interface.
//
// THE ONE RULE THAT KEEPS THIS FROM BECOMING THE FOURTH LIST: `inputs`, `outputs` and
// `count` are FUNCTIONS that COMPOSE existing single sources of truth -- never literal
// arrays, never literal numbers. This repo has watched a hand-maintained list rot in
// exactly this position twice over, loudly: NODE_CONSTANTS was the union of whichever
// platforms somebody transcribed, and scripts/engine-recipe.cjs's FILES was wrong by its
// own stated rule on the day it was written, three separate times. The sources composed
// here:
//   scripts/engine-recipe.cjs   the engine's source set, itself DERIVED from
//                               build-tjs.cjs's own require graph
//   scripts/tjs-legs.mjs        the 42 release legs -- the graph is ONE graph parameterized
//                               by target through legsFor(), never 42 graphs
//   scripts/canonical-name.cjs  the ONE vocabulary for target/os/arch. A second spelling of
//                               it is how a gate silently died on 17 OSes on 2026-09-19
//   scripts/platform-tag.cjs    where this host's vendor checkout, engine and outputs live
//
// GRANULARITY: the graph stops at STEP granularity. cmake owns the within-step compile
// graph and this file does not model compiler invocations.
//
// COMMONJS, NO ESM SYNTAX, NO TOP-LEVEL await, NO import.meta -- this module must be
// hostable by libexec/node-shim/loader.cjs under tjs, because the developer build resolves
// a tjs through scripts/bootstrap-engine.sh and runs the graph under it. scripts/stage0.mjs
// is the cautionary case: `import.meta` outside Module goal is an EARLY parse error, so an
// ESM graph could not load far enough to report its own failure. engine-recipe.cjs became
// CommonJS on 2026-09-21 for exactly this reason, which is what made the ENGINE phase
// answerable under the shim and a node-free `./build.sh` possible at all; scripts/tjs-legs.mjs
// is still ESM, so it stays a LAZY require inside the function that needs it and only a
// leg-parameterized question costs node. Both are dev/CI tooling by their own headers
// ("Nothing on the `clode build` path imports this"), and loading this module is node-free
// either way.
//
// build-tjs.cjs MUST NOT require this file. It is the program being bootstrapped, and a
// require here would pull build-graph.cjs into engine-recipe.cjs's derived FILES and move
// the recipe hash -- rebuilding all 42 legs. Same rule, same reason, as
// scripts/build-tjs-boot.sh's.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const platformTag = require('./platform-tag.cjs');
const canonical = require('./canonical-name.cjs');

const REPO = path.resolve(__dirname, '..');

// The step that produces `clode` — the contract of `./build.sh` from a clean clone. The
// engine is an interior node of this graph, not a target a developer names.
const ROOT_ID = 'clode.blobulate';

// The front door: the file a developer types to run this graph. ONE place spells it,
// because three consumers need the name and none of them can check the others —
// scripts/render-build-graph.cjs writes it into the committed docs/build.md, the gate in
// test/build-graph.test.cjs reads the file itself, and the entry point's own header quotes
// it. It was three string literals in the renderer for exactly one afternoon and that was
// already enough to ship a bug: `entryPointPresent` stat'ed `build`, which is a DIRECTORY
// in every working checkout (build/ holds the scratch bundle and the built binaries), so it
// answered `false` for a reason that had nothing to do with the entry point and the page
// permanently announced that its own front door "is not in this checkout yet".
//
// AND THAT IS WHY IT IS `build.sh`, NOT `build`. On a case-insensitive filesystem — macOS's
// default, where this repo is developed — a file and a directory cannot share a name at the
// same level, so `build` is not available to be taken. The suffix is not decoration and not
// a style preference; it is the only spelling that can exist beside build/.
const ENTRY_REL = 'build.sh';

// THIS FILE, named repo-relative and POSIX. The node-route gate below reads this module's
// own SOURCE, and scripts/render-build-graph.cjs quotes the name in the page it generates;
// both used to spell it as a literal. Derived from __filename so a rename moves it, for the
// reason ENTRY_REL exists directly above.
const GRAPH_REL = posixRel(REPO, __filename);

// Where a step's work physically happens. 'host' is the machine running the build;
// 'container' is a docker toolchain image (the alpine/musl and cross legs); 'guest' is a
// VM whose binaries the host cannot exec; 'qemu-guest' is our own qemu system emulation
// (netbsd-sparc). This is what makes the graph honest across machines: a --plan bug on
// 2026-09-20 resolved an engine for the WRONG machine and would have rsynced an x86-64 ELF
// into a NetBSD guest, and a graph that pretends there is one machine cannot express that
// class of bug, let alone catch it.
const RUNS_ON = ['host', 'container', 'guest', 'qemu-guest'];

// WHO SATISFIES A NAMED STEP'S `needs`. Not a second selection verb next to `--only` -- a
// reader would have to remember which of two similar words drags the subgraph in -- but the
// real semantic, said out loud.
//
//   'build'   this run does: `--only engine.compile` builds engine.source and
//             engine.bytecode first. The default, and what a developer asking for the
//             engine means.
//   'assume'  something else already did, and the step's declared INPUTS are the assertion
//             that it really happened. This is the whole reason the mode is safe: an
//             alpine container, a cross image or a VM guest is handed the earlier phases'
//             outputs by a sync, and cannot run a source phase at all -- but it can still
//             be refused when what was supposed to arrive did not.
//
// 'assume' is meaningless without a named step (there is no step whose needs could have
// been satisfied elsewhere), and scripts/build-runner.cjs refuses that combination.
const NEEDS = ['build', 'assume'];

// ---- composing the single sources of truth --------------------------------------------

// The engine's source set, repo-relative and POSIX, expanded against the working tree by
// scripts/engine-recipe.cjs itself. NOT restated here: that file's FILES is already derived
// from build-tjs.cjs's own require graph, and a second copy of it is the precise disease
// its own header is a monument to. `expand` throws when a pattern matches nothing, so a
// wrong set is loud rather than silently smaller.
// Memoized for the life of the process: expanding it costs one `git ls-files` per pattern,
// and several steps compose it. The engine source set is a property of the CHECKOUT, and a
// single build or render is one moment in that checkout's life -- nothing this graph runs
// edits a tracked engine source underneath itself (the source step mutates the vendor
// checkout, which is not in this set).
let RECIPE_FILES = null;
function recipeFiles() {
  if (RECIPE_FILES) return RECIPE_FILES.slice();
  const er = require('./engine-recipe.cjs');
  RECIPE_FILES = er.expand(er.worktreeSource(REPO));
  return RECIPE_FILES.slice();
}

// The patch stack the source step applies, counted -- not a literal. Derived from the same
// expansion as recipeFiles(), so a patch added to spike/quickjs/patches/ (or the cosmo
// leg's patches/) moves this count without anyone remembering to.
function patchCount() {
  return recipeFiles().filter((p) => p.endsWith('.patch')).length;
}

// The esbuilt bundles `clode bootstrap` embeds, DERIVED from the script that emits them.
// build-clode-main.mjs writes each one as `path.join(OUT, '<name>.bundle.cjs')`, so that is
// what is read back here. Matching nothing is fatal, for engine-recipe.cjs's reason: a
// silently empty output list is a gate that cannot fail. Split into a PURE half and an I/O
// half for the reason every other decision in this build is (depscan-verdict.cjs,
// ar-determinism.cjs, bundle-inputs-gate.cjs): a refusal a test cannot feed a known-bad
// input to is a refusal nobody has ever watched fire. test/build-gates/build-graph-gates.test.cjs
// is that control.
function bundleOutputNamesFrom(src) {
  const re = /path\.join\(OUT,\s*'([^']+\.bundle\.cjs)'\)/g;
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) if (!out.includes(m[1])) out.push(m[1]);
  if (!out.length) {
    throw new Error('build-graph: scripts/build-clode-main.mjs named no `path.join(OUT, '
      + "'*.bundle.cjs')` outputs — either it stopped being the source of truth for what "
      + 'the bundle step emits, or this derivation is reading the wrong shape. Fix one; do '
      + 'not hardcode the names here.');
  }
  return out;
}

function bundleOutputNames() {
  return bundleOutputNamesFrom(
    fs.readFileSync(path.join(REPO, 'scripts', 'build-clode-main.mjs'), 'utf8'));
}

// Those same bundles, as paths under the context's build tree.
function bundleOutputPaths(ctx) {
  return bundleOutputNames().map((n) => path.join(ctx.repo, 'build', 'bundle', n));
}

// Everything build-clode-main.mjs bundles or bakes in, DERIVED in both halves.
//
// The libexec set is WALKED, deliberately the same superset rule libexec/clode-build.cjs's
// own stale-bundle gate uses ("newest mtime under libexec/*.cjs") rather than a clever
// per-module require walk: obviously correct beats clever, and a new libexec module is an
// input the day it lands. AppleDouble `._*` sidecars are excluded — this mount sprays them
// and they are not sources (see [[git-gc-fails-appledouble]]).
//
// The rest is READ OUT OF THE EMITTER, not listed here. The first cut of this function
// named four scalars by hand (VERSION, PINS.md and deps/clode's two manifests) with no
// refusal behind them, and the libexec walk kept the answer non-empty so nothing could ever
// notice a fifth. It already had: build-clode-main.mjs also runs scripts/engine-recipe.cjs
// to bake __CLODE_BAKED_ENGINE_RECIPE__, and the hand list had missed it on the day it was
// written. That is the NODE_CONSTANTS shape exactly, and the third hand list in this tree
// to rot. So every `path.join(REPO, ...)` in the emitter is the list now.
const EMITTER_REL = 'scripts/build-clode-main.mjs';

// PURE, so a test can hand it a known-bad emitter: `isFile` and the output-directory set
// are injected rather than probed. Two refusals, because the derivation can be wrong in two
// ways that both read as "fine":
//   * NOTHING MATCHED — the emitter stopped spelling its repo reads as path.join(REPO, ...),
//     so the answer silently shrinks to just the libexec walk.
//   * A MATCH THAT IS NEITHER a readable file NOR the step's own output directory — either
//     the emitter names something that is not there, or this reader is parsing the wrong
//     shape. Returning it as an input would make Task 4's existence check red on the graph
//     rather than on the build; dropping it silently is how an input goes missing.
function emitterInputPaths({ src, outDirs, isFile }) {
  const re = /path\.join\(\s*REPO\s*,\s*((?:'[^']*'\s*,\s*)*'[^']*')\s*\)/g;
  const seen = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    const rel = m[1].match(/'([^']*)'/g).map((q) => q.slice(1, -1)).join('/').replace(/\/+/g, '/');
    if (!seen.includes(rel)) seen.push(rel);
  }
  if (!seen.length) {
    throw new Error(`build-graph: ${EMITTER_REL} names no \`path.join(REPO, ...)\` repo path — `
      + 'that script reads this repo (VERSION, PINS.md, deps/clode, the engine recipe) to bake '
      + 'its defines, so zero means the shape moved and the bundle step\'s declared inputs '
      + 'silently shrank to the libexec walk. Fix this reader; do not hardcode the paths here.');
  }
  const inputs = [];
  for (const rel of seen) {
    if (outDirs.has(rel)) continue; // that join IS the step's output dir, not an input
    if (!isFile(rel)) {
      throw new Error(`build-graph: ${EMITTER_REL} joins the repo path '${rel}', which is `
        + 'neither a readable file nor this step\'s output directory. Either the emitter names '
        + 'something that is not there, or this reader is parsing a shape it does not '
        + 'understand — both make the bundle step\'s declared inputs wrong.');
    }
    inputs.push(rel);
  }
  return inputs;
}

function bundleInputs(ctx) {
  const c = ctx && ctx.repo ? ctx : { repo: REPO };
  const libexec = path.join(c.repo, 'libexec');
  const walk = (dir) => {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...walk(p));
      else if (/\.(cjs|mjs|js)$/.test(e.name)) out.push(posixRel(c.repo, p));
    }
    return out;
  };
  const derived = emitterInputPaths({
    src: fs.readFileSync(path.join(c.repo, EMITTER_REL), 'utf8'),
    outDirs: new Set(bundleOutputPaths(c).map((p) => posixRel(c.repo, path.dirname(p)))),
    isFile: (rel) => {
      try { return fs.statSync(path.join(c.repo, rel)).isFile(); } catch { return false; }
    },
  });
  const out = walk(libexec);
  for (const rel of derived) if (!out.includes(rel)) out.push(rel);
  return out;
}

function posixRel(repo, abs) {
  return path.relative(repo, abs).split(path.sep).join('/');
}

// Every `inputs`/`outputs` answer is an ABSOLUTE path resolved against the context's repo.
// The derivations above speak the vocabulary their source of truth speaks (engine-recipe
// hands back root-relative POSIX, because that is what it hashes), and this is the one
// place the two meet -- so the runner's "did this step's outputs appear?" check and the
// renderer's artifact view never have to guess which of the two they were handed.
function absAll(ctx, rels) {
  return rels.map((r) => path.resolve(ctx.repo, r));
}

// ---- the 42 legs, as ONE parameterization ---------------------------------------------

// A tier's legs by their OWN unique identity: the leg token. 42 of them at the release
// tier, all distinct, which scripts/tjs-legs.mjs's own tests already pin.
function legs(tier) {
  const { legsFor } = require('./tjs-legs.mjs');
  return legsFor(tier || 'release').map((l) => l.leg);
}

// The DISTINCT canonical target names a tier builds — FEWER than its legs, on purpose.
// canonical-name.cjs's targetName() drops the libc qualifier by design (a published asset
// name carries no `-musl`), so linux-riscv64-musl and linux-riscv64 collapse onto one name,
// as do the two s390x legs. That is right for a NAME and wrong for a KEY: the first cut of
// this file built a Map keyed on the collapsed name, which silently kept the LAST of each
// colliding pair and answered runsOn for whichever that happened to be. Both pairs agree
// today, so it was latent — but answering for a leg nobody asked about is exactly the
// resolving-for-the-wrong-machine class runsOn exists to express.
function targets(tier) {
  const out = [];
  for (const leg of legs(tier)) {
    const t = canonical.targetName(leg);
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

// Every leg descriptor a name selects. A LEG TOKEN selects exactly one; a canonical TARGET
// name selects every leg that collapses onto it. A name the manifest does not know selects
// none, and the caller then gets the step's own native answer — honest, because a target
// with no leg descriptor has nothing to say about where anything runs.
function legsNamed(name, tier) {
  const { legsFor } = require('./tjs-legs.mjs');
  return legsFor(tier || 'release').filter(
    (l) => l.leg === name || canonical.targetName(l.leg) === name);
}

// WHERE a leg's engine compile happens, derived from the leg descriptor: a cross toolchain
// (a pinned image, a Dockerfile built in CI, or a NetBSD build.sh sysroot) or an alpine
// container compiles in a CONTAINER; a `qemu-*` guest-platform bakes in our own qemu system
// emulation; every other named guest-platform is a VM guest; anything else is the runner
// itself.
//
// THIS IS NOT THE SAME RULE AS CI'S, and the sentence that said it was is the correction
// (re-review, finding 2). .github/actions/build-leg/action.yml's "Resolve the exec mode"
// step answers a DIFFERENT question -- which orchestration mode the leg runs in, i.e. where
// vendor and out live -- and its `case` sends `alpine` down `*) exec=host` (action.yml:188-192)
// while this function answers 'container' for it. Both are right about their own question:
// the alpine legs really do compile inside a docker container, and the YAML calls that
// `host` because the container bind-mounts the runner's filesystem. NOTHING pins the two
// together, and the YAML ENUMERATES its guest platforms where this says "anything
// non-native", so a tenth guest OS drifts silently. Recorded in BACKLOG.md, "The build
// graph names one machine and CI names another"; reconciling them is a decision, not an
// edit, and it is not made here.
function engineHomeForLeg(leg) {
  if (!leg) return 'host';
  if (leg['cross-image'] || leg['cross-dockerfile'] || leg['netbsd-src']) return 'container';
  const gp = leg['guest-platform'] || 'native';
  if (gp === 'alpine') return 'container';
  if (gp.startsWith('qemu-')) return 'qemu-guest';
  if (gp !== 'native') return 'guest';
  return 'host';
}

// WHERE a leg's builder is blobulated. build-leg runs the whole blobulate inside the guest
// for VM legs (their binaries have no binfmt escape); the qemu and cross legs
// CROSS-blobulate on the x64 runner, and a native leg blobulates where it built.
function blobulateHomeForLeg(leg) {
  return engineHomeForLeg(leg) === 'guest' ? 'guest' : 'host';
}

// `runsOn` for one step of one name. The step declares its NATIVE answer (what `./build.sh`
// does on this machine); a leg token or target name re-homes exactly the two steps that
// move.
function runsOnFor(step, target, tier) {
  if (!target) return step.runsOn;
  return runsOnForLegs(step, legsNamed(target, tier), target);
}

// PURE, and it REFUSES rather than picking. A canonical target name can select more than
// one leg (the musl/glibc twins), and when those legs disagree about where a step runs
// there is no right answer to return — silently taking one is how a plan resolves an engine
// for the wrong machine, which on 2026-09-20 nearly rsynced an x86-64 ELF into a NetBSD
// guest. Today both pairs agree, so this refusal is a tripwire, not a live branch; it is
// controlled in test/build-gates/build-graph-gates.test.cjs so "it never fires" cannot
// quietly become "it cannot fire".
function runsOnForLegs(step, selected, name) {
  if (!selected.length) return step.runsOn;
  const answers = [];
  for (const leg of selected) {
    const home = step.id === 'engine.compile' ? engineHomeForLeg(leg)
      : step.id === ROOT_ID ? blobulateHomeForLeg(leg)
        // The source phase runs on the RUNNER for every leg — including the cross-container,
        // alpine and VM-guest legs, whose own target is a different machine entirely (see the
        // "Construct the patched tjs tree from pins" step's own note). Bytecode regen is
        // canonical-LE and therefore target-independent, which is the whole reason
        // --regen-only exists: the runner generates, the guest compiles a complete tree.
        : step.runsOn;
    if (!answers.includes(home)) answers.push(home);
  }
  if (answers.length > 1) {
    throw new Error(`build-graph: '${name}' names ${selected.length} legs `
      + `(${selected.map((l) => l.leg).join(', ')}) that disagree about where ${step.id} runs `
      + `(${answers.join(' vs ')}). Name the LEG, not the collapsed target: canonical-name.cjs `
      + 'drops the libc qualifier for the published asset name, and two legs that share a name '
      + 'do not have to share a machine.');
  }
  return answers[0];
}

// ---- the context a step's inputs/outputs/run are resolved against -----------------------

// ONE FIELD, DERIVED ONCE, ON FIRST READ. A context field is a QUESTION about this machine,
// and `defineLazy` is what makes asking it cost nothing until somebody wants the answer.
// Memoised so a field that four steps read is still one `sw_vers`; a thunk that THREW is
// deliberately NOT memoised, so the refusal is re-raised (identically) on every later read
// rather than being cached as a value. The setter keeps a context assignable the way a
// plain object was -- a caller that writes `ctx.engine = ...` gets what it wrote, and the
// derivation is never consulted.
function defineLazy(ctx, key, derive) {
  let has = false;
  let value;
  Object.defineProperty(ctx, key, {
    enumerable: true,
    configurable: true,
    get() {
      if (!has) { value = derive(); has = true; }
      return value;
    },
    set(v) { value = v; has = true; },
  });
}

// Every path a step names comes from here, so the runner, the renderer and a `--target`
// cross build all resolve the same answers. Overridable field by field; nothing is read
// from the environment except through the sources of truth that own it.
//
// NOTHING DERIVED IS RESOLVED EAGERLY, and that is the shape of a CLASS of defect rather
// than a style choice. Twice now this function has demanded a host fact on behalf of work
// that never used it:
//
//   1. `engine` fell through to platform-tag's tjsBin on machines that redirect the build's
//      output with CLODE_TJS_OUT, so `engine.compile`'s declared OUTPUT named a path the
//      build never writes (see that field's note below).
//   2. `toolchain` called platformTag.toolchainDir() -- and so osToken(), and so
//      `os.release()` -- for EVERY context on EVERY machine, including a `--only
//      engine.compile --needs assume` in a NetBSD or DragonFly VM guest that never bundles
//      anything. Under tjs those guests report an empty `os.release()`, platform-tag
//      correctly REFUSES to name an artifact `netbsd-`, and the refusal landed on a build
//      that had not asked the question: CI run 35667585073, both guests, 25s in, before the
//      first step ran. The old spelling (`scripts/build-tjs.cjs` directly, same engine,
//      same guest) never asked, because CLODE_TJS_OUT and CLODE_TJS_VENDOR told it
//      everything it needed.
//
// The cure for both, and for the third one nobody has hit yet, is that a context COSTS
// NOTHING TO BUILD: each field is a thunk resolved on first read, so the only host facts a
// run demands are the ones the SELECTED work actually names. The machines that most need
// `--needs assume` -- containers, cross images, VM guests -- are exactly the ones that can
// answer the fewest questions about themselves, and CI hands them the answers that matter
// in the environment.
//
// THE REFUSALS ARE NOT WEAKENED BY THIS. A step whose boundary genuinely names a
// floor-keyed path (`engine` with no CLODE_TJS_OUT, `toolchain`, an artifact name) still
// gets platform-tag's error, verbatim, at the moment it reads the field. Laziness moves
// WHEN the question is asked, never WHETHER it is answered honestly. test/build-graph.test.cjs
// drives both halves on a host that cannot name itself.
function defaultContext(overrides) {
  const o = overrides || {};
  const env = o.env || process.env;
  const repo = o.repo || REPO;
  const ctx = Object.assign({}, o, { repo, env });
  // This host, in the one canonical vocabulary, when the caller names none. Only the
  // bootstrap output name and the trace's own metadata read it.
  defineLazy(ctx, 'target', () => o.target
    || canonical.targetFromNode(process.platform, process.arch));
  // The patched txiki.js checkout scripts/build-tjs.cjs constructs and compiles.
  defineLazy(ctx, 'checkout', () => o.checkout
    || path.join(platformTag.tjsVendorParentDir(env), 'txiki.js'));
  // The engine this build produces and then blobulates against.
  //
  // CLODE_TJS_OUT IS READ HERE, and it is the knob every CI leg sets. scripts/build-tjs.cjs
  // installs the engine at `CLODE_TJS_OUT || platformTjsDir(repo)` (its :207), while this
  // field used to fall straight through to platform-tag's tjsBin -- so on ANY machine that
  // redirects the output (all 42 legs: the native build, the alpine container, the cross
  // images, the VM guests, cross-blobulate's separate host tree) `engine.compile`'s declared
  // OUTPUT named a path the build never writes, and the runner's output check would have
  // refused a perfectly good engine. Found while migrating those call sites onto step ids;
  // it never bit before because no leg ran the graph. The exe suffix is tjsBin's own rule,
  // not a second copy of build-tjs.cjs's `outName` (which keys off what cmake emitted).
  //
  // CLODE_TJS still wins: it names an engine the caller already HAS, which is a stronger
  // statement than where a build would put one.
  defineLazy(ctx, 'engine', () => o.engine || env.CLODE_TJS
    || (env.CLODE_TJS_OUT
      ? path.join(env.CLODE_TJS_OUT, process.platform === 'win32' ? 'tjs.exe' : 'tjs')
      : platformTag.tjsBin(repo)));
  // The build-only toolchain (esbuild) the bundle step provisions for ITSELF. A THIRD
  // out-of-repo root, and it is here because it was a real UNDECLARED INPUT (final
  // whole-branch review, finding 4): scripts/build-clode-main.mjs resolves
  // toolchainDir(REPO) and requires esbuild from there, and because that path is not a
  // `path.join(REPO, ...)` it is invisible to emitterInputPaths — so the graph said
  // nothing about it and the artifacts view drew a picture that implied it was not there.
  // It has a scar too: this directory being reaped by com.apple.bsd.dirhelper surfaced
  // from inside esbuild rather than as a refused step. Named from platform-tag.cjs's own
  // toolchainDir, the function the emitter calls, never a second spelling of $TMPDIR.
  //
  // IT IS ALSO THE FIELD THAT COST TWO CI LEGS (see this function's header): it is keyed by
  // platformTag(), which needs the host's compatibility floor, and until it was made lazy
  // every context on every machine paid for it whether or not anything bundled.
  defineLazy(ctx, 'toolchain', () => o.toolchain || platformTag.toolchainDir(repo));
  // WHICH MACHINE a step's `run` resolves against. Only runBuildTjs branches on it today
  // (its win32 node fallback), and it is a context field rather than a process read so
  // that branch is OBSERVABLE from both sides on any box -- see hostPlatform().
  defineLazy(ctx, 'platform', () => o.platform || process.platform);
  // The output name depends on the target (see bootstrapOut), so it reads the field rather
  // than a second copy of the derivation -- and reading it is what resolves it.
  defineLazy(ctx, 'out', () => bootstrapOut(o.out, ctx.target));
  return ctx;
}

// `clode bootstrap`'s output name, from the function `clode bootstrap` ACTUALLY CALLS --
// libexec/clode-build.cjs's exported resolveBuildOut -- rather than a second copy of its
// rule. The restatement this replaces keyed `.exe` off the HOST
// (`process.platform === 'win32'`), while resolveBuildOut keys it off the TARGET, so the
// two had already diverged: defaultContext({ target: 'windows-amd64' }) on a mac declared
// `clode-native` for a build that writes `clode-native.exe`. An explicit `out` is passed
// STRAIGHT THROUGH to it as well, so the "--out for a windows target gains .exe" half of
// that rule is composed too instead of being lost.
//
// Required lazily, like the two ESM sources: clode-build.cjs is the builder itself, and
// merely loading the declaration must not drag it in.
function bootstrapOut(out, target) {
  const { resolveBuildOut } = require('../libexec/clode-build.cjs');
  return resolveBuildOut({ out, target, self: true, hostPlatform: process.platform });
}

function ctxOf(ctx) {
  return ctx && ctx.repo ? ctx : defaultContext(ctx);
}

// ---- running a step ---------------------------------------------------------------------

// THE ONE PLACE A STEP SHELLS OUT, and the exec it uses comes from the CONTEXT rather than
// from this module's closure. That is what makes `execFileSyncFn` a real seam instead of a
// knob: scripts/build-runner.cjs threads an injected exec through the same ctx every step's
// inputs/outputs are resolved against, so a test can drive the DECLARED steps -- not just
// synthetic fixtures -- without spawning cmake. Defaulting to the real execFileSync keeps
// every existing caller unchanged, and test/build-graph.test.cjs pins BOTH directions,
// because only the pair distinguishes "the injection was used" from "nothing ran at all".
function sh(ctx, file, args, extraEnv) {
  const exec = (ctx && ctx.execFileSync) || execFileSync;
  exec(file, args, {
    cwd: ctx.repo,
    stdio: 'inherit',
    env: extraEnv ? Object.assign({}, ctx.env, extraEnv) : ctx.env,
  });
}

// THE PLATFORM COMES FROM THE CONTEXT, for the reason the exec does (see sh() above). The
// win32 branch below is the ONE place a step's behaviour depends on which machine it is
// resolved for, and reading process.platform directly made that branch unobservable: the
// route derivation below can only ever watch the half of this function the host happens to
// take, so the Windows fallback would be invisible on every developer box and the POSIX
// route invisible on the Windows leg. Threaded through ctx, both halves are observable
// everywhere and the answer is the SAME on every machine -- which is what the page claims,
// since docs/build.md's Windows caveat is not a statement about the box generating it.
function hostPlatform(ctx) {
  return (ctx && ctx.platform) || process.platform;
}

// The ONE way this repo runs scripts/build-tjs.cjs: scripts/build-tjs-boot.sh resolves an
// engine (CLODE_TJS -> local -> cache -> a sha-verified slice of the published pack) and
// runs the build UNDER it through HEAD's node-shim loader, printing one greppable
// `build-tjs-engine: engine=<tjs|node|none>` verdict. Windows is the one call site that
// stays on node, for build-leg's two recorded reasons: nothing has ever run that wrapper on
// win32, and provisionBundleInputs returns immediately there because it has no POSIX sh to
// spawn by an absolute path.
function runBuildTjs(ctx, site, flags) {
  if (hostPlatform(ctx) === 'win32') {
    return sh(ctx, 'node', ['scripts/build-tjs.cjs'].concat(flags));
  }
  return sh(ctx, path.join(ctx.repo, 'scripts', 'build-tjs-boot.sh'), [site].concat(flags));
}

// `node`, spelled as CI spells it, NOT process.execPath: under the shim process.execPath is
// the tjs engine, and these two entry points are ESM the CJS shim cannot host (recorded in
// build-leg's own note listing the six). A step that still needs Node says so out loud
// rather than resolving to whatever is running the graph.
function runNode(ctx, args, extraEnv) {
  return sh(ctx, 'node', args, extraEnv);
}

// ---- which steps STILL NEED NODE, derived rather than listed ------------------------------
//
// WHY THIS IS DERIVED. docs/build.md has to tell a developer whether `./build.sh` works on a
// machine with no node, and today the honest answer is "most of the way". A sentence naming
// the two steps that shell out would be true on the day it was written and silently wrong the
// moment one of them is converted -- which is the exact rot docs/build.md is generated to
// avoid, arriving as prose instead of as a stale word. So the page asks the graph, and the
// graph reads its own steps: a step needs node iff its `run` CALLS runNode, and the entry
// points it names are the `scripts/...` literals in that same call. Convert stage0.mjs to
// CommonJS and stop calling runNode, and the page loses the row by itself.
//
// Reading function source is the price of not keeping a second list. The alternative -- a
// `needsNode: true` field beside `run` -- is a list, in the one place where a list and the
// code it describes can disagree without anything noticing.
const RUN_NODE_CALL = /\brunNode\s*\(/;
const SCRIPT_LITERAL = /['"`](scripts\/[^'"`]+)['"`]/g;

function nodeSteps(list) {
  const steps = list || STEPS;
  const out = [];
  for (const s of steps) {
    if (typeof s.run !== 'function') continue;
    const src = String(s.run);
    if (!RUN_NODE_CALL.test(src)) continue;
    const entries = [];
    SCRIPT_LITERAL.lastIndex = 0;
    let m;
    while ((m = SCRIPT_LITERAL.exec(src)) !== null) {
      if (!entries.includes(m[1])) entries.push(m[1]);
    }
    out.push({ id: s.id, entries });
  }
  return out;
}

// The one step-shaped node dependency the derivation above CANNOT see, because it is not a
// step's own decision: runBuildTjs sends the engine phase through scripts/build-tjs-boot.sh
// everywhere except win32, where it falls back to node. Derived from that function's source
// for the same reason as nodeSteps -- so the page's Windows caveat disappears on its own if
// the fallback ever does, rather than outliving it.
function engineNodeOnWindows() {
  const src = String(runBuildTjs);
  return /win32/.test(src) && /sh\(\s*ctx,\s*'node'/.test(src);
}

// ---- what a step ACTUALLY spawns: OBSERVED, not read about --------------------------------
//
// WHY THIS EXISTS (re-review, finding 1 -- MAJOR). The first answer to "does any step reach
// node by a route nodeSteps() cannot see" was a text parse of this file's own source (it is
// still below, in a narrower role). The re-reviewer blinded it with one token: the mutation
//
//     const hop = (ctx, args) => runNode(ctx, args);
//
// in place of `function hop(ctx, args) { ... }`. The parse reported ZERO findings, all 104
// build-graph tests stayed green, and the regenerated, COMMITTED docs/build.md read "1 of
// the 5 declared steps shell out to node" while the build shelled out in two. A reader that
// a restyled binding can silence answers "no step needs node" exactly the way a node-free
// build does, which is the defect this whole branch exists to remove -- so replacing it with
// a cleverer parse would have been the same defect with a bigger regex.
//
// SO THE PROPERTY IS OBSERVED INSTEAD OF READ. Every step's `run` is DRIVEN, with a
// RECORDING exec in the context, and the programs it actually spawns are compared against
// what nodeSteps() reports. Nothing is parsed, so no binding shape, rename, formatter or
// arrow can hide a route: whatever the code does, the recorder sees. The seam already
// exists and is already proven -- sh() takes its exec from the context (see its note), and
// test/build-graph.test.cjs's "a step shells out through the CONTEXT's exec" drives BOTH
// directions, so "the injection was honoured" is not something this derivation assumes.
//
// BOTH PLATFORMS, ALWAYS, so the answer does not depend on the box. runBuildTjs's win32
// fallback is the one platform branch in the graph; each step is driven once with
// `platform: 'linux'` and once with `platform: 'win32'`, and a step that reaches node ONLY
// under win32 is reported as `windowsOnly` rather than as a finding -- because docs/build.md
// discloses THAT route separately, through engineNodeOnWindows(). The gate beside this pins
// the two to agree, so the exclusion cannot outlive the disclosure.
//
// WHAT THIS CANNOT SEE, stated plainly rather than left to be discovered: a spawn that
// bypasses the context's exec entirely (a step calling node:child_process directly) never
// reaches the recorder. That is exactly the gap the source parse below still covers, and it
// is why both readers are kept.
//
// PURE with respect to the repo: it takes the steps and a context, so a control can be a
// synthetic step reaching node through any shape at all.

const POSIX_PROBE = 'linux';
const WIN32_PROBE = 'win32';

function isNodeProgram(file) {
  const base = path.basename(String(file)).toLowerCase();
  return base === 'node' || base === 'node.exe';
}

// Drive ONE step's `run` with a recording exec and answer what it spawned. The recorder
// returns '' rather than throwing a sentinel, so a `run` that spawns more than once is seen
// completely -- an early throw would report the first program and call the rest invisible.
function observeStep(step, ctx, platform) {
  const spawns = [];
  // DERIVED FROM the context rather than COPIED OUT OF IT (`Object.create`, not
  // `Object.assign({}, ctx, ...)`), because a copy READS every field -- and defaultContext's
  // fields are lazy precisely so a machine is never asked a question the work does not need
  // (see its header). Spreading them here would ask all of them, on behalf of a recorder
  // that wants two. The two overrides are own properties, so they win over the inherited
  // derivations without resolving them.
  const own = (value) => ({ value, enumerable: true, configurable: true, writable: true });
  const probe = Object.create(ctx, {
    platform: own(platform),
    execFileSync: own((file, args) => {
      spawns.push({ file: String(file), args: (args || []).map(String) });
      return '';
    }),
  });
  step.run(probe);
  return spawns;
}

// The `scripts/...` entry points an observed argv names -- the same vocabulary nodeSteps()
// reports, so the two lists are comparable without either side translating.
function argvEntries(spawns) {
  const out = [];
  for (const c of spawns) for (const a of c.args) {
    if (a.indexOf('scripts/') === 0 && !out.includes(a)) out.push(a);
  }
  return out;
}

// { steps, ctx } -> { findings, examined, windowsOnly, observed }.
//
// `examined` counts (step, platform) drives that actually RECORDED a spawn. Zero means no
// step reached the recorder at all -- a graph that spawns nothing, or a recorder that is no
// longer consulted -- and the guard's floor turns that into BROKEN rather than into the
// clean bill of health it reads like.
function observedNodeRouteFindings(inputs) {
  const list = (inputs && inputs.steps) || [];
  const ctx = ctxOf(inputs && inputs.ctx);
  const declared = new Map(nodeSteps(list).map((r) => [r.id, r.entries]));
  const findings = [];
  const windowsOnly = [];
  const observed = [];
  let examined = 0;

  for (const s of list) {
    if (typeof s.run !== 'function') continue;
    let posix;
    let win;
    try {
      posix = observeStep(s, ctx, POSIX_PROBE);
      win = observeStep(s, ctx, WIN32_PROBE);
    } catch (e) {
      findings.push(`${s.id}: driving its \`run\` with a recording exec threw `
        + `(${(e && e.message) || e}) — this derivation answers "which steps reach node" by `
        + 'RUNNING each step against a recorder, so a `run` that cannot be driven is a step '
        + 'whose node dependency nothing can observe. Keep `run` free of work that needs a '
        + 'real filesystem or a real child process; the exec it calls is injected.');
      continue;
    }
    if (posix.length) examined += 1;
    if (win.length) examined += 1;
    const nodePosix = posix.filter((c) => isNodeProgram(c.file));
    const nodeWin = win.filter((c) => isNodeProgram(c.file));
    observed.push({
      id: s.id,
      programs: posix.map((c) => c.file),
      windowsPrograms: win.map((c) => c.file),
      entries: argvEntries(nodePosix),
      // THE WINDOWS ARGV TOO, and it is not symmetry for its own sake. runBuildTjs's win32
      // branch is the ONLY place `scripts/build-tjs.cjs` is named at all, so without this
      // field the engine phase's entry point is invisible to anything asking the graph what
      // the build shells out to -- and test/build-graph-ci.test.cjs asks exactly that, to
      // derive the CI call sites it must refuse rather than keeping a list of them.
      windowsEntries: argvEntries(nodeWin),
    });

    if (nodePosix.length && !declared.has(s.id)) {
      findings.push(`${s.id} SPAWNS \`${nodePosix.map((c) => c.file).join(', ')}\` when its `
        + '`run` is driven, and nodeSteps() does not report it — so docs/build.md is about to '
        + 'claim a smaller node dependency than the build has. This is OBSERVED, not parsed: '
        + 'the step really reached node, whatever shape the helper it went through is written '
        + 'in. Route it through runNode, or widen nodeSteps() to see this route.');
    } else if (!nodePosix.length && !nodeWin.length && declared.has(s.id)) {
      findings.push(`nodeSteps() reports ${s.id}, but driving its \`run\` spawned `
        + `${posix.length ? `\`${posix.map((c) => c.file).join(', ')}\`` : 'nothing'} and no `
        + 'node — either that step stopped needing node and the derivation has not noticed, '
        + 'or nodeSteps() is matching a `runNode` mention that no longer runs.');
    } else if (nodePosix.length && declared.has(s.id)) {
      const want = declared.get(s.id);
      const got = argvEntries(nodePosix);
      const missing = want.filter((e) => !got.includes(e));
      const extra = got.filter((e) => !want.includes(e));
      if (missing.length || extra.length) {
        findings.push(`${s.id}: docs/build.md names \`${want.join(', ') || '(none)'}\` as the `
          + `entry point(s) this step needs node for, but it actually ran node on `
          + `\`${got.join(', ') || '(none)'}\``
          + (missing.length ? ` (missing ${missing.join(', ')})` : '')
          + (extra.length ? ` (unannounced ${extra.join(', ')})` : '')
          + ' — the page names the files a reader is being asked to convert, so a wrong list '
          + 'sends them to the wrong file.');
      }
    }
    if (!nodePosix.length && nodeWin.length) windowsOnly.push(s.id);
  }
  return { findings, examined, windowsOnly, observed };
}

// ---- a step that REACHES node by a route nodeSteps() cannot see ---------------------------
//
// SECOND READER, NARROWER JOB (re-review, finding 1). What follows is a text parse of this
// module's own source. It is NOT the gate on "every step that reaches node is one
// nodeSteps() reports" any more -- observedNodeRouteFindings() above is, by watching the
// steps run -- because a parse can be blinded by a binding style and an observation cannot.
// It is kept for the ONE thing observation cannot do: see a node spawn that never goes
// through the context's exec (a direct node:child_process call), which the recorder would
// never hear about. Read it as a source-shape tripwire, not as the property.
//
// ITS KNOWN BLIND SPOT, stated rather than discovered: an INTERMEDIARY bound as
// `const hop = (ctx, a) => runNode(ctx, a)` or `const runner = runNode` is not a `function`
// declaration, so the transitive closure below does not follow it. The spawn itself is
// still attributed to runNode, so nothing is reported. That is precisely the hole the
// observation above closes; do not re-point a gate at this reader.
//
// WHY THIS EXISTS (final whole-branch review, finding 1). nodeSteps() above matches a DIRECT
// `runNode(` in a step's own `run`. The reviewer added a third helper --
// `function runNodeAlias(ctx, args) { return sh(ctx, 'node', args); }` -- pointed
// bundle.clode-main at it, and watched docs/build.md silently drop from "2 of the 5 declared
// steps" to "1 of the 5" with NOTHING in the suite reddening except gate 4, the STALENESS
// gate, and only because the COMMITTED page changed. Regenerate the page -- which is exactly
// what the page's own "Changing the build" section instructs -- and the omission becomes
// permanent and green. Add a NEW step by that route and there was never a row to lose, so
// gate 4 cannot notice at all. A gate that can only see a change to a committed file is not
// a gate on the property.
//
// WHAT IT STILL SAYS: which named functions in the source reach a node spawn, the
// `function`-declared helpers that transitively call one, and -- the half that carries its
// weight now -- every node spawn site it CANNOT attribute to a named function at all. That
// last one is the "this reader has gone blind on the shape" signal, and a blind reader that
// answers "no routes" reads exactly like a build with none.
//
// PURE, taking the source and the step list, so the control can be the reviewer's exact
// mutation rather than a corrupted repo. test/build-gates/build-graph-gates.test.cjs is that
// control.
//
// THE ONE EXCLUSION IS DERIVED TOO. runBuildTjs's node spawn sits behind a `win32` branch,
// and the page discloses THAT route separately, through engineNodeOnWindows(). So a
// platform-guarded route is reported as `windowsOnly` rather than as a finding -- and the
// test beside the guard pins the two derivations to agree, so the exclusion cannot outlive
// the disclosure. The classification is per-FUNCTION and deliberately coarse, exactly as
// coarse as engineNodeOnWindows() itself: a function whose body mentions win32 AND spawns
// node is read as the windows fallback. An UNGUARDED node spawn added inside that same
// function would be mis-read by both, which is the one edge this pair cannot see.
//
// THE COMPLEMENT is gate 1 in test/build-graph.test.cjs ("a step shells out through the
// CONTEXT's exec"): a spawn that bypassed sh() altogether reddens there. A node spawn this
// reader cannot attribute to a named function -- an arrow-function helper, say -- is a
// finding below rather than a silence, because that is the shape this derivation could
// otherwise go blind on.
// A spawn-ish call whose FIRST or SECOND argument is the literal 'node' -- `sh(ctx,
// 'node', ...)` as this file spells it, and `execFileSync('node', ...)` as anything
// bypassing sh() would.
const NODE_SPAWN = new RegExp(
  '\\b(?:sh|exec|execFile|execFileSync|spawn|spawnSync)\\s*\\('
  + '\\s*(?:[\'"]node[\'"]|[A-Za-z_$][\\w$.]*\\s*,\\s*[\'"]node[\'"])', 'g');
// `async` is OPTIONAL, and that one word is a correction (re-review, finding 6). Without it
// an `async function` holding a node spawn still went red -- but as an UNATTRIBUTABLE spawn,
// telling the reader to "give the spawn a named function" about a spawn that was already
// inside one. Right verdict, wrong instruction, which sends the next person to fix the wrong
// thing.
const TOP_LEVEL_FN = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{\n([\s\S]*?)\n\}$/gm;
const PLATFORM_BRANCH = /win32/;

// PROSE ABOUT AN IDIOM IS NOT AN INVOCATION -- the narrowing test/build-graph-ci.test.cjs's
// stepIdsNamedBy() already learned, here in a file whose header QUOTES the very spawn this
// reader looks for. Whole-line `//` comments are blanked (length- and newline-preserving, so
// every index below still lines up with the real source); a TRAILING comment after code is
// deliberately left in, because the only cost of reading one is a loud false finding, while
// the cost of a too-clever strip is a spawn this reader silently stops seeing.
function maskLineComments(src) {
  return String(src).split('\n')
    .map((line) => (line.trim().startsWith('//') ? ' '.repeat(line.length) : line))
    .join('\n');
}

function moduleFunctions(src) {
  const out = [];
  TOP_LEVEL_FN.lastIndex = 0;
  let m;
  while ((m = TOP_LEVEL_FN.exec(src)) !== null) {
    out.push({ name: m[1], body: m[2], start: m.index, end: m.index + m[0].length });
  }
  return out;
}

function callsFn(body, name) {
  return new RegExp(`\\b${name}\\s*\\(`).test(body);
}

// PURE. Which named functions in `src` reach a node spawn, and by which route.
function nodeRoutes(src) {
  const text = maskLineComments(src);
  const fns = moduleFunctions(text);
  const always = new Set();
  const windows = new Set();
  for (const f of fns) {
    NODE_SPAWN.lastIndex = 0;
    if (!NODE_SPAWN.test(f.body)) continue;
    (PLATFORM_BRANCH.test(f.body) ? windows : always).add(f.name);
  }
  // Transitively: a function that CALLS a reaching function reaches node too. This is the
  // half that sees an alias, and it is why a THIRD helper cannot hide.
  for (const set of [always, windows]) {
    let grew = true;
    while (grew) {
      grew = false;
      for (const f of fns) {
        if (set.has(f.name)) continue;
        for (const name of [...set]) {
          if (!callsFn(f.body, name)) continue;
          set.add(f.name);
          grew = true;
          break;
        }
      }
    }
  }
  // A spawn site inside no named function at all: this reader has gone blind on the shape,
  // and a blind reader that answers "no routes" reads exactly like a build with none.
  const unattributed = [];
  NODE_SPAWN.lastIndex = 0;
  let m;
  while ((m = NODE_SPAWN.exec(text)) !== null) {
    if (!fns.some((f) => m.index >= f.start && m.index < f.end)) unattributed.push(m[0]);
  }
  return {
    functions: fns.map((f) => f.name), always: [...always], windows: [...windows], unattributed,
  };
}

// PURE. { src, steps } -> { findings, examined, reported, windowsOnly, routes }.
function nodeRouteFindings(inputs) {
  const src = String((inputs && inputs.src) || '');
  const list = (inputs && inputs.steps) || [];
  const routes = nodeRoutes(src);
  const reported = new Set(nodeSteps(list).map((r) => r.id));
  const findings = [];
  const windowsOnly = [];

  for (const site of routes.unattributed) {
    findings.push(`\`${site.trim()}\` spawns node outside every named function this reader `
      + 'can see, so no step can be attributed to it. Give the spawn a named function (the '
      + 'shape runNode/runBuildTjs already have) or teach this reader the shape — an '
      + 'unattributable spawn is how the route derivation goes blind while still answering.');
  }

  for (const s of list) {
    if (typeof s.run !== 'function') continue;
    const body = String(s.run);
    const direct = routes.always.filter((n) => callsFn(body, n));
    const guarded = routes.windows.filter((n) => callsFn(body, n));
    if (direct.length && !reported.has(s.id)) {
      findings.push(`${s.id} reaches node through ${direct.join(', ')}, and nodeSteps() does `
        + 'not report it — so docs/build.md is about to claim a smaller node dependency than '
        + 'the build has. nodeSteps() matches a DIRECT runNode call; this step gets there '
        + 'another way. Route it through runNode, or widen nodeSteps to see this route.');
    } else if (!direct.length && !guarded.length && reported.has(s.id)) {
      findings.push(`nodeSteps() reports ${s.id}, but no route in scripts/build-graph.cjs's `
        + 'own source reaches a node spawn from that step — either the spawn helpers moved '
        + 'out of the shape this reader parses (in which case every OTHER step\'s route is '
        + 'invisible too), or nodeSteps() is matching something that no longer runs node.');
    }
    if (!direct.length && guarded.length) windowsOnly.push(s.id);
  }
  return { findings, examined: list.length, reported: [...reported], windowsOnly, routes };
}

// ---- the steps ---------------------------------------------------------------------------

const STEPS = [
  {
    // Checkout at the PINS.md tag+sha, reset to pristine, the patch stack applied in its
    // documented order, the upstream source fixups, and the txiki JS bundles esbuilt --
    // the last of which needs esbuild and txiki's own dependency closure on disk, which
    // scripts/provision-bundle-inputs.sh puts there with no npm and no node, and which
    // scripts/bundle-inputs-gate.cjs refuses the phase without. Both of those are already
    // engine sources (they are in engine-recipe.cjs's FILES), so recipeFiles() covers them.
    id: 'engine.source',
    phase: 'engine',
    runsOn: 'host',
    needs: [],
    inputs: (ctx) => absAll(ctxOf(ctx), recipeFiles()),
    outputs: (ctx) => [ctxOf(ctx).checkout],
    count: () => patchCount(),
    run: (ctx) => runBuildTjs(ctxOf(ctx), 'graph-engine-source', ['--source-only']),
  },
  {
    // Regenerate src/bundles/c/** from src/js/** with a host-native tjsc. Canonical-LE
    // bytecode is target-independent, which is why this is its own step rather than an
    // implementation detail of the compile: the netbsd-sparc leg bakes its engine inside a
    // 512MB sun4m guest with no node (spike/quickjs/qemu/ci-guest-bake.sh), so generation
    // happens HERE and the guest compiles an already-complete tree. One step means every
    // leg's bytecode comes out of the same code and no path can quietly compile the
    // upstream pin's committed bytecode instead.
    id: 'engine.bytecode',
    phase: 'engine',
    runsOn: 'host',
    needs: ['engine.source'],
    inputs: (ctx) => [path.join(ctxOf(ctx).checkout, 'src', 'js')],
    outputs: (ctx) => [path.join(ctxOf(ctx).checkout, 'src', 'bundles', 'c')],
    run: (ctx) => runBuildTjs(ctxOf(ctx), 'graph-engine-bytecode', ['--regen-only']),
  },
  {
    // cmake + the smoke. This is the step whose interior belongs to cmake, not to this
    // graph. Its inputs are the whole engine source set, because that is precisely what
    // the recipe hash -- and therefore the tjs build cache -- is keyed on.
    id: 'engine.compile',
    phase: 'engine',
    runsOn: 'host',
    needs: ['engine.bytecode'],
    inputs: (ctx) => [path.join(ctxOf(ctx).checkout, 'src', 'bundles', 'c')]
      .concat(absAll(ctxOf(ctx), recipeFiles())),
    outputs: (ctx) => [ctxOf(ctx).engine],
    run: (ctx) => runBuildTjs(ctxOf(ctx), 'graph-engine-compile', ['--build-only']),
  },
  {
    // esbuild clode's own entry points. Platform-INDEPENDENT pure JS, so it needs no
    // engine and shares no edge with the engine phase -- the two halves of the build run
    // side by side and only meet at the blobulate.
    id: 'bundle.clode-main',
    phase: 'bundle',
    runsOn: 'host',
    needs: [],
    // NO `provisions` FIELD HERE, and that is the point: which step provisions the
    // build-only toolchain is DERIVED and attached by attachProvisions() below, from the
    // entry points this step actually runs. See that function for why a hand-placed field
    // was the wrong shape.
    inputs: (ctx) => absAll(ctxOf(ctx), bundleInputs(ctxOf(ctx))),
    outputs: (ctx) => bundleOutputPaths(ctxOf(ctx)),
    count: () => bundleOutputNames().length,
    run: (ctx) => runNode(ctxOf(ctx), ['scripts/build-clode-main.mjs']),
  },
  {
    // `clode bootstrap`: append the member archive + manifest + bootstrap to a copy of the
    // engine as a canonical-LE trailer, carrying the PRISTINE base engine as a member so
    // the result can build a quaude on a machine that has nothing. This is what `./build.sh`
    // produces, and it is where the two phases above meet.
    id: ROOT_ID,
    phase: 'blobulate',
    runsOn: 'host',
    needs: ['engine.compile', 'bundle.clode-main'],
    inputs: (ctx) => [ctxOf(ctx).engine].concat(bundleOutputPaths(ctxOf(ctx))),
    outputs: (ctx) => [path.resolve(ctxOf(ctx).repo, ctxOf(ctx).out)],
    run: (ctx) => {
      const c = ctxOf(ctx);
      return runNode(c, ['scripts/stage0.mjs', 'bootstrap', '--out', c.out], { CLODE_TJS: c.engine });
    },
  },
];

// ---- `provisions`: WHICH step, derived from what that step runs --------------------------
//
// WHY THIS IS NOT A FIELD ON THE STEP (re-review, finding 4's residual). The PATH is
// derived -- platform-tag.cjs's toolchainDir, the function the emitter itself calls -- but
// WHICH STEP provisions it was a hand-placed field on one step, pinned only by a test
// grepping the emitter for `toolchainDir(`. That is a declaration restating something the
// code already knows, in a repo whose own rule is "derived, never declared" and which has
// watched exactly this shape rot three times (engine-recipe.cjs's FILES) and twice more
// (NODE_CONSTANTS). Point the bundle step at a different emitter, or teach a SECOND entry
// point to resolve a toolchain, and a hand-placed field is wrong with nothing to notice.
//
// THE RULE, in one sentence: a step provisions the build-only toolchain exactly when one of
// the entry points it runs node on resolves `toolchainDir(...)` for itself. Both halves of
// that come from the code -- the entry points from nodeSteps() (the step's own `run`), the
// resolution from the entry point's own source.
//
// AN EMPTY ANSWER IS REFUSED -- by the GATE's form of it, `toolchainProvisionerIds`, for
// bundleOutputNamesFrom's reason: a derivation that can answer "nobody provisions anything"
// is indistinguishable from a derivation that stopped reading, and this one's whole job is
// to say that a directory nothing else in the graph mentions is real. The graph itself uses
// the non-refusing form, for the reason stated on the pair below.
const TOOLCHAIN_CALL = /\btoolchainDir\s*\(/;

// BOTH ARE PURE, so a control can hand either one entry points whose source never resolves
// a toolchain.
//
// THE RULE AND THE REFUSAL ARE SEPARATE FUNCTIONS, and that is deliberate. The refusal
// belongs to the GATE, not to the graph: a `steps()` that threw whenever this derivation
// found nothing would turn one wrong answer into "the graph cannot be read at all" —
// measured, not feared, when an early cut of this did exactly that and reddened four
// unrelated guards with a message about a toolchain. It is the same reason orphanFindings
// refuses a root it was not given rather than calling every step an orphan: a symptom that
// swamps the diagnosis is worse than the defect.
function toolchainProvisionerIdsOrNone(rows, readSource) {
  const ids = [];
  for (const row of rows) {
    if (row.entries.some((rel) => TOOLCHAIN_CALL.test(String(readSource(rel) || '')))) {
      ids.push(row.id);
    }
  }
  return ids;
}

function toolchainProvisionerIds(rows, readSource) {
  const ids = toolchainProvisionerIdsOrNone(rows, readSource);
  if (!ids.length) {
    throw new Error('build-graph: no step\'s entry point resolves `toolchainDir(...)` any '
      + `more (looked at ${rows.length} node step(s): `
      + `${rows.map((r) => r.entries.join(' ')).join(' | ') || '(none)'}). Either the build `
      + 'stopped provisioning a build-only toolchain — in which case delete this derivation '
      + 'and the page section that draws it — or an entry point stopped spelling its '
      + 'resolution that way and the graph is now silent about an out-of-repo directory the '
      + 'build fills itself. Do not hardcode which step provisions it.');
  }
  return ids;
}

// The I/O half, memoized: attaching costs one small read of each node entry point, and
// merely LOADING this declaration must stay I/O-free (the tjs plan under the shim loads it
// before anything has a filesystem opinion), so it happens on the first `steps()`/
// `stepById()` and not at module scope.
let PROVISIONS_ATTACHED = false;
function attachProvisions() {
  if (PROVISIONS_ATTACHED) return;
  const ids = toolchainProvisionerIdsOrNone(nodeSteps(STEPS), (rel) => {
    try { return fs.readFileSync(path.join(REPO, rel), 'utf8'); } catch { return ''; }
  });
  for (const s of STEPS) {
    // NOT an `input`, and the distinction is the whole point of the field. The runner
    // treats `inputs` as an assertion checked BEFORE the step runs (build-runner.cjs's
    // checkInputs at :244, step.run at :258), and this directory does not exist on a clean
    // machine -- the step fills it itself, with npm, which is also the one moment of this
    // build that touches the network. Declared as an input it would refuse every first
    // build; left undeclared it was invisible to the graph, to the artifacts view and to
    // the page, which is what the review found.
    if (ids.indexOf(s.id) !== -1) s.provisions = (ctx) => [ctxOf(ctx).toolchain];
  }
  PROVISIONS_ATTACHED = true;
}

// ---- the graph ----------------------------------------------------------------------------

// `steps()` is the declaration. `steps({ target })` is the SAME graph with `runsOn`
// resolved for that leg -- one graph parameterized by target, never 42 graphs.
function steps(opts) {
  const o = opts || {};
  attachProvisions();
  if (!o.target) return STEPS.slice();
  return STEPS.map((s) => Object.assign({}, s, { runsOn: runsOnFor(s, o.target, o.tier) }));
}

function stepById(id) {
  attachProvisions();
  return STEPS.find((s) => s.id === id);
}

// Deterministic topological order: depth-first over the steps in DECLARATION order, so the
// same graph always renders and runs in the same sequence (a diagram that reshuffles is a
// diff nobody can read). Cycles are not handled here -- cycleFindings() is the gate that
// says so, and it runs in the suite.
function topoOrder(list) {
  const byId = new Map(list.map((s) => [s.id, s]));
  const done = new Set();
  const open = new Set();
  const out = [];
  const visit = (s) => {
    if (done.has(s.id) || open.has(s.id)) return;
    open.add(s.id);
    for (const n of s.needs) if (byId.has(n)) visit(byId.get(n));
    open.delete(s.id);
    done.add(s.id);
    out.push(s);
  };
  for (const s of list) visit(s);
  return out;
}

// Topological, stable, and optionally narrowed. `runsOn` selects the steps that execute on
// one kind of machine; `id` selects a step and everything it transitively needs (the
// subgraph a developer asks for when they want the engine alone). Both filters apply AFTER
// the ordering, so a selection never reorders what survives it.
//
// SPLIT FROM orderedSteps() so the runner can select over a graph it was HANDED (its
// synthetic controls) through the very code that selects over the declared one. The
// alternative -- a second closure-and-filter walk inside build-runner.cjs -- is the
// duplicate-list disease this whole file is a reaction to, one layer up: the controls that
// prove the runner refuses correctly would have been exercising a different selector from
// the one a real build uses.
//
// `needs: 'assume'` narrows the SAME `id` selection to the named step alone -- the caller
// is asserting that another machine already ran its `needs` and synced the outputs over.
// It lives HERE rather than in the runner for this function's own reason: a second
// closure-and-filter walk in build-runner.cjs is the duplicate-list disease one layer up,
// and the runner's synthetic controls have to exercise the selector a real build uses.
// What keeps the mode honest is not this filter but the runner's UNCHANGED input check:
// the step still refuses when a declared input is absent, which is exactly what "assume"
// is assuming.
function select(list, opts) {
  const o = opts || {};
  if (o.id) {
    if (o.needs === 'assume') {
      list = list.filter((s) => s.id === o.id);
    } else {
      const byId = new Map(list.map((s) => [s.id, s]));
      const keep = new Set();
      const up = (id) => {
        if (keep.has(id) || !byId.has(id)) return;
        keep.add(id);
        for (const n of byId.get(id).needs) up(n);
      };
      up(o.id);
      list = list.filter((s) => keep.has(s.id));
    }
  }
  if (o.runsOn) list = list.filter((s) => s.runsOn === o.runsOn);
  return list;
}

function orderedSteps(opts) {
  return select(topoOrder(steps(opts || {})), opts);
}

// ---- the shape rules, as PURE functions --------------------------------------------------
//
// Exported so the suite's gates and their positive controls drive the SAME code. A rule
// whose body lives inside a test assertion has no seam to feed a known-bad graph through,
// and a gate whose failure cannot be demonstrated is not a gate -- this repo has found
// roughly 17 that could not fail.

// `phase.name` or `phase.some-name`: a first segment with no dash (it is a phase, and the
// renderer groups on it), then one or more dashed segments.
const ID_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$/;

function shapeFindings(list) {
  const findings = [];
  const seen = new Set();
  for (const s of list) {
    const id = s && s.id;
    if (!ID_RE.test(String(id))) findings.push(`bad id: ${id}`);
    if (seen.has(id)) findings.push(`duplicate id: ${id}`);
    seen.add(id);
    if (typeof s.phase !== 'string' || !s.phase) findings.push(`${id}: phase must be a non-empty string`);
    if (!RUNS_ON.includes(s.runsOn)) findings.push(`${id}: runsOn must be one of ${RUNS_ON.join('|')}, got ${s.runsOn}`);
    if (!Array.isArray(s.needs)) findings.push(`${id}: needs must be an array`);
    if (typeof s.inputs !== 'function') findings.push(`${id}: inputs must be a FUNCTION (literals rot)`);
    if (typeof s.outputs !== 'function') findings.push(`${id}: outputs must be a FUNCTION (literals rot)`);
    if (typeof s.run !== 'function') findings.push(`${id}: run must be a function`);
    if (s.count !== undefined && typeof s.count !== 'function') findings.push(`${id}: count must be derived`);
    if (s.provisions !== undefined && typeof s.provisions !== 'function') {
      findings.push(`${id}: provisions must be a FUNCTION (literals rot) — it names an `
        + 'out-of-repo directory whose location is a machine\'s answer, not a constant');
    }
  }
  return findings;
}

// Evaluate every step's derivations against a context. This is what turns the shape rule
// ("inputs is a function") into the property that rule is only a proxy for: the function
// ANSWERS, out of a real source of truth, with real paths. A composition that quietly
// stopped reading its source would still be a function.
function evaluate(ctx, opts) {
  const c = ctxOf(ctx);
  return steps(opts).map((s) => ({
    id: s.id,
    inputs: s.inputs(c),
    outputs: s.outputs(c),
    provisions: s.provisions ? s.provisions(c) : undefined,
    count: s.count ? s.count() : undefined,
  }));
}

function evaluationFindings(records) {
  const findings = [];
  for (const r of records) {
    // `provisions` is OPTIONAL (most steps have none) but held to the same rules when it is
    // there: an empty or relative answer is the same "derivation stopped reading its source"
    // failure one field over, and it is the field that names an out-of-repo directory.
    const fields = r.provisions === undefined
      ? ['inputs', 'outputs'] : ['inputs', 'outputs', 'provisions'];
    for (const k of fields) {
      const v = r[k];
      if (!Array.isArray(v)) { findings.push(`${r.id}: ${k}() did not return an array`); continue; }
      if (!v.length) {
        findings.push(`${r.id}: ${k}() returned nothing — an empty answer is indistinguishable `
          + 'from a derivation that stopped reading its source of truth, which is the exact '
          + 'failure the function-not-literal rule exists to prevent');
      }
      for (const p of v) {
        if (typeof p !== 'string' || !p) findings.push(`${r.id}: ${k}() yielded a non-path ${JSON.stringify(p)}`);
        else if (!path.isAbsolute(p)) {
          findings.push(`${r.id}: ${k}() yielded the RELATIVE path '${p}' — the runner resolves `
            + 'existence and the renderer draws artifacts, and neither may have to guess which '
            + 'root a path is relative to');
        }
      }
    }
    if (r.count !== undefined && (!Number.isInteger(r.count) || r.count < 1)) {
      findings.push(`${r.id}: count() answered ${r.count} — a derived count is a positive integer; `
        + 'zero means the derivation found nothing to count');
    }
  }
  return findings;
}

// THE RULE THAT PROTECTS THE ENGINE RECIPE. scripts/build-tjs.cjs must not require this
// module. build-tjs.cjs's own require graph is what test/engine-recipe.test.cjs DERIVES the
// engine-source list from, so a require here would put build-graph.cjs into
// scripts/engine-recipe.cjs's FILES -- moving the recipe hash, invalidating the tjs build
// cache, and rebuilding all 42 legs every time this declaration is edited. It is the same
// rule, for the same reason, that scripts/build-tjs-boot.sh states about itself: the
// program being bootstrapped may not require its own bootstrapper. Stated as a gate rather
// than a comment because a comment has never stopped anyone adding a require.
const FORBIDDEN_REQUIRE = /require\(\s*['"]\.\/build-graph\.cjs['"]\s*\)/;

function recipeCouplingFindings(inputs) {
  const findings = [];
  if (FORBIDDEN_REQUIRE.test(inputs.buildTjsSource)) {
    findings.push('scripts/build-tjs.cjs requires build-graph.cjs — that pulls this file into '
      + "the engine recipe's derived source set, moves the recipe hash, and rebuilds all 42 "
      + 'legs on every edit to a declaration that compiles nothing. Shell out to build-tjs.cjs '
      + 'from the graph, never the other way round.');
  }
  if (inputs.recipeFiles.indexOf('scripts/build-graph.cjs') !== -1) {
    findings.push('scripts/build-graph.cjs is inside the engine recipe file set — the recipe '
      + 'hash now moves when this declaration is edited, so all 42 legs rebuild for a change '
      + 'that alters no engine source.');
  }
  return findings;
}

function danglingFindings(list) {
  const ids = new Set(list.map((s) => s.id));
  const findings = [];
  for (const s of list) for (const n of s.needs) if (!ids.has(n)) findings.push(`${s.id} -> ${n}`);
  return findings;
}

function cycleFindings(list) {
  const byId = new Map(list.map((s) => [s.id, s]));
  const state = new Map();
  const findings = [];
  const visit = (id, trail) => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'open') { findings.push(trail.concat(id).join(' -> ')); return; }
    state.set(id, 'open');
    for (const n of (byId.get(id) || { needs: [] }).needs) visit(n, trail.concat(id));
    state.set(id, 'done');
  };
  for (const s of list) visit(s.id, []);
  return findings;
}

// Gate 5. An orphan is a step THE ROOT DOES NOT TRANSITIVELY NEED: work `./build.sh` would
// never do, accumulating silently while the diagram lies by addition -- it draws work no
// build performs.
//
// REACHABILITY IS COMPUTED UPWARD FROM THE ROOT, and that is a correction (final
// whole-branch review, finding 3). The first cut walked DOWNWARD from every source step
// (one with `needs: []`), which cannot report anything the dangling and cycle gates have not
// already reported: given a graph that passes those two, every step's `needs` chain
// terminates at a source, so every step is reachable downward and this function is
// VACUOUS. Its control was a mutual-needs pair -- a CYCLE, which cycleFindings catches too.
// The property the spec actually asked for ("add an unreachable step; the gate names it")
// was being delivered by a plain, control-less test elsewhere in
// test/build-graph.test.cjs. It is delivered here now, by the function that carries the
// name, with a control that is a genuine orphan and nothing else.
//
// THE ROOT IS AN ARGUMENT, not a closure read, so a control can hand this a synthetic graph
// with its own root -- the seam every other finding function in this file already has. A
// root that is not in the list is REFUSED rather than answered: "every step is an orphan"
// is what a mistyped root looks like, and it reads exactly like the catastrophe it is not.
function orphanFindings(list, rootId) {
  const root = rootId || ROOT_ID;
  const byId = new Map(list.map((s) => [s.id, s]));
  if (!byId.has(root)) {
    throw new Error(`build-graph: orphanFindings was asked to walk up from '${root}', which is `
      + `not one of the ${list.length} step(s) it was given (${list.map((s) => s.id).join(', ')}). `
      + 'Every step would be reported as an orphan, which looks identical to the graph having '
      + 'come apart. Name the root of the graph you are asking about.');
  }
  const seen = new Set();
  const up = (id) => {
    if (seen.has(id) || !byId.has(id)) return;
    seen.add(id);
    for (const n of byId.get(id).needs) up(n);
  };
  up(root);
  return list.map((s) => s.id).filter((id) => !seen.has(id));
}

module.exports = {
  ROOT_ID, RUNS_ON, NEEDS, ENTRY_REL, GRAPH_REL,
  steps, stepById, orderedSteps, select, topoOrder, sh,
  legs, targets, legsNamed, runsOnFor, runsOnForLegs, engineHomeForLeg, blobulateHomeForLeg,
  defaultContext,
  recipeFiles, patchCount, bundleInputs, emitterInputPaths, EMITTER_REL,
  bundleOutputNames, bundleOutputNamesFrom, bundleOutputPaths,
  evaluate,
  shapeFindings, danglingFindings, cycleFindings, orphanFindings, evaluationFindings,
  recipeCouplingFindings,
  nodeSteps, engineNodeOnWindows, nodeRoutes, nodeRouteFindings,
  observedNodeRouteFindings, toolchainProvisionerIds,
};
