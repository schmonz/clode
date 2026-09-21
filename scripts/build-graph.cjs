'use strict';
// build-graph — the ONE declaration of what building `clode` from a clean checkout does.
//
// WHY THIS EXISTS. BACKLOG.md:4595: "Steps you can show are steps you have named, and
// steps you have named are a build graph. We do not have one." What a developer needs in
// order to build this repo is spread across 51 scripts, six npm scripts that build
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

// Where a step's work physically happens. 'host' is the machine running the build;
// 'container' is a docker toolchain image (the alpine/musl and cross legs); 'guest' is a
// VM whose binaries the host cannot exec; 'qemu-guest' is our own qemu system emulation
// (netbsd-sparc). This is what makes the graph honest across machines: a --plan bug on
// 2026-09-20 resolved an engine for the WRONG machine and would have rsynced an x86-64 ELF
// into a NetBSD guest, and a graph that pretends there is one machine cannot express that
// class of bug, let alone catch it.
const RUNS_ON = ['host', 'container', 'guest', 'qemu-guest'];

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

// WHERE a leg's engine compile happens, derived from the leg descriptor by the SAME rule
// .github/actions/build-leg/action.yml's "Resolve the exec mode" step applies: a cross
// toolchain (a pinned image, a Dockerfile built in CI, or a NetBSD build.sh sysroot) or an
// alpine container compiles in a CONTAINER; a `qemu-*` guest-platform bakes in our own
// qemu system emulation; every other named guest-platform is a VM guest; anything else is
// the runner itself.
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

// Every path a step names comes from here, so the runner, the renderer and a `--target`
// cross build all resolve the same answers. Overridable field by field; nothing is read
// from the environment except through the sources of truth that own it.
function defaultContext(overrides) {
  const o = overrides || {};
  const env = o.env || process.env;
  const repo = o.repo || REPO;
  // The target is resolved FIRST and then fed to the output name, because the output name
  // depends on it (see bootstrapOut). This host, in the one canonical vocabulary, when the
  // caller names none.
  const target = o.target || canonical.targetFromNode(process.platform, process.arch);
  return Object.assign({}, o, {
    repo,
    env,
    target,
    // The patched txiki.js checkout scripts/build-tjs.cjs constructs and compiles.
    checkout: o.checkout || path.join(platformTag.tjsVendorParentDir(env), 'txiki.js'),
    // The engine this build produces and then blobulates against.
    engine: o.engine || env.CLODE_TJS || platformTag.tjsBin(repo),
    out: bootstrapOut(o.out, target),
  });
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

// The ONE way this repo runs scripts/build-tjs.cjs: scripts/build-tjs-boot.sh resolves an
// engine (CLODE_TJS -> local -> cache -> a sha-verified slice of the published pack) and
// runs the build UNDER it through HEAD's node-shim loader, printing one greppable
// `build-tjs-engine: engine=<tjs|node|none>` verdict. Windows is the one call site that
// stays on node, for build-leg's two recorded reasons: nothing has ever run that wrapper on
// win32, and provisionBundleInputs returns immediately there because it has no POSIX sh to
// spawn by an absolute path.
function runBuildTjs(ctx, site, flags) {
  if (process.platform === 'win32') return sh(ctx, 'node', ['scripts/build-tjs.cjs'].concat(flags));
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

// ---- the graph ----------------------------------------------------------------------------

// `steps()` is the declaration. `steps({ target })` is the SAME graph with `runsOn`
// resolved for that leg -- one graph parameterized by target, never 42 graphs.
function steps(opts) {
  const o = opts || {};
  if (!o.target) return STEPS.slice();
  return STEPS.map((s) => Object.assign({}, s, { runsOn: runsOnFor(s, o.target, o.tier) }));
}

function stepById(id) {
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
function select(list, opts) {
  const o = opts || {};
  if (o.id) {
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
    count: s.count ? s.count() : undefined,
  }));
}

function evaluationFindings(records) {
  const findings = [];
  for (const r of records) {
    for (const k of ['inputs', 'outputs']) {
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

// Gate 5. Reachability is computed DOWNWARD from every source step (one with no `needs`):
// anything the build never arrives at is an orphan. Unreachable steps accumulate silently
// and the diagram then lies by addition -- it draws work that no build performs.
function orphanFindings(list) {
  const reachable = new Set();
  const down = (id) => {
    if (reachable.has(id)) return;
    reachable.add(id);
    for (const s of list) if (s.needs.includes(id)) down(s.id);
  };
  for (const s of list) if (s.needs.length === 0) down(s.id);
  return list.map((s) => s.id).filter((id) => !reachable.has(id));
}

module.exports = {
  ROOT_ID, RUNS_ON, ENTRY_REL,
  steps, stepById, orderedSteps, select, topoOrder, sh,
  legs, targets, legsNamed, runsOnFor, runsOnForLegs, engineHomeForLeg, blobulateHomeForLeg,
  defaultContext,
  recipeFiles, patchCount, bundleInputs, emitterInputPaths, EMITTER_REL,
  bundleOutputNames, bundleOutputNamesFrom, bundleOutputPaths,
  evaluate,
  shapeFindings, danglingFindings, cycleFindings, orphanFindings, evaluationFindings,
  recipeCouplingFindings,
  nodeSteps, engineNodeOnWindows,
};
