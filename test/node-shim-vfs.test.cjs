'use strict';
// Q1b item 2: the loader's quaude-VFS seam and .qbc bytecode-entry path.
//   - Mounted VFS (test/fixtures/quaude/vfs-harness.js mirrors the bootstrap):
//     /quaude/ members resolve for relative requires, __dirname-anchored
//     requires, bare specifiers (node_modules members), shim builtins; argv is
//     [exePath, /quaude/cli.cjs, ...__quaudeArgs]; the module-compiled (strict)
//     entry can WRITE process.env (the env-proxy fix).
//   - No VFS, .qbc entry on disk: `tjs run loader.cjs entry.qbc` evaluates the
//     bytecode with the .cjs module identity.
//   - No VFS at all: byte-identical legacy behavior (the rest of the node-shim
//     suite is the regression net; a smoke row here pins the argv shape).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tjsPath, runLoader, skipUnlessTjs, REPO, LOADER } = require('./node-shim-helper.cjs');

const HARNESS = path.join(__dirname, 'fixtures/quaude/vfs-harness.js');
const SHIM_ROOT = path.join(REPO, 'libexec/node-shim');

function runHarness(entryArgs) {
  return spawnSync(tjsPath(), ['run', HARNESS, LOADER, SHIM_ROOT, ...entryArgs], {
    encoding: 'utf8', timeout: 30000,
  });
}

test('VFS mount: /quaude members resolve (relative, __dirname, bare specifier) and argv is carved', (t) => {
  if (skipUnlessTjs(t)) return;
  const r = runHarness(['-p', 'hello world']);
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  assert.strictEqual(out.argv[0], '/quaude/cli.cjs');       // .qbc presents its .cjs identity
  assert.deepStrictEqual(out.argv.slice(1), ['-p', 'hello world']); // __quaudeArgs verbatim
  assert.strictEqual(out.dirname, '/quaude');
  assert.strictEqual(out.filename, '/quaude/cli.cjs');
  assert.strictEqual(out.lib, 'vfs-lib-ok');                // ./lib.cjs from the archive
  assert.strictEqual(out.shim, 'bunshim-ok');               // require(__dirname + '/bun-shim.cjs')
  assert.strictEqual(out.pkg, 'fakepkg-ok');                // bare specifier via /quaude/node_modules
  assert.strictEqual(out.isMain, true);                     // require.main === entry module
  assert.strictEqual(out.envSet, 'wrote');                  // strict-mode env write round-trips
});

test('VFS mount: empty entry args yield argv [entry] alone', (t) => {
  if (skipUnlessTjs(t)) return;
  const r = runHarness([]);
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  assert.deepStrictEqual(out.argv, ['/quaude/cli.cjs']);
});

test('VFS mount: manifest.entry selects a SOURCE entry member (builder role, Q1c)', (t) => {
  if (skipUnlessTjs(t)) return;
  const r = spawnSync(tjsPath(), ['run', HARNESS, LOADER, SHIM_ROOT, 'build', '--out', 'x'], {
    encoding: 'utf8', timeout: 30000,
    env: { ...process.env, VFS_HARNESS_SOURCE_ENTRY: '1' },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  assert.strictEqual(out.argv[0], '/quaude/main.cjs');      // manifest.entry, not cli.qbc
  assert.deepStrictEqual(out.argv.slice(1), ['build', '--out', 'x']); // argv verbatim (no carve)
  assert.strictEqual(out.filename, '/quaude/main.cjs');
  assert.strictEqual(out.dirname, '/quaude');
  assert.strictEqual(out.lib, 'vfs-lib-ok');                // relative require from the archive
  assert.strictEqual(out.isMain, true);
});

test('.qbc entry from disk (no VFS): bytecode evaluates with the .cjs module identity', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-qbc-'));
  // Compile a tiny entry to bytecode using the same tjs binary (writer == reader).
  const compiler = path.join(dir, 'compile.js');
  const entrySrc = `console.log(JSON.stringify({
    argv1: process.argv[1], filename: __filename, dirname: __dirname,
    isMain: require.main === module, extra: process.argv.slice(2) }));`;
  fs.writeFileSync(compiler, `
const enc = new TextEncoder();
const wrapped = 'globalThis.__quaude_entry = function (exports, require, module, __filename, __dirname) {\\n'
  + ${JSON.stringify(entrySrc)} + '\\n};\\n';
await tjs.writeFile(${JSON.stringify(path.join(dir, 'entry.qbc'))},
  tjs.engine.serialize(tjs.engine.compile(enc.encode(wrapped), ${JSON.stringify(path.join(dir, 'entry.cjs'))})));
`);
  const c = spawnSync(tjsPath(), ['run', compiler], { encoding: 'utf8', timeout: 30000 });
  assert.strictEqual(c.status, 0, c.stderr);
  const r = runLoader(path.join(dir, 'entry.qbc'), ['x', 'y']);
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  assert.strictEqual(out.argv1, path.join(dir, 'entry.cjs'));
  assert.strictEqual(out.filename, path.join(dir, 'entry.cjs'));
  assert.strictEqual(out.dirname, dir);
  assert.strictEqual(out.isMain, true);
  assert.deepStrictEqual(out.extra, ['x', 'y']);
});

test('no VFS: source-entry argv shape is unchanged (legacy contract)', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-novfs-'));
  const f = path.join(dir, 'e.cjs');
  fs.writeFileSync(f, `console.log(JSON.stringify({ argv1: process.argv[1], rest: process.argv.slice(2), vfs: typeof globalThis.__quaudeVFS }));`);
  const r = runLoader(f, ['a', 'b']);
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  assert.strictEqual(out.argv1, f);
  assert.deepStrictEqual(out.rest, ['a', 'b']);
  assert.strictEqual(out.vfs, 'undefined');
});
