'use strict';
// guard.cjs — the phase-5 contract for anything in this repo that inspects an artifact
// and reports findings.
//
// WHY THIS EXISTS. Of twelve instrument defects found on 2026-08-28/29, eight were found
// by hand, by someone being suspicious. That is a mood, not a process. Every one of those
// hand-catches used the same move: feed the guard a KNOWN-BAD input and check it goes red.
// This module makes that move a precondition of being a guard at all.
//
// THE SHAPE, and why it is three functions rather than one test body. A guard written the
// usual way resolves its own paths and asserts inline (see the pre-phase-5
// naude-assembler-closure), which leaves NO seam to feed a bad input through — you cannot
// hand it a fixture without corrupting the real tree. So:
//
//     read()    -> the real inputs, resolved from repo/artifact paths (I/O lives here)
//     scan(i)   -> { findings: [...], examined: n }   -- PURE: no I/O, no assertions
//     control() -> inputs containing a violation this guard MUST report
//
// scan() sees only what read()/control() returned, so a path literal inside scan() is a
// review smell by construction.
//
// FOUR VERDICTS, and the distinction is the point. "Found no violations" and "examined
// nothing" are OPPOSITE results that this repo has historically printed identically —
// that is how the layer-2 shim map read clean for two years. See test/run.mjs's discovery
// and evidence floors for the precedent this generalises.
const OK = 'OK';                     // examined enough, found nothing
const VIOLATION = 'VIOLATION';       // examined enough, found something real
const BROKEN = 'BROKEN';             // examined nothing (or under floor) — the guard is blind
const CANNOT_FAIL = 'CANNOT_FAIL';   // the control produced no findings — this is not a guard
const SKIP = 'SKIP';                 // read() declared its precondition absent, with a reason

const REGISTRY = new Map();

function defineGuard(spec) {
  const s = spec || {};
  const { name, read, scan, control } = s;
  const floor = s.floor === undefined ? 1 : s.floor;
  if (typeof name !== 'string' || !name) {
    throw new Error('defineGuard: a non-empty string `name` is required');
  }
  if (typeof read !== 'function') throw new Error(`defineGuard(${name}): \`read\` must be a function`);
  if (typeof scan !== 'function') throw new Error(`defineGuard(${name}): \`scan\` must be a function`);
  if (typeof control !== 'function') {
    throw new Error(`defineGuard(${name}): \`control\` must be a function. A guard with no `
      + `positive control cannot be shown to fail, so it is not a guard — it is a test that `
      + `happens to be green. Supply an input containing a violation this guard MUST report. `
      + `(phase-5 spec 2.1)`);
  }
  if (!Number.isInteger(floor) || floor < 1) {
    throw new Error(`defineGuard(${name}): \`floor\` must be a positive integer (default 1)`);
  }
  if (REGISTRY.has(name)) throw new Error(`defineGuard: duplicate guard name '${name}'`);
  // Frozen before storage: registered() hands out these exact objects (they are handles,
  // not copies), and a guard whose whole claim is "cannot be constructed without a working
  // control" must not let a caller reassign that control away after the fact.
  const g = Object.freeze({ name, read, scan, control, floor });
  REGISTRY.set(name, g);
  return g;
}

function registered() { return [...REGISTRY.values()]; }

// A scan result must SAY how much it looked at. Returning findings without `examined` is
// the exact ambiguity this module exists to remove, so it is an error rather than a
// default of 0 — a default would silently reintroduce "clean" for "blind".
function normalize(name, result) {
  const r = result || {};
  if (!Array.isArray(r.findings)) {
    throw new Error(`guard ${name}: scan() must return { findings: [...] }`);
  }
  if (!Number.isInteger(r.examined) || r.examined < 0) {
    throw new Error(`guard ${name}: scan() must return an integer \`examined\` count — `
      + `a guard that cannot say how much it inspected cannot be distinguished from a `
      + `guard that inspected nothing`);
  }
  return { findings: r.findings, examined: r.examined };
}

