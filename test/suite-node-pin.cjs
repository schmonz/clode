'use strict';
// THE SUITE RUNS ON THE NODE THE REPO PINS. Every CI job sets up node from .tool-versions (node-version-file), so a local
// full suite on any other node judges code CI never runs on, and can fail for reasons CI never sees. Found 2026-11-24:
// local suites were run with ASDF_NODEJS_VERSION=24.21.0 for weeks after .tool-versions moved to 24.22.0 (fca2e9f), and
// node 24.21.0's V8 GC crash (BACKLOG, "ClearStaleLeftTrimmedPointerVisitor") failed four of them: 1 in 40 runs of
// test/procfs-linux-only.test.cjs alone on 24.21.0, 0 in 160 on 24.22.0. test/run.mjs refuses the mismatch up front;
// CLODE_SUITE_NODE_BECAUSE=<reason> runs anyway and prints the reason, for a deliberate other-node run.
const fs = require('node:fs');
const path = require('node:path');

// PURE: (.tool-versions text, process.version, because) -> null (ok) | refusal text.
function nodePinVerdict(toolVersions, version, because) {
  const m = /^nodejs\s+(\S+)\s*$/m.exec(toolVersions || '');
  if (!m) return 'run: .tool-versions names no nodejs version, so the suite cannot tell which node CI runs';
  if (`v${m[1]}` === version) return null;
  if (because && because.trim()) return null;
  return `run: this is node ${version}, and .tool-versions (which every CI job sets node up from) pins ${m[1]}. `
    + `Run the suite on ${m[1]} (asdf: ASDF_NODEJS_VERSION=${m[1]}), or set CLODE_SUITE_NODE_BECAUSE=<why> to run on this one.`;
}

function checkSuiteNode(root, env = process.env, version = process.version) {
  const text = fs.readFileSync(path.join(root, '.tool-versions'), 'utf8');
  return nodePinVerdict(text, version, env.CLODE_SUITE_NODE_BECAUSE);
}

module.exports = { nodePinVerdict, checkSuiteNode };
