'use strict';
// build-runner — runs the build FROM scripts/build-graph.cjs, checking every step's
// declared boundary.
//
// WHY THIS EXISTS. The graph is a declaration, and a declaration nothing executes is prose
// with a syntax highlighter: it drifts the moment the build changes, in exactly the silent
// way BACKLOG.md:4595 names ("a fourth hand-maintained list of what the build does"). The
// only thing that keeps a declaration TRUE is a build that fails when it is false. So this
// file is the one place `./build` and CI turn the graph into a sequence of commands, and it
// treats every step's `inputs` and `outputs` as an assertion rather than as documentation.
//
// THE TWO BOUNDARY GATES, and the incidents behind them:
//
//   * A DECLARED INPUT THAT IS MISSING stops the step BEFORE it runs, naming the path. A
//     step launched against an absent input does not fail cleanly -- it fails minutes later
//     inside cmake, or worse, succeeds against a stale tree (build-tjs.cjs's own
//     --build-only carries three separate refusals learned this way: a missing manifest, a
//     changed recorded input, a missing js bundle).
//   * A DECLARED OUTPUT THAT DID NOT APPEAR fails the run, naming the path. This is the
//     silent-producer failure the naude work paid for the hard way: a producer stopped
//     emitting cli.cjs, every step exited 0, and only a two-minute runtime path check
//     noticed. An exit status is a claim about a process; an output check is a claim about
//     the artifact, and only the second one is what the next step actually consumes.
//
// The checks are UNCONDITIONAL, not a --verify mode. A boundary check that has to be asked
// for is a boundary check nobody runs.
//
// COMMONJS, NO ESM SYNTAX, NO TOP-LEVEL await, NO import.meta — same Global Constraint, and
// the same cautionary case (scripts/stage0.mjs), as build-graph.cjs's own header states:
// the developer build resolves a tjs through scripts/bootstrap-engine.sh and runs THIS FILE
// under it on machines with no node at all, and `import.meta` outside Module goal is an
// EARLY parse error, so an ESM runner could not load far enough to report its own failure.
// Pinned by actually booting it under the shim (test/build-graph.test.cjs), not by linting
// for `import`: a parse-only probe never reaches the lazy requires below.
//
// scripts/build-tjs.cjs MUST NOT require this file, for build-graph.cjs's reason exactly: a
// require would pull it into engine-recipe.mjs's derived FILES, move the recipe hash, and
// rebuild all 42 legs on every edit to a file that compiles nothing.

const fs = require('node:fs');

const G = require('./build-graph.cjs');

// ---- the durable timing record ----------------------------------------------------------
//
// BACKLOG.md:4686 asks for "every step's elapsed time written where a piped/CI build keeps
// it, so a regression is a diff and not a feeling". That record ALREADY EXISTS:
// libexec/build-trace.cjs, one JSON line per build in Chrome-trace step shape, which
// `clode build` has appended to since Task 3 of the build-report work. So this composes it
// instead of emitting a second timing format — two formats would disagree within a release,
// and "how long did the engine take" would once again have two answers. The step shape
// (component/name/total/done/elapsedMs/state) is build-trace's, so a graph run and a
// `clode build` run land in ONE history a single viewer can read.
//
// Lazily required, like build-graph.cjs's ESM sources: merely loading this module must stay
// cheap and node-free.
function traceLogPath(env) {
  return require('../libexec/clode-paths.cjs').traceLog(env);
}

// WHICH ENGINE PRODUCED THIS NUMBER. build-trace.cjs refuses a run with no interpreter
// recorded, for a good reason (two agents once disagreed about a verdict because neither had
// asked which `node` produced it) — and under libexec/node-shim/loader.cjs `process.version`
// is a Node version this engine is IMITATING, not the engine. A graph run timed under tjs
// and one timed under node are not comparable, so the label says which it was.
function interpreterLabel() {
  const t = globalThis.tjs;
  if (t && typeof t.version === 'string') return `tjs ${t.version}`;
  return `${(process.release && process.release.name) || 'node'} ${process.version}`;
}

// ---- the greppable verdict ----------------------------------------------------------------
//
// House style, the shape `build-tjs: ccache:` / `build-tjs: ar-determinism:` /
// `build-tjs-engine: engine=` already use: one flat key=value line per step, so a piped or
// CI log can be grepped for what ran, where, and how long it took without a parser.
//
//   build-graph: step=<id> phase=<phase> runsOn=<where> ms=<elapsed> count=<n/total|->
//
// `count` is the step's DERIVED denominator (BACKLOG.md:4686's second ask) — patches
// applied, bundles emitted — and `-` where a step has none. An honest mixed display beats a
// fake percentage, which is the backlog item's own words.
function stepLine(step, ms, count) {
  const n = count === undefined ? '-' : `${count}/${count}`;
  return `build-graph: step=${step.id} phase=${step.phase} runsOn=${step.runsOn}`
    + ` ms=${ms} count=${n}`;
}

