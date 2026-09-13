#!/usr/bin/env node
'use strict';
// ES5-SAFE PROLOGUE: runs on ANY node so an old node still prints the friendly
// floor error instead of a syntax crash. No const/arrow/async/await/optional-
// chaining/?? anywhere in this file — only `import(...)` as a bare call
// expression, which an engine with no idea what `import` means simply parses
// as calling an (undefined, never-reached) function named `import`; that is
// ordinary ES5 CallExpression grammar, not a syntax-error risk. This file is
// ESM (`.mjs`) so a STATIC `import` declaration would be hoisted and resolved
// before this floor check ever ran; a dynamic `import()` call is not hoisted,
// so it only executes once the check below has already let a new-enough node
// through. clode never runs the extracted bundle under node — the blobulate
// worker and the blobulated artifacts exec under tjs; node only orchestrates
// file work (build, fetch, watch), so its floor is what the orchestration
// code itself needs.
// v20 is the living-proof floor: OpenIndiana's packaged node is 20.x and
// OpenBSD 7.9's is 22.x — the matrix's legs blobulate on both (libexec parses
// clean down to 18). There is no other command left with a higher floor
// (the old runner's v24 'using'-declaration floor died with the runner), so
// this is simply the floor now, not a per-command ternary.
var floor = 20;
var major = parseInt(String(process.versions.node).split('.')[0], 10);
if (!(major >= floor)) {
  process.stderr.write('clode: node v' + process.versions.node + ' is too old; need >= v' + floor + '\n');
  process.stderr.write("clode: (the extracted bundle uses newer JS, e.g. 'using' declarations)\n");
  process.exit(1);
}
Promise.all([import('node:url'), import('../libexec/clode-main.cjs')])
  .then(function (mods) {
    var fileURLToPath = mods[0].fileURLToPath;
    var clodeMain = mods[1].default || mods[1];
    var self = fileURLToPath(import.meta.url);
    return clodeMain.main(process.argv.slice(2), { self: self }).catch(function (e) {
      process.stderr.write('clode: ' + clodeMain.formatError(e) + '\n');
      process.exit(1);
    });
  })
  .catch(function (e) {
    process.stderr.write('clode: ' + (e && e.stack ? e.stack : e) + '\n');
    process.exit(1);
  });
