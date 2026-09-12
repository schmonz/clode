'use strict';
// Several build gates signal by THROWING rather than returning findings. The guard
// contract wants { findings, examined }. This adapts one to the other WITHOUT changing
// production behaviour: the gate still throws in the build; only the test observes it
// as a finding, so CANNOT_FAIL keeps meaning what it means.
//
// `expect` — A CRASH IS NOT A DETECTION (fix round 2, reviewer 2026-09-12). Without it,
// ANY throw counts as a finding, so a control whose fixture merely breaks the gate — a
// changed signature, a TypeError on an argument shape that moved — still certifies "the
// guard can fail" while the refusal it claims to control may no longer fire at all. Pass
// a RegExp the real refusal's message must match; a throw that does not match is
// re-raised, naming both messages, so the authoring bug surfaces as itself instead of
// masquerading as a working control. Optional, so the plain 3-arg form still works where
// the caller already filters or asserts on the message itself.
//
// `examined` — AN INTEGER, OR A THUNK. The integer form is the common case. A zero-arg
// FUNCTION is evaluated after the gate runs, for a gate whose work count is only knowable
// from what the run filled in (dep-closure's resolved closure, say): counting the INPUT
// instead lets a gate that walked nothing still report the input size and read OK, which
// is precisely the blindness `examined` exists to expose.
function throwsAsFindings(fn, args, { examined, expect } = {}) {
  const isThunk = typeof examined === 'function';
  if (!isThunk && (!Number.isInteger(examined) || examined < 0)) {
    throw new Error('throwsAsFindings: caller must supply an integer `examined` (or a zero-arg '
      + 'function returning one) — a gate that cannot say how much it inspected cannot be '
      + 'told from one that inspected nothing');
  }
  if (expect !== undefined && !(expect instanceof RegExp)) {
    throw new Error('throwsAsFindings: `expect` must be a RegExp the gate\'s refusal message '
      + 'has to match');
  }
  const count = () => {
    if (!isThunk) return examined;
    const n = examined();
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`throwsAsFindings: the \`examined\` thunk returned ${n}, not a `
        + 'non-negative integer');
    }
    return n;
  };
  try { fn(...args); return { findings: [], examined: count() }; } catch (e) {
    const message = String((e && e.message) || e);
    if (expect && !expect.test(message)) {
      throw new Error('throwsAsFindings: the gate threw, but NOT the refusal this call is '
        + `watching for (${expect}). A crash is not a detection: reporting it as a finding `
        + 'would certify a control that no longer proves the real refusal fires. Thrown '
        + `message was: ${message}`);
    }
    return { findings: [message], examined: count() };
  }
}
module.exports = { throwsAsFindings };
