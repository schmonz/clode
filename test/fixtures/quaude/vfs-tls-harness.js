// A minimal VFS-seam harness (sibling to vfs-harness.js — see that file's own
// header for the full explanation of what a mounted globalThis.__quaudeVFS
// reproduces without a fused binary) scoped to ONE question: does tls.cjs's
// sibling-asset read (tls-cacert.pem, via __dirname + VFS-or-FSS, see
// libexec/node-shim/modules/tls.cjs) actually work when node-shim/modules is
// mounted as archive members exactly as libexec/quaude-fuse.js ships them —
// not just when running unfused straight off the real filesystem (which every
// OTHER tls test in this suite exercises via runLoader). Without this, the
// fused path for tls-cacert.pem would be untested even though it's the one
// that matters for a real quaude.
//
// Usage: tjs run vfs-tls-harness.js <loader.cjs> <node-shim-dir>
import path from 'tjs:path';

const [loaderPath, shimRoot] = tjs.args.slice(3);
if (!shimRoot) { console.error('usage: tjs run vfs-tls-harness.js <loader.cjs> <node-shim-dir>'); tjs.exit(64); }

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

// The real shim tree, INCLUDING tls-cacert.pem — collect() has no extension
// filter, matching libexec/quaude-fuse.js exactly (that's the property under
// test: a non-.cjs sibling file rides along for free).
files.set('node-shim/loader.cjs', await tjs.readFile(loaderPath));
await collect(path.join(shimRoot, 'modules'), 'node-shim/modules');
await collect(path.join(shimRoot, 'internal'), 'node-shim/internal');
files.set('target-env.cjs', await tjs.readFile(path.join(path.dirname(shimRoot), 'target-env.cjs')));

const miniCli = `
const tls = require('tls');
const roots = tls.rootCertificates;
console.log(JSON.stringify({
  count: roots.length,
  firstLooksLikePem: /^-----BEGIN CERTIFICATE-----\\n/.test(roots[0] || ''),
  frozen: Object.isFrozen(roots),
}));
`;
const wrapped = 'globalThis.__quaude_entry = function (exports, require, module, __filename, __dirname) {\n' + miniCli + '\n};\n';
files.set('cli.qbc', tjs.engine.serialize(tjs.engine.compile(enc.encode(wrapped), '/quaude/cli.cjs')));

globalThis.__quaudeVFS = { files, index: { version: 0, members: [] } };
globalThis.__quaudeArgs = [];

const loaderSrc = new TextDecoder().decode(files.get('node-shim/loader.cjs'));
(0, new Function(loaderSrc))();
