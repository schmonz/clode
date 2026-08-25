// NOTE on the expected `import.meta.url`: it is a file:// URL, not a bare path.
// Stock txiki puts the bare module name there when use_realpath is false, and the
// 2.1.245 bundle does fileURLToPath(import.meta.url) — which threw "Invalid URL" and was
// the wall immediately after the identity fix below. Bun reports file:///$bunfs/root/...
// for these modules, so clode's fixup matches the runtime the bundle was built for.
'use strict';
// import.meta must be populated for a module that was only DESERIALIZED — and it must be
// the meta of the module actually running.
//
// From Claude Code 2.1.243 the CLI is a code-split ESM graph. clode compiles every module
// ahead of time, deserializes them all so quickjs resolves imports from its loaded-module
// list, and evaluates ONLY the entry (libexec/node-shim/loader.cjs, evalBytecodeGraph).
// Upstream's own runtime helper chunk ends with `C = import.meta.require` and exports it;
// callers do `S("stream")`. Get import.meta wrong on that chunk and `S` is undefined and
// the bundle dies with "not a function" deep inside vendored code — with no hint that the
// engine, not the bundle, is at fault.
//
// Three fixups in scripts/build-tjs.mjs cooperate to make it work, and this file is the
// wire-level check on all three at once:
//   fixupImportMetaRequire       — import.meta.require exists at all (from __quaudeRequire)
//   fixupImportMetaDeserialize   — a deserialized-but-not-evaluated module gets its meta
//   fixupQjsImportMetaByIdentity — import.meta resolves the RUNNING module, not the first
//                                  loaded module that happens to share its name
//
// The last one is the subtle one and cost most of a day. quickjs's js_import_meta looks
// the module up by filename atom (js_find_loaded_module returns the FIRST match) while
// js_module_set_import_meta sets properties on the JSModuleDef it was handed. Register two
// defs under one name — js_new_module_def list_add_tail's and never dedupes — and the two
// silently diverge. The symptom is "a module that went through serialize/deserialize sees
// an empty import.meta", which reads exactly like the meta object being baked into the
// bytecode. It is not; bytecode is innocent. `noPriorCompile` vs `collidingName` below is
// that whole diagnosis, frozen.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { skipUnlessTjs, engineSpawn } = require('./node-shim-helper.cjs');

function q(s) { return JSON.stringify(s); }

