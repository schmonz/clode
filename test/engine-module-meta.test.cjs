'use strict';
// engine.moduleMeta(mod) — READ-ONLY module metadata straight from the parser: the module's
// required specifiers, its export names, and its top-level declared names.
//
// WHY IT EXISTS. Upstream 2.1.248+ require()s graph modules CYCLICALLY, and the fix is to merge
// each cyclic group into one module (see the SCC-merge design). Merging N modules into one
// scope needs to know what names each declares, so collisions can be renamed — and the
// alternatives were shipping a JS parser (a dependency, in a zero-deps project) or pattern-
// matching import/export text (the class of assumption that produced the 2.1.246 repack break).
// The engine already parsed every module to compile it; this asks it what it found.
//
// THE SUBTLETY THIS PINS. A module's top-level bindings are mostly CLOSURE variables — an
// export must be a live binding, so the compiler hoists it — while `vardefs` holds only the few
// that stay local. Reading vardefs alone reported 2 of 8 names. Both tables are required, and
// this test is what stops someone "simplifying" the patch back to one of them.
const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const { engineSpawn, skipUnlessTjs } = require('./node-shim-helper.cjs');

function runEngine(src) {
  const [cmd, argv] = engineSpawn(['eval', src]);
  const r = spawnSync(cmd, argv, { encoding: 'utf8', timeout: 60000 });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

const PROBE = `
const e = globalThis.tjs.engine, enc = new TextEncoder();
e.compile(enc.encode('export const alpha = 1;'), '/g/other.js');
const src = [
  'import { alpha } from "/g/other.js";',
  'const notExported = 1;',
  'function privateFn() { return notExported; }',
  'var oldStyle = 3;',
  'export const shownA = privateFn();',
].join('\\n');
const m = e.moduleMeta(e.compile(enc.encode(src), '/g/probe.js'));
console.log(JSON.stringify({
  requires: m.requires,
  exports: m.exports,
  locals: [...new Set(m.locals)].filter((x) => x.indexOf('<') === -1),
}));
`;

test('engine.moduleMeta reports requires, exports, and ALL top-level names', (t) => {
  if (skipUnlessTjs(t)) return;
  const r = runEngine(PROBE);
  assert.strictEqual(r.status, 0, r.stderr);
  const m = JSON.parse(r.stdout.trim());

  assert.deepStrictEqual(m.requires, ['/g/other.js'], 'required specifiers');
  assert.deepStrictEqual(m.exports, ['shownA'], 'export names');

  // The load-bearing assertion: NON-EXPORTED top-level declarations are reported. Without the
  // closure_var table these are invisible, the merger cannot know what to rename, and a merged
  // module silently shadows a binding — a wrong build that boots.
  for (const name of ['notExported', 'privateFn', 'oldStyle']) {
    assert.ok(m.locals.includes(name), `non-exported top-level '${name}' must be reported, got ${JSON.stringify(m.locals)}`);
  }
  // Imported bindings occupy the top-level scope too, so they count for collisions.
  assert.ok(m.locals.includes('alpha'), 'imported binding occupies top-level scope');
  assert.ok(m.locals.includes('shownA'), 'exported binding is a top-level name too');
});

// Read-only means read-only: asking for metadata must not link or evaluate anything, or the
// merger would be changing the thing it is measuring.
test('engine.moduleMeta does not evaluate the module', (t) => {
  if (skipUnlessTjs(t)) return;
  const r = runEngine(`
const e = globalThis.tjs.engine, enc = new TextEncoder();
const m = e.compile(enc.encode('globalThis.__RAN = true; export const x = 1;'), '/g/side.js');
e.moduleMeta(m);
console.log(JSON.stringify({ ran: globalThis.__RAN === true }));
`);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), { ran: false },
    'moduleMeta must not run the module body');
});
