'use strict';
// A carved module's import.meta.url, .dirname and .dir: ONE derivation (libexec/module-meta.cjs), and BOTH hosts that
// run carved modules give each module what Bun gives it. The graph runner always had dirname; quaude's compiled blob
// had only the url (the engine derives that from the name), and node-shim's path.resolve hid the undefined until it
// learned node's argument checks (2026-11-25), when 2.1.332's builtin-hooks home threw in every interactive quaude.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { moduleMeta, moduleMetaAssignments } = require('../libexec/module-meta.cjs');
const { moduleWithMeta } = require('../libexec/extract-claude-js.cjs');
const { skipUnlessTjs, engineSpawn } = require('./node-shim-helper.cjs');

test('module-meta: what Bun reports for a posix, a win32 and a relative module name', () => {
  assert.deepStrictEqual(moduleMeta('/$bunfs/root/chunk-x.js'), { url: 'file:///$bunfs/root/chunk-x.js', dir: '/$bunfs/root' });
  assert.deepStrictEqual(moduleMeta('B:/~BUN/root/chunk-x.js'), { url: 'file:///B:/~BUN/root/chunk-x.js', dir: 'B:/~BUN/root' });
  assert.deepStrictEqual(moduleMeta('/x.js'), { url: 'file:///x.js', dir: '/' });
  assert.deepStrictEqual(moduleMeta('chunk-x.js'), { url: null, dir: null });
});

test('module-meta: the runner\'s header and quaude\'s blob prefix are the one derivation', () => {
  const name = '/$bunfs/root/chunk-x.js';
  assert.ok(moduleWithMeta(name, 'SRC').startsWith(`import.meta.require = globalThis.__quaudeRequire;${moduleMetaAssignments(name)}\nSRC`));
  // the blob prefixes the same assignments (the engine supplies the url) on the source's first line; that a built
  // quaude's modules really see them is test/fidelity/debug-log-interactive.test.cjs's (it failed without them)
  assert.ok(!moduleMetaAssignments(name, { url: false }).includes('\n'), 'no newline: stack line numbers stay the graph\'s');
});

// The blob's own path, under the engine: compile a module by its graph name, serialize, deserialize, evaluate.
test('module-meta: a module compiled the way quaude-blobulate compiles it sees Bun\'s url, dirname and dir', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'module-meta-'));
  try {
    const prog = path.join(dir, 'p.js');
    const name = '/$bunfs/root/chunk-x.js';
    fs.writeFileSync(prog, `const enc = new TextEncoder();
const src = 'globalThis.__seen = { url: import.meta.url, dirname: import.meta.dirname, dir: import.meta.dir };';
const out = [];
for (const pre of ['', ${JSON.stringify(moduleMetaAssignments(name, { url: false }))}]) {
  await tjs.engine.evalBytecode(tjs.engine.deserialize(tjs.engine.serialize(tjs.engine.compile(enc.encode(pre + src), ${JSON.stringify(name)}))));
  out.push(globalThis.__seen);
}
console.log(JSON.stringify(out));
`);
    const [cmd, argv] = engineSpawn(['run', prog]);
    const r = spawnSync(cmd, argv, { encoding: 'utf8', timeout: 60000 });
    assert.strictEqual(r.status, 0, r.stderr);
    const [bare, prefixed] = JSON.parse(r.stdout);
    assert.deepStrictEqual(bare, { url: 'file:///$bunfs/root/chunk-x.js' }, 'the engine alone derives only the url (why the prefix exists)');
    assert.deepStrictEqual(prefixed, { url: 'file:///$bunfs/root/chunk-x.js', dirname: '/$bunfs/root', dir: '/$bunfs/root' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
