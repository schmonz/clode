// VFS-seam harness (Q1b): reproduces, in miniature and WITHOUT a fused binary,
// exactly what libexec/quaude-bootstrap.mjs does at quaude startup — build an
// in-memory archive Map, mount it as globalThis.__quaudeVFS, set
// globalThis.__quaudeArgs, and evaluate the node-shim loader source — so the
// loader's /quaude/ resolution and .qbc entry path are unit-testable.
//
// Usage: tjs run vfs-harness.js <loader.cjs> <node-shim-dir> [entryArgs...]
//
// The mini cli.cjs exercises every seam the real fused bundle relies on:
// relative require from /quaude, require(__dirname + '/bun-shim.cjs'), a bare
// specifier resolved from /quaude/node_modules, require.main identity, argv
// shape, and a process.env read+write (the strict-mode env fix — the entry is
// compiled as a MODULE, so it runs strict like the real cli.qbc).
import path from 'tjs:path';

const [loaderPath, shimRoot, ...entryArgs] = tjs.args.slice(3);
if (!shimRoot) { console.error('usage: tjs run vfs-harness.js <loader.cjs> <node-shim-dir> [entryArgs...]'); tjs.exit(64); }

const enc = new TextEncoder();
const files = new Map();

async function collect(dir, prefix) {
  for await (const item of await tjs.readDir(dir)) {
    const full = path.join(dir, item.name);
    const rel = `${prefix}/${item.name}`;
    if (item.isDirectory) await collect(full, rel);
    else if (item.isFile && !item.name.startsWith('._') && !item.name.startsWith('.DS_')) {
      files.set(rel, await tjs.readFile(full));
    }
  }
}

// The real shim tree (the fused quaude ships these very files as members).
files.set('node-shim/loader.cjs', await tjs.readFile(loaderPath));
await collect(path.join(shimRoot, 'modules'), 'node-shim/modules');
await collect(path.join(shimRoot, 'internal'), 'node-shim/internal');

// Mini members standing in for the extracted bundle + deps.
files.set('lib.cjs', enc.encode(`module.exports = { value: 'vfs-lib-ok' };\n`));
files.set('bun-shim.cjs', enc.encode(`module.exports = 'bunshim-ok';\n`));
files.set('node_modules/fakepkg/package.json', enc.encode(JSON.stringify({ name: 'fakepkg', version: '0.0.0', main: 'index.js' })));
files.set('node_modules/fakepkg/index.js', enc.encode(`module.exports = { name: 'fakepkg-ok' };\n`));

// Mini cli.cjs -> cli.qbc, compiled exactly as the fuse step compiles the real
// bundle (CJS-wrapper function assigned to __quaude_entry, module => strict).
const miniCli = `
const lib = require('./lib.cjs');
const shim = require(__dirname + '/bun-shim.cjs');
const pkg = require('fakepkg');
process.env.VFS_HARNESS_SET = 'wrote';   // strict-mode env write must not throw
console.log(JSON.stringify({
  argv: process.argv.slice(1),
  dirname: __dirname,
  filename: __filename,
  lib: lib.value,
  shim,
  pkg: pkg.name,
  isMain: require.main === module,
  envSet: process.env.VFS_HARNESS_SET,
}));
`;
const wrapped = 'globalThis.__quaude_entry = function (exports, require, module, __filename, __dirname) {\n' + miniCli + '\n};\n';
files.set('cli.qbc', tjs.engine.serialize(tjs.engine.compile(enc.encode(wrapped), '/quaude/cli.cjs')));

// Builder-role variant (Q1c): with VFS_HARNESS_SOURCE_ENTRY set, mount a
// manifest whose `entry` names a SOURCE member (the native clode builder ships
// its esbuilt clode-main bundle as source, not bytecode) — the loader must boot
// that member instead of the default cli.qbc.
let manifest;
if (tjs.env.VFS_HARNESS_SOURCE_ENTRY) {
  files.set('main.cjs', enc.encode(`
const lib = require('./lib.cjs');
console.log(JSON.stringify({
  argv: process.argv.slice(1),
  filename: __filename,
  dirname: __dirname,
  lib: lib.value,
  isMain: require.main === module,
}));
`));
  manifest = { quaude: '1', role: 'builder', entry: 'main.cjs' };
}

globalThis.__quaudeVFS = { files, index: { version: 0, members: [] }, manifest };
globalThis.__quaudeArgs = entryArgs;

const loaderSrc = new TextDecoder().decode(files.get('node-shim/loader.cjs'));
(0, new Function(loaderSrc))();
