'use strict';
// Several build gates signal by THROWING rather than returning findings. The guard
// contract wants { findings, examined }. This adapts one to the other WITHOUT changing
// production behaviour: the gate still throws in the build; only the test observes it
// as a finding, so CANNOT_FAIL keeps meaning what it means.
function throwsAsFindings(fn, args, { examined }) {
  if (!Number.isInteger(examined) || examined < 0) {
    throw new Error('throwsAsFindings: caller must supply an integer `examined` — a gate '
      + 'that cannot say how much it inspected cannot be told from one that inspected nothing');
  }
  try { fn(...args); return { findings: [], examined }; }
  catch (e) { return { findings: [String((e && e.message) || e)], examined }; }
}
module.exports = { throwsAsFindings };
