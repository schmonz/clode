'use strict';
// build-runner — runs the build FROM scripts/build-graph.cjs, checking every step's
// declared boundary.
//
// WHY THIS EXISTS. The graph is a declaration, and a declaration nothing executes is prose
// with a syntax highlighter: it drifts the moment the build changes, in exactly the silent
// way BACKLOG.md:4595 names ("a fourth hand-maintained list of what the build does"). The
// only thing that keeps a declaration TRUE is a build that fails when it is false. So this
// file is the one place `./build.sh` and CI turn the graph into a sequence of commands, and it
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
// require would pull it into engine-recipe.cjs's derived FILES, move the recipe hash, and
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
//   build-graph: step=<id> phase=<phase> runsOn=<where> ms=<elapsed> count=<total|->
//
// `count` is the step's DERIVED denominator (BACKLOG.md:4686's second ask) — patches
// applied, bundles emitted — and `-` where a step has none.
//
// A BARE TOTAL, NOT A FRACTION, and this is a correction (review round 1). The first cut
// rendered `count=<n>/<n>`, which is a ratio that is ALWAYS 1: this line is printed once,
// after the step has finished, and the graph stops at STEP granularity by design (cmake owns
// the within-step compile graph), so there is no moment at which the runner knows a partial
// numerator. `28/28` is a fake percentage wearing a fraction's clothes — it looks like
// progress and can never report any. BACKLOG.md:4686's own words are that an honest mixed
// display beats a fake percentage, so the denominator ships alone and means exactly what it
// says: how many units this step covered. A real numerator needs progress reported from
// INSIDE a step, which is a different mechanism (the backlog item's first ask) and not
// something a step-granularity runner can fake its way to.
function stepLine(step, ms, count) {
  return `build-graph: step=${step.id} phase=${step.phase} runsOn=${step.runsOn}`
    + ` ms=${ms} count=${count === undefined ? '-' : count}`;
}

// ---- the boundary checks, as one refusal each ---------------------------------------------

// A DERIVATION THAT CANNOT ANSWER, named at the step it belongs to. The graph's answers are
// compositions of other single sources of truth, and a source of truth that refuses is the
// failure mode this wrapping exists for: what escapes otherwise is whatever that file threw,
// with no hint which step asked or why. That is a true statement about some other file and a
// useless one about a build. Wrapped, never swallowed: the cause is quoted verbatim, and the
// step and the derivation are named.
//
// THE CASE THIS WAS WRITTEN FOR, now closed. scripts/engine-recipe.cjs was ESM using
// `import.meta` until 2026-09-21, so under tjs `engine.source`'s inputs and count and
// `engine.compile`'s inputs were UNANSWERABLE and a node-free `./build.sh` stopped at the first
// engine step. It is CommonJS now and the whole graph plans under the shim
// (test/build-graph.test.cjs compares the tjs plan to the node plan, count for count). The
// wrapping stays: it is about ANY derivation refusing, not about that one file, and the
// import.meta hint below is what makes a relapse -- here or in anything the graph reaches --
// name itself instead of arriving as a bare parser complaint.
function derive(step, what, fn) {
  try {
    return fn();
  } catch (e) {
    const err = new Error(`build-runner: ${step.id} could not resolve its declared ${what}: `
      + `${(e && e.message) || e}. The graph DERIVES that answer from another source of truth `
      + '(see scripts/build-graph.cjs) rather than listing it, so this is that source refusing '
      + 'or unreachable — not a missing file. If the message names `import.meta`, the engine '
      + 'running this build cannot host scripts/engine-recipe.cjs (ESM) through the CJS '
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

  // THE SECOND DOOR INTO THE SAME BLIND PASS (review round 1, Important). `--only` was
  // validated and `--runs-on` was not, so `runGraph({ runsOn: 'nonsense-machine' })` selected
  // nothing and exited 0 — precisely the "select nothing, report success" failure the refusal
  // above exists to prevent, reached through the other argument. RUNS_ON is a closed set the
  // graph already declares (and USAGE already prints), so a name outside it is a typo, not a
  // machine nobody has legs on.
  if (o.runsOn && !G.RUNS_ON.includes(o.runsOn)) {
    throw new Error(`build-runner: '${o.runsOn}' is not a declared machine. A step runs on one `
      + `of: ${G.RUNS_ON.join(', ')}. Selecting nothing and reporting a successful build of `
      + 'zero steps is how a typo becomes a green run about nothing.');
  }

  const plan = G.select(G.topoOrder(declared), { id: o.only, runsOn: o.runsOn });

  // AND THE COMBINATION, which neither name-check can see. `--only engine.compile --runs-on
  // guest` names a real step and a real machine and still selects nothing, because that
  // step's subgraph runs nowhere near a guest on this target. Task 1's own orderedSteps test
  // already guards this shape (`order.length > 0`: "a filter that matches no step is a blind
  // pass, not an ordering proof"); the same rule belongs where a build acts on it.
  if (!plan.length) {
    throw new Error('build-runner: that selection matched no step'
      + (o.only ? ` (only=${o.only})` : '') + (o.runsOn ? ` (runsOn=${o.runsOn})` : '')
      + `. The graph declares ${declared.length} step(s): ${declared.map((s) => s.id).join(', ')}`
      + ' — with the machines each one resolves to for this target. An empty plan that exits 0 '
      + 'is indistinguishable from a build that worked, which is the whole failure this runner '
      + 'is a reaction to.');
  }

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

      // THE VERDICT COMES BEFORE THE RECORD (review round 1, Important). The first cut
      // pushed `state: 'finished'`, the green log line and the timing from inside a
      // `finally` that ran BEFORE checkOutputs — so a step that exited 0 and wrote nothing
      // printed a normal green line and landed in build-trace.jsonl as `finished`, and only
      // then was refused. That is the silent-producer shape this gate cites as its whole
      // reason for existing, reintroduced one layer over: the gate refuses correctly and the
      // durable record says it succeeded. A history that disagrees with the build's own
      // verdict is worse than no history, because the next person diffs it and believes it.
      // So nothing is recorded until the step has BOTH run and produced what it declared.
      const started = nowFn();
      let ms = 0;
      try {
        step.run(ctx);
        ms = nowFn() - started;
        checkOutputs(step, derive(step, 'outputs', () => step.outputs(ctx)), existsFn);
      } catch (e) {
        traceSteps.push({
          component: step.phase,
          name: step.id,
          total: count === undefined ? null : count,
          done: 0,
          // `run` may have thrown before ms was taken; the output check may have thrown
          // after. Either way the elapsed recorded is real time this step consumed.
          elapsedMs: ms || (nowFn() - started),
          state: 'failed',
        });
        throw e;
      }
      traceSteps.push({
        component: step.phase,
        name: step.id,
        total: count === undefined ? null : count,
        // A step that FINISHED covered every unit it declared, so done === total is a fact
        // about a completed step rather than a progress claim — build-trace's shape wants
        // both fields, and a viewer reading this line is reading history, not a spinner.
        done: count === undefined ? 0 : count,
        elapsedMs: ms,
        state: 'finished',
      });
      ran.push(step.id);
      timings.push({ id: step.id, phase: step.phase, runsOn: step.runsOn, ms, count });
      logFn(stepLine(step, ms, count));
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
