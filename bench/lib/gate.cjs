'use strict';

// Compare current quaude medians against a committed baseline. A scenario only
// fails the gate when it is BOTH in the baseline AND slower than tolerance×.
function checkRegressions({ baseline, current, tolerance }) {
  const regressions = [];
  for (const [name, baselineMs] of Object.entries(baseline)) {
    const currentMs = current[name];
    if (typeof currentMs !== 'number') continue;
    if (currentMs > baselineMs * tolerance) {
      regressions.push({ name, baselineMs, currentMs, factor: currentMs / baselineMs });
    }
  }
  return { ok: regressions.length === 0, regressions };
}

module.exports = { checkRegressions };
