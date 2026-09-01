// scripts/exec-probe.mjs
// Report, per candidate, whether a build could use it as scratch on THIS machine.
// Prints and always exits 0: this is an instrument, not a gate. It becomes a gate
// only once the phase-1 refusal lands and we know what the answer is.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { scratchCandidates, probeExec, isInsideCheckout } = require('./build-scratch.cjs');

console.log(`exec-probe: platform=${process.platform} arch=${process.arch}`);
for (const c of scratchCandidates(process.env)) {
  const inTree = isInsideCheckout(c.dir);
  const r = probeExec(c.dir);
  console.log(`  ${c.name.padEnd(20)} ${c.dir}`);
  console.log(`    inCheckout=${inTree}  execOk=${r.ok}  ${r.reason}`);
}
