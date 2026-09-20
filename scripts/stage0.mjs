#!/usr/bin/env node
'use strict';
// ES5-SAFE PROLOGUE: runs on ANY node new enough to load this file as an ES
// module, so a too-old-but-still-.mjs-aware node prints the friendly floor
// error instead of a syntax crash. No const/arrow/async/await/optional-
// chaining/?? anywhere.
//
// CORRECTION (this comment previously claimed `import.meta`/`import()` are
// harmless to an engine that "doesn't know what `import` means" because they'd
// just parse as calling an undefined function. That is WRONG for `import.meta`:
// per spec, `import.meta` outside Module goal is an EARLY ERROR — a parse-time
// SyntaxError, not a graceful runtime ReferenceError. Measured directly:
// `node -e "new (require('vm').Script)(fs.readFileSync('scripts/stage0.mjs'))"`
// throws `SyntaxError: Cannot use 'import.meta' outside a module` on BOTH
// v26.3.0 and a real v18.20.8 — there is no engine on which that line degrades
// gracefully; it either parses fine (Module goal) or dies at parse time
// (Script goal), full stop.
//
// The reasoning that actually holds, and is narrower: this file is safe
// because `.mjs` is ALWAYS parsed in Module goal — by any interpreter new
// enough to special-case that extension at all — which is precisely the goal
// where `import()`/`import.meta` are legal grammar. It is NOT safe on an
// interpreter that predates `.mjs`-as-ESM dispatch: such a node would fall
// back to parsing this file as a plain script (Script goal) and hit the
// `import.meta` early error above — a raw crash, not the friendly message.
// So the "runs on ANY node" claim has a real lower bound: verified (by
// actually RUNNING, not require()-ing, this file — see clode-main.test.cjs)
// on real interpreters v18.20.8 through v26.3.0, all either print the
// floor message (below v20) or proceed normally (at/above it); UNVERIFIED,
// and at real risk of the raw SyntaxError instead, on anything old enough to
// not treat `.mjs` as a module unconditionally (Node's ESM support predates
// this task, but was not independently re-measured further back than 18.20.8).
//
// Separately: a STATIC `import` declaration would be hoisted and resolved
// before this floor check ever ran; the dynamic `import()` calls below are
// not hoisted, so they only execute once the check has already let a
// new-enough node through. clode never runs the extracted bundle under
// node — the blobulate worker and the blobulated artifacts exec under tjs;
// node only orchestrates file work (build, fetch, watch), so its floor is
// what the orchestration code itself needs.
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
// ES5 shapes and no template literals, like the rest of this file: stage0 has to PARSE on
// the oldest node it might meet before it can tell that node it is too old.
function stage0ErrText(e) {
  var st = e && e.stack ? String(e.stack) : '';
  var head = String(e);
  if (!st) return head;
  return st.indexOf(head) === 0 ? st : head + '\n' + st;
}

Promise.all([import('node:url'), import('../libexec/clode-main.cjs')])
  .then(function (mods) {
    var fileURLToPath = mods[0].fileURLToPath;
    var clodeMain = mods[1].default || mods[1];
    var self = fileURLToPath(import.meta.url);
    // kind: 'checkout' — THIS entry point is a source checkout, so its table is the
    // shipped one plus the checkout-only verbs (`bootstrap`). The built clode binary
    // passes nothing and gets 'shipped', which is how "a shipped clode cannot
    // bootstrap" stays a property of the data rather than a conditional in dispatch.
    return clodeMain.main(process.argv.slice(2), { self: self, kind: 'checkout' }).catch(function (e) {
      process.stderr.write('clode: ' + clodeMain.formatError(e) + '\n');
      process.exit(1);
    });
  })
  .catch(function (e) {
    // The message, then the frames. QuickJS's Error#stack is frames ONLY (V8's begins with
    // the message), so `e.stack` alone prints a bootstrap failure with no reason attached
    // on every tjs-hosted clode -- the shape that cost CI run 35530707866 a round trip.
    // The startsWith guard keeps node from printing the message twice.
    process.stderr.write('clode: ' + stage0ErrText(e) + '\n');
    process.exit(1);
  });
