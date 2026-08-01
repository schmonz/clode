'use strict';
// Entry point run on BOTH sides of the surface diff:
//   node  test/shim-surface/enumerate-entry.cjs            -> real node surface
//   tjs run libexec/node-shim/loader.cjs <this>            -> node-shim surface
//
// Prints one JSON object to stdout: { modules: { <name>: {ok,rootType,surface} } }.
// Nothing else may be written to stdout — the caller parses the whole stream.
const { walkModule } = require('./walk.cjs');

// The module list is passed in argv so the single source of truth stays in the
// test (which derives it from libexec/node-shim/modules/*.cjs) rather than being
// duplicated here and drifting.
const names = process.argv.slice(2).filter((a) => !a.startsWith('-'));

const modules = {};
for (const name of names) {
  modules[name] = walkModule(name, require);
}

// JSON.stringify with a stable key order (walkModule already sorts).
process.stdout.write(JSON.stringify({ modules }));
