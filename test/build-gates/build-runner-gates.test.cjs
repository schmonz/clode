'use strict';
// The build gates inside `scripts/build-runner.cjs`: the two refusals that decide whether a
// step runs at all.
//
// WHY THIS FILE EXISTS NOW. build-runner.cjs became gate-shaped to
// test/guards-population.cjs the moment its argument parser grew a pattern-match beside its
// throws (`/^-/.test(v)`, the review's F2 fix) — and the population sweep was right to
// notice, because this file has been a build gate all along: `checkInputs` stops a step
// BEFORE it runs when a declared input is absent, and `checkOutputs` fails a run whose step
// exited 0 without producing what it promised. Those are exactly the "derives a verdict,
// then refuses" shape the sweep hunts, and neither had a registered control. The choice was
// between recording an exclusion (which would have been false — it IS a gate) and writing
// the control; this is the control.
//
// WHAT EACH ONE GUARDS, and the incident behind it (both from build-runner.cjs's own header):
//
//   * A DECLARED INPUT THAT IS MISSING. A step launched against an absent input does not
//     fail cleanly — it fails minutes later inside cmake, or worse, succeeds against a stale
//     tree. The refusal is what makes `--needs assume` safe at all: an alpine container, a
//     cross image or a VM guest is HANDED the earlier phases' outputs by a sync, and the
//     declared inputs are the assertion that the sync really happened.
//   * A DECLARED OUTPUT THAT DID NOT APPEAR. The silent-producer failure the naude work paid
//     for the hard way: a producer stopped emitting cli.cjs, every step exited 0, and only a
//     runtime path check noticed. An exit status is a claim about a process; this is a claim
//     about the artifact the NEXT step consumes.
//   * A FLAG WHOSE VALUE WENT MISSING. `--needs` with the word dropped read as "not
//     supplied" and fell through to the default, running a source phase on a machine that
//     was told to assume one. A name-check cannot check a name that is not there.
//
// PURE BY CONSTRUCTION, which is why controls can reach them: all three take their inputs as
// arguments (`existsFn` is injected, argv is an array), so nothing here has to corrupt the
// real tree to hand a decision a known-bad input.
//
// The literal relative require below is load-bearing for the production-gate population
// sweep (test/guards-population.cjs), which derives "which guard controls this production
// gate" by reading that exact string out of this file's own source.
const path = require('node:path');
const { checkInputs, checkOutputs, parseArgs, USAGE } = require('../../scripts/build-runner.cjs');
const { defineGuard, guardTests } = require('../guard.cjs');