// Two processes on purpose: compiling and deserializing the same module name in ONE
// context is the collision case, and the production loader never does it — the bytecode
// is produced by `clode build` and consumed by a later run of the fused binary.
function runEngine(src, dir) {
  const f = path.join(dir, `s${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(f, src);
  const [cmd, argv] = engineSpawn(['run', f]);
  const r = spawnSync(cmd, argv, { encoding: 'utf8', timeout: 60000 });
  return { status: r.status, stdout: (r.stdout || '').trim(), stderr: r.stderr || '' };
}

function withDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-meta-graph-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// Emit bytecode for one module to `out`.
function serializeStep(dir, moduleSrc, moduleName, out) {
  return runEngine(
    `const enc = new TextEncoder();\n`
    + `await tjs.writeFile(${q(out)}, tjs.engine.serialize(tjs.engine.compile(enc.encode(${q(moduleSrc)}), ${q(moduleName)})));\n`
    + `console.log('serialized');\n`,
    dir);
}

const PROBE = 'globalThis.__P = import.meta.url + "|" + typeof import.meta.require;';

test('import.meta: a deserialized module gets url AND require', (t) => {
  if (skipUnlessTjs(t)) return;
  withDir((dir) => {
    const bc = path.join(dir, 'probe.bc');
    const s = serializeStep(dir, PROBE, '/$bunfs/root/probe.js', bc);
    assert.strictEqual(s.stdout, 'serialized', `serialize step failed: ${s.stderr}`);

    const r = runEngine(
      `globalThis.__quaudeRequire = (m) => 'req:' + m;\n`
      + `tjs.engine.evalBytecode(tjs.engine.deserialize(await tjs.readFile(${q(bc)})));\n`
      + `console.log(globalThis.__P);\n`, dir);
    // Pre-fix this printed `undefined|undefined`: nothing set the meta on the deserialized
    // module at all, because stock txiki only sets it in tjs_evalBytecode.
    assert.strictEqual(r.stdout, 'file:///$bunfs/root/probe.js|function', `stderr: ${r.stderr}`);
    assert.strictEqual(r.status, 0);
  });
});

test('import.meta: a module sharing its name with an earlier one still reads its OWN meta', (t) => {
  if (skipUnlessTjs(t)) return;
  withDir((dir) => {
    const bc = path.join(dir, 'probe.bc');
    const s = serializeStep(dir, PROBE, '/$bunfs/root/probe.js', bc);
    assert.strictEqual(s.stdout, 'serialized', `serialize step failed: ${s.stderr}`);

    const prelude = `globalThis.__quaudeRequire = (m) => 'req:' + m;\n`
      + `const bc = await tjs.readFile(${q(bc)});\n`;
    const tail = `tjs.engine.evalBytecode(tjs.engine.deserialize(bc));\nconsole.log(globalThis.__P);\n`;

    // Control: nothing else claims that name.
    const noPriorCompile = runEngine(prelude + tail, dir);
    assert.strictEqual(noPriorCompile.stdout, 'file:///$bunfs/root/probe.js|function',
      `control run is broken, not the collision case; stderr: ${noPriorCompile.stderr}`);

    // A DIFFERENT module registered under the SAME name first. Pre-fix this printed
    // `undefined|undefined`: js_find_loaded_module returned the decoy's def.
    const collidingName = runEngine(
      prelude
      + `tjs.engine.compile(new TextEncoder().encode('globalThis.__DECOY = 1;'), '/$bunfs/root/probe.js');\n`
      + tail, dir);
    assert.strictEqual(collidingName.stdout, 'file:///$bunfs/root/probe.js|function',
      `a same-named decoy stole import.meta; stderr: ${collidingName.stderr}`);

    // A decoy under a different name never mattered — it is here so a future regression
    // that breaks ALL lookups cannot masquerade as "the collision case still passes".
    const otherName = runEngine(
      prelude
      + `tjs.engine.compile(new TextEncoder().encode('globalThis.__DECOY = 1;'), '/$bunfs/root/other.js');\n`
      + tail, dir);
    assert.strictEqual(otherName.stdout, 'file:///$bunfs/root/probe.js|function', `stderr: ${otherName.stderr}`);
  });
});

test('import.meta: the 2.1.243 shape — a preregistered, never-evaluated module supplies require', (t) => {
  if (skipUnlessTjs(t)) return;
  withDir((dir) => {
    // helper.js is exactly upstream's runtime chunk in miniature: it reads
    // import.meta.require at top level and exports it. It is NEVER passed to
    // evalBytecode — only deserialized, so quickjs can resolve the entry's import.
    const helperBc = path.join(dir, 'helper.bc');
    const entryBc = path.join(dir, 'entry.bc');
    // Both compiled in ONE process, helper first — the entry's `import` has to resolve
    // against the loaded-module list at compile time or quickjs goes to the module loader
    // and tries to read /g/helper.js off disk. `clode build` compiles the graph the same
    // way, in dependency order, for exactly this reason.
    const helperSrc = 'export const R = import.meta.require;\nexport const U = import.meta.url;\n';
    const entrySrc = 'import { R, U } from "./helper.js";\nconsole.log(U + "|" + typeof R + "|" + R("stream"));\n';
    const s = runEngine(
      `const enc = new TextEncoder();\n`
      + `const h = tjs.engine.compile(enc.encode(${q(helperSrc)}), '/g/helper.js');\n`
      + `const e = tjs.engine.compile(enc.encode(${q(entrySrc)}), '/g/entry.js');\n`
      + `await tjs.writeFile(${q(helperBc)}, tjs.engine.serialize(h));\n`
      + `await tjs.writeFile(${q(entryBc)}, tjs.engine.serialize(e));\n`
      + `console.log('serialized');\n`, dir);
    assert.strictEqual(s.stdout, 'serialized', `graph serialize failed: ${s.stderr}`);

    const r = runEngine(
      `globalThis.__quaudeRequire = (m) => 'req:' + m;\n`
      + `tjs.engine.deserialize(await tjs.readFile(${q(helperBc)}));\n`
      + `tjs.engine.evalBytecode(tjs.engine.deserialize(await tjs.readFile(${q(entryBc)})));\n`, dir);
    assert.strictEqual(r.stdout, 'file:///g/helper.js|function|req:stream', `stderr: ${r.stderr}`);
    assert.strictEqual(r.status, 0);
  });
});

// The whole point of sourcing require from a global is that a non-quaude use of this
// engine sees stock txiki. url is txiki's own (it has always set that in evalBytecode);
// require must simply not be there.
test('import.meta: without __quaudeRequire the property is absent, url unchanged', (t) => {
  if (skipUnlessTjs(t)) return;
  withDir((dir) => {
    const bc = path.join(dir, 'probe.bc');
    const s = serializeStep(dir, PROBE, '/$bunfs/root/probe.js', bc);
    assert.strictEqual(s.stdout, 'serialized', `serialize step failed: ${s.stderr}`);

    const r = runEngine(
      `tjs.engine.evalBytecode(tjs.engine.deserialize(await tjs.readFile(${q(bc)})));\n`
      + `console.log(globalThis.__P + '|' + ('require' in import.meta));\n`, dir);
    assert.strictEqual(r.stdout, 'file:///$bunfs/root/probe.js|undefined|false', `stderr: ${r.stderr}`);
    assert.strictEqual(r.status, 0);
  });
});

// The identity lookup only matches when the running frame IS the module's top-level
// function. Read import.meta from a NESTED function — a callback, which is how real code
// usually reaches it late — and quickjs falls back to the stock name lookup. That path is
// unchanged by the fix and must keep working; this is the guardrail that the fix ADDS a
// case rather than replacing one.
test('import.meta: reachable from a nested function, and from a later tick', (t) => {
  if (skipUnlessTjs(t)) return;
  withDir((dir) => {
    const bc = path.join(dir, 'nested.bc');
    const s = serializeStep(dir,
      'const read = () => import.meta.url + "|" + typeof import.meta.require;\n'
      + 'globalThis.__SYNC = read();\n'
      + 'setTimeout(() => { console.log(globalThis.__SYNC + "|" + read()); }, 0);\n',
      '/$bunfs/root/nested.js', bc);
    assert.strictEqual(s.stdout, 'serialized', `serialize step failed: ${s.stderr}`);

    const r = runEngine(
      `globalThis.__quaudeRequire = (m) => 'req:' + m;\n`
      + `tjs.engine.evalBytecode(tjs.engine.deserialize(await tjs.readFile(${q(bc)})));\n`, dir);
    const want = 'file:///$bunfs/root/nested.js|function|file:///$bunfs/root/nested.js|function';
    assert.strictEqual(r.stdout, want, `stderr: ${r.stderr}`);
    assert.strictEqual(r.status, 0);
  });
});
