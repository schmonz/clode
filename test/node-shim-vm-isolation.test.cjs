'use strict';
// Proves the __tjs_vm C primitive gives a genuinely SEPARATE global per context:
// reassigning Date.now inside a child context must NOT change the main context's
// Date.now. This is the isolation the Workflow engine's determinism guard relies on
// (BACKLOG "Known quaude runtime bugs"; docs/superpowers/plans/2026-07-24-vm-context-isolation.md).
// RED until src/mod_vm.c lands; tjs-only (the primitive is a tjs global).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { REPO, tjsPath, skipUnlessTjs, LOADER } = require('./node-shim-helper.cjs');

const PROG = [
  "const vm = globalThis.__tjs_vm;",
  "if (!vm) { process.stdout.write('NO_VM'); } else {",
  "  const c = vm.create();",
  "  vm.run(c, \"Date.now = function(){ throw new Error('guarded') }\", 'ctx');",
  "  let childThrew = false;",
  "  try { vm.run(c, 'Date.now()', 'ctx'); } catch (e) { childThrew = true; }",
  "  const mainOk = typeof Date.now() === 'number';",
  "  process.stdout.write('child-threw:' + childThrew + ' main-ok:' + mainOk);",
  "}",
].join('\n');

function writeProg() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vmiso-'));
  const f = path.join(d, 'p.cjs');
  fs.writeFileSync(f, PROG);
  return f;
}

test('__tjs_vm gives a separate global: child Date.now reassignment does not leak to main', (t) => {
  if (skipUnlessTjs(t)) return;
  const prog = writeProg();
  const env = { ...process.env, NODE_PATH: path.join(REPO, 'deps', 'claude', 'node_modules') };
  const r = spawnSync(tjsPath(), ['run', LOADER, prog], { encoding: 'utf8', env });
  assert.strictEqual(
    (r.stdout || '').trim(), 'child-threw:true main-ok:true',
    `isolation broken. stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify((r.stderr || '').slice(0, 400))}`,
  );
});