// ---- the boundary checks, as one refusal each ---------------------------------------------

// A DERIVATION THAT CANNOT ANSWER, named at the step it belongs to. The graph's answers are
// compositions of other single sources of truth, and one of those -- scripts/engine-recipe.mjs
// -- is ESM that uses `import.meta`, which libexec/node-shim/loader.cjs cannot host. So under
// tjs, `engine.source`'s inputs and count and `engine.compile`'s inputs are UNANSWERABLE
// today, and what escapes is the bare engine message "import.meta only valid in module code"
// with no hint which step asked or why. That is a true statement about a parser and a useless
// one about a build. Wrapped, never swallowed: the cause is quoted verbatim, and the step and
// the derivation are named.
//
// NOT FIXED HERE, on purpose: engine-recipe.mjs is itself inside the engine recipe's file
// set, so editing it moves the recipe hash and rebuilds all 42 legs. Making it shim-hostable
// is a deliberate decision with that price tag attached, not a side effect of writing a
// runner. test/build-graph.test.cjs pins the limitation as a tripwire so the day it lifts,
// the proof widens rather than the note rotting.
function derive(step, what, fn) {
  try {
    return fn();
  } catch (e) {
    const err = new Error(`build-runner: ${step.id} could not resolve its declared ${what}: `
      + `${(e && e.message) || e}. The graph DERIVES that answer from another source of truth `
      + '(see scripts/build-graph.cjs) rather than listing it, so this is that source refusing '
      + 'or unreachable — not a missing file. If the message names `import.meta`, the engine '
      + 'running this build cannot host scripts/engine-recipe.mjs (ESM) through the CJS '
      + 'node-shim loader: run the graph under node, or name a step outside the engine phase.');
    err.cause = e;
    throw err;
  }
}

function checkInputs(step, paths, existsFn) {
  const missing = paths.filter((p) => !existsFn(p));
  if (!missing.length) return;
  throw new Error(`build-runner: ${step.id} declared input is missing: ${missing[0]}`
    + (missing.length > 1 ? ` (and ${missing.length - 1} more)` : '')
    + ' — the step was NOT run. A step launched against an absent input either dies minutes '
    + 'later inside the tool it shells out to, or succeeds against a stale tree; either way '
    + 'the failure is reported somewhere other than where it happened. Run the step that '
    + `produces it (see \`needs\` for ${step.id} in scripts/build-graph.cjs), or fix the `
    + 'declaration if that path is no longer an input.');
}

function checkOutputs(step, paths, existsFn) {
  const absent = paths.filter((p) => !existsFn(p));
  if (!absent.length) return;
  throw new Error(`build-runner: ${step.id} declared output did not appear: ${absent[0]}`
    + (absent.length > 1 ? ` (and ${absent.length - 1} more)` : '')
    + ' — the step exited without error and did not produce what it promises. An exit status '
    + 'is a claim about a process; this is a claim about the artifact the NEXT step consumes, '
    + 'and only the second one caught a producer that had quietly stopped emitting a file. '
    + 'Fix the step, or fix its `outputs` in scripts/build-graph.cjs if it no longer writes that.');
}

// ---- the run --------------------------------------------------------------------------------