// THE FLAGS, DERIVED FROM THE USAGE TEXT the program itself prints, not listed here. A fifth
// value-taking flag joins this guard's population the day it is documented, without anyone
// remembering to add it — and a flag that stops being documented takes the guard BELOW its
// floor rather than quietly shrinking the thing it proves.
function valueTakingFlags(usage) {
  const out = [];
  const re = /^\s{2}(--[a-z-]+)\s+</gm;
  let m;
  while ((m = re.exec(usage)) !== null) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

const FLAGS = valueTakingFlags(USAGE);

// PURE. { flags } -> a finding for every flag that accepts a MISSING value instead of
// refusing. `examined` is the number of flags actually probed.
function scanFlagRefusals({ flags }) {
  const findings = [];
  for (const flag of flags) {
    let refused = false;
    try { parseArgs([flag]); } catch { refused = true; }
    if (!refused) {
      findings.push(`\`${flag}\` with no value after it did NOT refuse. The parser then hands `
        + 'runGraph `undefined`, which is the value it reads as "not supplied" and maps to the '
        + 'DEFAULT — so a dropped argument in a YAML `run:` block runs something other than '
        + 'what the line says, exits 0, and nobody reads the log of a green step.');
    }
  }
  return { findings, examined: flags.length };
}

const flagValueGuard = defineGuard({
  name: 'build-runner a flag with no value refuses instead of defaulting',
  // MEASURED at 4 (--only, --needs, --target, --runs-on), and equal to the population on
  // purpose: every one of them is a door into the same blind pass, so losing sight of ONE is
  // the state this floor exists to report. A deliberate retirement should fire this and wants
  // a re-cut, which is the same bargain test/guards-population.cjs's GATE_SHAPED_FLOOR makes.
  floor: 4,
  read: () => ({ flags: FLAGS }),
  scan: scanFlagRefusals,
  // A flag that takes NO value: `--plan` parses happily on its own, which is precisely what a
  // value-taking flag must not do. Models the regression exactly — the parser accepting a
  // bare flag where a value was required.
  control: () => ({ flags: ['--plan'] }),
});
guardTests(flagValueGuard);

// PURE. { cases } -> a finding for every declared boundary that was NOT refused. Each case is
// { kind: 'inputs'|'outputs', step, paths, present } — `present` is the set of paths the
// (injected) existence check says are there, so a control can make everything exist.
function scanBoundaryRefusals({ cases }) {
  const findings = [];
  for (const c of cases) {
    const existsFn = (p) => c.present.includes(p);
    let refused = false;
    try {
      if (c.kind === 'inputs') checkInputs(c.step, c.paths, existsFn, c.needs);
      else checkOutputs(c.step, c.paths, existsFn);
    } catch (e) {
      // A CRASH IS NOT A DETECTION: the message has to be the refusal, not a TypeError from
      // a signature that moved underneath this control.
      const want = c.kind === 'inputs' ? /declared input is missing/ : /declared output did not appear/;
      if (!want.test(String((e && e.message) || e))) throw e;
      refused = true;
    }
    if (!refused) {
      findings.push(`${c.step.id}: a declared ${c.kind === 'inputs' ? 'INPUT that is absent' : 'OUTPUT that never appeared'} `
        + `(${c.paths.join(', ')}) was not refused. ${c.kind === 'inputs'
          ? 'A step launched against an absent input dies minutes later inside the tool it '
            + 'shells out to, or succeeds against a stale tree — and under `--needs assume` this '
            + 'check IS the assertion that another machine really synced what it promised.'
          : 'An exit status is a claim about a process; this is the claim about the artifact the '
            + 'NEXT step consumes, and it is the only thing that caught a producer which had '
            + 'quietly stopped emitting a file.'}`);
    }
  }
  return { findings, examined: cases.length };
}

// Synthetic steps, not the real graph: the point is to hand the decision a boundary that is
// KNOWN to be absent, which a real step's real paths cannot be made to be without breaking
// the tree. Same argument build-runner.cjs's own `graph` injection makes.
const ABSENT = path.join(path.sep, 'clode-build-runner-gate', 'definitely-not-present');
const STEP = (id) => ({ id, phase: 'engine', runsOn: 'host', needs: ['earlier.step'] });

const boundaryGuard = defineGuard({
  name: 'build-runner an absent declared boundary is refused',
  // Three cases, and each is a different sentence the runner has to be able to say: a missing
  // input under the default mode, a missing input under `assume` (where the advice must not be
  // "run the step that produces it"), and an output that never appeared.
  floor: 3,
  read: () => ({
    cases: [
      { kind: 'inputs', step: STEP('engine.compile'), paths: [ABSENT], present: [], needs: 'build' },
      { kind: 'inputs', step: STEP('engine.compile'), paths: [ABSENT], present: [], needs: 'assume' },
      { kind: 'outputs', step: STEP('engine.compile'), paths: [ABSENT], present: [] },
    ],
  }),
  scan: scanBoundaryRefusals,
  // The same three cases with the boundary PRESENT — i.e. a checkInputs/checkOutputs that has
  // stopped refusing, which is what this guard claims to detect. Not an empty case list: an
  // empty list models "nothing to check", which is what `floor` reports.
  control: () => ({
    cases: [
      { kind: 'inputs', step: STEP('engine.compile'), paths: [ABSENT], present: [ABSENT], needs: 'build' },
      { kind: 'inputs', step: STEP('engine.compile'), paths: [ABSENT], present: [ABSENT], needs: 'assume' },
      { kind: 'outputs', step: STEP('engine.compile'), paths: [ABSENT], present: [ABSENT] },
    ],
  }),
});
guardTests(boundaryGuard);
