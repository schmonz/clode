'use strict';
// node:vm under the node-shim. The upstream bundle uses node:vm at ~7 sites (the
// Workflow script loader, a command/tool sandbox, a REPL eval, a code-input tool):
// require('vm') then the vm.Script + createContext + runInContext family. The
// node-shim does not implement node:vm, so quaude throws where naude runs — which
// is why Workflow is dead under quaude (BACKLOG.md "Known quaude runtime bugs").
// This is the DETERMINISTIC gate for the whole class: it exercises the node:vm
// path directly instead of through a tool whose async launch-ack hides the failure.
// RED now (quaude); GREEN once a node:vm shim (Script/createContext/runInContext)
// lands. See docs/superpowers/plans/2026-07-24-tool-surface-fidelity.md (Task 1).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { REPO, tjsPath, skipUnlessTjs, LOADER } = require('./node-shim-helper.cjs');

// Mirrors what the workflow loader does: require('vm'), compile a script, run it
// in a context with injected globals, read the result back out of the sandbox.
const PROG = [
  "const vm = require('vm');",
  "const sandbox = { x: 6, y: 7, out: 0 };",
  "vm.createContext(sandbox);",
  "new vm.Script('out = x * y').runInContext(sandbox);",
  "process.stdout.write('vm-ok:' + sandbox.out);",
].join('\n');

function writeProg() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmshim-'));
  const f = path.join(dir, 'prog.cjs');
  fs.writeFileSync(f, PROG);
  return f;
}

test('node:vm (Script/createContext/runInContext) works under the node-shim', (t) => {
  if (skipUnlessTjs(t)) return;
  const prog = writeProg();
  const env = { ...process.env, NODE_PATH: path.join(REPO, 'deps', 'claude', 'node_modules') };
  const naude = spawnSync(process.execPath, [prog], { encoding: 'utf8', env });
  const quaude = spawnSync(tjsPath(), ['run', LOADER, prog], { encoding: 'utf8', env });
  assert.strictEqual((naude.stdout || '').trim(), 'vm-ok:42', 'naude reference must compute vm-ok:42');
  assert.strictEqual(
    (quaude.stdout || '').trim(), (naude.stdout || '').trim(),
    `quaude node:vm must match naude. quaude stdout=${JSON.stringify(quaude.stdout)} stderr=${JSON.stringify((quaude.stderr || '').slice(0, 400))}`,
  );
});