// runGraph({ target, runsOn, only, dryRun, execFileSyncFn, nowFn, graph, existsFn, logFn,
//            traceLog, env, repo })
//   -> { ran: string[], timings: [{ id, phase, runsOn, ms, count }] }
//
// `only` is a step id and selects that step AND ITS TRANSITIVE `needs` — asking for the
// engine has to build what the engine needs, and a runner that ran the named step alone
// would fail on its own declared inputs (or, worse, succeed against a stale tree).
//
// `graph` lets a caller drive a synthetic step list, which is the whole reason the two
// refusals above can be shown to fire: a control built out of the REAL graph could only be
// made bad by corrupting the real graph (the same argument test/guard.cjs makes for its
// control()). Selection goes through build-graph.cjs's own `select`, so the controls
// exercise the same selector a real build does.
function runGraph(opts) {
  const o = opts || {};
  const existsFn = o.existsFn || ((p) => fs.existsSync(p));
  const nowFn = o.nowFn || Date.now;
  const logFn = o.logFn || ((line) => console.log(line));
  const declared = o.graph || G.steps({ target: o.target, tier: o.tier });

  // FIRST, before anything is resolved or run: an `only` the graph does not declare is a
  // typo, and a typo must stop the build. The alternative — selecting nothing and reporting
  // a successful run of zero steps — is the blind-pass shape this repo has found ~18 times:
  // green, fast, and about nothing.
  if (o.only && !declared.some((s) => s.id === o.only)) {
    throw new Error(`build-runner: '${o.only}' is not a declared step. `
      + `The graph declares: ${declared.map((s) => s.id).join(', ')}. `
      + 'Running zero steps and reporting success would be worse than this refusal.');
  }

  const plan = G.select(G.topoOrder(declared), { id: o.only, runsOn: o.runsOn });

  // DEFINED KEYS ONLY. defaultContext falls back per field on falsiness, so writing
  // `target: undefined` over a `context: { target }` a caller supplied would silently
  // re-resolve to THIS HOST — the resolving-for-the-wrong-machine shape `runsOn` exists to
  // express, reintroduced by a merge. `execFileSync` rides the same context every step's
  // run() already receives, so the DECLARED steps honour the injection too
  // (build-graph.cjs's sh()), not only synthetic fixtures.
  const over = Object.assign({}, o.context);
  for (const [k, v] of [['target', o.target], ['repo', o.repo], ['env', o.env],
    ['execFileSync', o.execFileSyncFn]]) {
    if (v !== undefined) over[k] = v;
  }
  const ctx = G.defaultContext(over);

  const ran = [];
  const timings = [];
  const traceSteps = [];
  try {
    for (const step of plan) {
      const count = step.count ? derive(step, 'count', () => step.count()) : undefined;
      if (o.dryRun) {
        // A dry run must not execute and must not JUDGE: the outputs of a build that has not
        // run are absent by construction, so checking them would make `--plan` red on every
        // clean checkout — a gate that fires on the correct state is worse than none.
        ran.push(step.id);
        timings.push({ id: step.id, phase: step.phase, runsOn: step.runsOn, ms: null, count });
        logFn(stepLine(step, '-', count));
        continue;
      }
      checkInputs(step, derive(step, 'inputs', () => step.inputs(ctx)), existsFn);
      const started = nowFn();
      let ok = false;
      try {
        step.run(ctx);
        ok = true;
      } finally {
        const ms = nowFn() - started;
        traceSteps.push({
          component: step.phase,
          name: step.id,
          total: count === undefined ? null : count,
          done: ok && count !== undefined ? count : 0,
          elapsedMs: ms,
          state: ok ? 'finished' : 'failed',
        });
        if (ok) {
          ran.push(step.id);
          timings.push({ id: step.id, phase: step.phase, runsOn: step.runsOn, ms, count });
          logFn(stepLine(step, ms, count));
        }
      }
      checkOutputs(step, derive(step, 'outputs', () => step.outputs(ctx)), existsFn);
    }
  } finally {
    // WIN OR LOSE, for the same reason libexec/clode-build.cjs records one: a failed build's
    // partial step timings are real data, and "it got slower, then it broke" is only a diff
    // if the broken run left a line too. Best-effort — a trace-log write failure must never
    // turn a build's own outcome into a lie.
    if (!o.dryRun) {
      try {
        require('../libexec/build-trace.cjs').appendRun(o.traceLog || traceLogPath(ctx.env), {
          steps: traceSteps,
          meta: {
            target: ctx.target,
            host: `${process.platform}-${process.arch}`,
            interpreter: interpreterLabel(),
            graph: G.ROOT_ID,
          },
        });
      } catch (e) {
        logFn(`build-graph: could not append to the trace log: ${(e && e.message) || e}`);
      }
    }
  }

  return { ran, timings };
}

// ---- the command line ------------------------------------------------------------------------

const USAGE = [
  'usage: build-runner.cjs [--plan] [--only <step-id>] [--target <name>] [--runs-on <where>]',
  '',
  '  Runs the build declared by scripts/build-graph.cjs, checking each step\'s declared',
  '  inputs before it runs and its declared outputs after.',
  '',
  '  --plan            print the steps that would run; run nothing',
  '  --only <step-id>  run that step and everything it transitively needs',
  '  --target <name>   a leg token or canonical target name (default: this host)',
  `  --runs-on <where> only the steps that run on ${G.RUNS_ON.join('|')}`,
  '  --help            this text',
].join('\n');

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--plan' || a === '--dry-run') o.dryRun = true;
    else if (a === '--only') { i += 1; o.only = argv[i]; }
    else if (a === '--target') { i += 1; o.target = argv[i]; }
    else if (a === '--runs-on') { i += 1; o.runsOn = argv[i]; }
    else throw new Error(`build-runner: unknown argument '${a}'\n${USAGE}`);
  }
  return o;
}

function main(argv) {
  const o = parseArgs(argv);
  if (o.help) { console.log(USAGE); return 0; }
  runGraph(o);
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error((e && e.message) || String(e));
    process.exitCode = 1;
  }
}

module.exports = { runGraph, parseArgs, main, stepLine, checkInputs, checkOutputs, derive, USAGE };
