// graph-meta — ask the ENGINE what a staged graph's modules declare at top level.
//
//   tjs run libexec/graph-meta.js <graph.json> <names.json> <out.json>
//
// The cyclic-group merge (libexec/graph-scc-merge.cjs) renames only bindings a real parser
// reported, and quickjs is the only parser we have: JS_GetModuleMeta reads the compiled
// module's own vardefs + closure_var tables. Guessing those names from minified text is
// REFUSED on purpose — a merged module that silently shadows a binding compiles and boots
// fine and then fails somewhere rare.
//
// So when the merge runs on a host that is NOT itself tjs (clode under node, which is the
// dev and CI shape), staging spawns this script to answer the one question it cannot:
// libexec/clode-extract.cjs writes the graph and the wanted names, runs this, reads the
// metadata back, and does the merge itself. Under a fused clode there is no spawn — the
// engine is already in-process and clode-extract calls the same engine API directly.
//
// WHY EVERY MODULE IS COMPILED and not just the wanted ones: compile() resolves a module's
// imports as it compiles, so compiling one in isolation fails with "could not load". The
// staged order is topological, so one pass over it registers everything each later module
// needs. Same property the fuse worker relies on.

const [docPath, namesPath, outPath] = tjs.args.slice(3);
if (!outPath) {
  console.error('usage: tjs run graph-meta.js <graph.json> <names.json> <out.json>');
  tjs.exit(64);
}
if (typeof tjs.engine?.moduleMeta !== 'function') {
  // Same posture as the stale-engine constants gate: refuse and name the rebuild rather
  // than fall back to something that would look like it worked.
  console.error('graph-meta: this engine does not report moduleMeta, which the cyclic-group '
    + 'merge needs to know each module\'s real top-level bindings.\n'
    + '  Rebuild the engine: node scripts/build-tjs.mjs');
  tjs.exit(1);
}

const dec = new TextDecoder();
const enc = new TextEncoder();
const doc = JSON.parse(dec.decode(await tjs.readFile(docPath)));
const want = new Set(JSON.parse(dec.decode(await tjs.readFile(namesPath))));

const out = {};
for (const name of doc.order) {
  const src = doc.sources[name];
  if (typeof src !== 'string') {
    console.error(`graph-meta: staged graph has no source for ${name}`);
    tjs.exit(1);
  }
  let mod;
  try {
    mod = tjs.engine.compile(enc.encode(src), name);
  } catch (e) {
    console.error(`graph-meta: compiling ${name} failed: ${e.message ?? e}`
      + ' (a "could not load" here means the staged order is not topological)');
    tjs.exit(1);
  }
  if (want.has(name)) out[name] = tjs.engine.moduleMeta(mod);
}
for (const name of want) {
  if (!Object.prototype.hasOwnProperty.call(out, name)) {
    console.error(`graph-meta: ${name} was asked for but is not in the staged order`);
    tjs.exit(1);
  }
}
await tjs.writeFile(outPath, enc.encode(JSON.stringify(out)));