function checkControl(g) {
  const controlInputs = g.control();
  // Minor (coordinator, whole-branch review, 2026-09-04): a CONTROL is synthetic —
  // it exists to prove the guard CAN fail — so `read()`'s `{ skip }` escape hatch
  // ("the real precondition is absent") has no meaning here: control() has no real
  // precondition to be absent. A control that returns `{ skip }` anyway is an
  // authoring bug (it would otherwise fall straight into scan(), which was never
  // written to handle a skip object, and read back as a confusing CANNOT_FAIL rather
  // than naming the actual mistake). Cheap and unconditional: this does not touch
  // floor semantics (see the file-level note this comment is paired with in
  // BACKLOG.md/the final fix report for why floor enforcement here was NOT added).
  if (controlInputs && typeof controlInputs === 'object' && 'skip' in controlInputs) {
    throw new Error(`guard ${g.name}: control() returned { skip: ... } — a control has no `
      + `real precondition to be absent; it is a synthetic fixture that must always exist. `
      + `A skipping control is an authoring bug, not a runtime condition.`);
  }
  const r = normalize(g.name, g.scan(controlInputs));
  if (r.findings.length > 0) {
    return { verdict: OK, examined: r.examined, findings: r.findings,
      message: `${g.name}: control produced ${r.findings.length} finding(s) — the guard can fail` };
  }
  return { verdict: CANNOT_FAIL, examined: r.examined, findings: [],
    message: `${g.name}: CANNOT FAIL — its own positive control produced NO findings. `
      + `The control describes a violation this guard claims to detect, and it did not `
      + `detect it. Either the control no longer models a real violation (an artifact `
      + `encoding changed under it), or the scan is blind. Do not weaken the control to `
      + `make this pass.` };
}

function checkGate(g) {
  const inputs = g.read();
  if (inputs === null || inputs === undefined) {
    throw new Error(`guard ${g.name}: read() must return an object — either the real inputs, `
      + `or { skip: reason }`);
  }
  // KEY PRESENCE, not truthiness: an empty-string skip is exactly what a careless
  // \`reason || ''\` produces, and a truthiness test lets it fall through into scan()
  // instead of naming the problem — the same "five skips that could not say what they
  // wanted" defect this module exists to close, reappearing in its own machinery.
  if ('skip' in inputs) {
    if (typeof inputs.skip !== 'string' || inputs.skip.length === 0) {
      throw new Error(`guard ${g.name}: read() returned { skip } but \`skip\` must be a `
        + `non-empty string naming why the precondition is absent — a skip must state why`);
    }
    return { verdict: SKIP, examined: 0, findings: [],
      message: `${g.name}: skipped — ${inputs.skip}` };
  }
  const r = normalize(g.name, g.scan(inputs));
  if (r.examined < g.floor) {
    return { verdict: BROKEN, examined: r.examined, findings: r.findings,
      message: `${g.name}: BROKEN — examined ${r.examined}, floor is ${g.floor}. This is NOT `
        + `a clean result: the guard inspected less than it must for its verdict to mean `
        + `anything. Something it reads moved, emptied, or changed shape.` };
  }
  if (r.findings.length > 0) {
    return { verdict: VIOLATION, examined: r.examined, findings: r.findings,
      message: `${g.name}: VIOLATION — examined ${r.examined}, ${r.findings.length} finding(s):\n`
        + r.findings.map((f) => `    ${f}`).join('\n') };
  }
  return { verdict: OK, examined: r.examined, findings: [],
    message: `${g.name}: OK — examined ${r.examined}, no findings` };
}

// Declares the two node:test cases for a guard. Deliberately separate tests: a guard that
// CANNOT FAIL and a guard that found a real VIOLATION are different problems for whoever
// reads the output, and collapsing them into one test would hide which happened.
function guardTests(g, { test, assert } = { test: require('node:test').test, assert: require('node:assert') }) {
  test(`guard control: ${g.name} can fail`, () => {
    const r = checkControl(g);
    assert.strictEqual(r.verdict, OK, r.message);
  });
  test(`guard gate: ${g.name}`, (t) => {
    const r = checkGate(g);
    if (r.verdict === SKIP) { t.skip(r.message); return; }
    assert.strictEqual(r.verdict, OK, r.message);
  });
}

module.exports = { defineGuard, registered, checkControl, checkGate, guardTests,
  OK, VIOLATION, BROKEN, CANNOT_FAIL, SKIP };
