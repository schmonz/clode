'use strict';
// TASK 7: the named escape hatch (CLODE_ALLOW_CYCLIC_REQUIRES) is read where the refusal
// actually happens now — scripts/merge-step.mjs, the protocol-only component quaude-fuse.js
// spawns to do the merge — not in quaude-fuse.js itself. quaude-fuse.js still reads
// cyclicRequires (to size the spawn's declared total and to no-op when there are none).
const fs = require('node:fs');
const path = require('node:path');
const { defineGuard, guardTests } = require('./guard.cjs');

const REPO = path.join(__dirname, '..');

// PURE: every check below is a presence/absence assertion against the two
// already-read source files.
function scanCyclicRefusalWiring({ fuseSrc, mergeStepSrc }) {
  const findings = [];
  let examined = 0;

  examined++;
  if (!/cyclicRequires/.test(fuseSrc)) {
    findings.push('quaude-fuse.js no longer reads cyclicRequires to size the merge it spawns');
  }

  examined++;
  if (!/cyclicRequires/.test(mergeStepSrc)) {
    findings.push('scripts/merge-step.mjs no longer reads cyclicRequires (the residual edges)');
  }

  examined++;
  if (!/CLODE_ALLOW_CYCLIC_REQUIRES/.test(mergeStepSrc)) {
    findings.push('scripts/merge-step.mjs lost its named escape hatch (CLODE_ALLOW_CYCLIC_REQUIRES) '
      + '— a silent tolerance is not the same as a named one');
  }

  examined++;
  if (!/cyclicRequires\s*\|\|\s*\[\]/.test(fuseSrc)) {
    findings.push('quaude-fuse.js no longer treats an absent cyclicRequires the same as an empty '
      + 'one — absent and empty must both be a no-op');
  }

  return { findings, examined };
}

const guard = defineGuard({
  name: 'quaude-fuse-cyclic-refusal-wiring',
  read: () => ({
    fuseSrc: fs.readFileSync(path.join(REPO, 'libexec', 'quaude-fuse.js'), 'utf8'),
    mergeStepSrc: fs.readFileSync(path.join(REPO, 'scripts', 'merge-step.mjs'), 'utf8'),
  }),
  scan: scanCyclicRefusalWiring,
  // I2 (coordinator, 2026-09-04): table-driven — two fixed named files. Floored at the
  // exact measured count (4).
  floor: 4,
  // Models all four ways this wiring can silently revert to a no-op or a
  // silent tolerance, at once.
  control: () => ({ fuseSrc: '// nothing here', mergeStepSrc: '// nothing here either' }),
});
guardTests(guard);
