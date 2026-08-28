'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { rewriteSafeRequires } = require('../libexec/extract-claude-js.cjs');

// A safe require becomes a static import PLUS a local binding, so the call site keeps working
// unchanged. The engine then evaluates the target before the requirer's body runs, which is
// exactly what the failing bundle needed and never got.
test('rewriteSafeRequires: a safe edge becomes an import and a reference', () => {
  const sources = {
    '/g/a.js': 'export const y = require("/g/b.js").x;\n',
    '/g/b.js': 'export const x = 1;\n',
  };
  const out = rewriteSafeRequires(sources, [['/g/a.js', '/g/b.js']]);
  assert.match(out['/g/a.js'], /^import \* as __clodeReq0 from "\/g\/b\.js";/m,
    'a static import is hoisted in');
  assert.match(out['/g/a.js'], /__clodeReq0\.x/, 'the call site now reads the namespace');
  assert.doesNotMatch(out['/g/a.js'], /require\("\/g\/b\.js"\)/, 'no require of it survives');
  assert.strictEqual(out['/g/b.js'], sources['/g/b.js'], 'untouched modules are untouched');
});

test('rewriteSafeRequires: both quote styles are rewritten', () => {
  const sources = { '/g/a.js': "const q = require('/g/b.js');\n", '/g/b.js': 'export const x = 1;\n' };
  const out = rewriteSafeRequires(sources, [['/g/a.js', '/g/b.js']]);
  assert.doesNotMatch(out['/g/a.js'], /require\('\/g\/b\.js'\)/);
});

// The regression guard: a bundle with nothing to rewrite must come out byte-identical.
test('rewriteSafeRequires: no edges means no change at all', () => {
  const sources = { '/g/a.js': 'export const y = 1;\n' };
  const out = rewriteSafeRequires(sources, []);
  assert.deepStrictEqual(out, sources);
});

// Upstream 2.1.248+ does NOT emit bare require("...") of a graph module — it emits Bun's
// CJS-interop-from-ESM form, import.meta.require("..."). Measured on the real 2.1.250 bundle:
// 358 occurrences, ALL of them carrying the import.meta. prefix, zero bare. A fixture using only
// the bare form (as the two tests above do) cannot see the difference between a correct
// prefix-consuming replacement and a naive one — that blind spot is exactly what let a
// string-replace of only `require("target")` ship: it leaves `import.meta.` stranded in front
// of the new local binding, producing `import.meta.__clodeReq0`, which is undefined at runtime
// (`--help` crashed on it). This fixture uses the prefixed form on purpose so the test cannot
// pass by accident the way the bare-require tests above could.
test('rewriteSafeRequires: the import.meta.require(...) prefix is consumed, not stranded', () => {
  const sources = {
    '/g/a.js': 'export const y = import.meta.require("/g/b.js").x;\n',
    '/g/b.js': 'export const x = 1;\n',
  };
  const out = rewriteSafeRequires(sources, [['/g/a.js', '/g/b.js']]);
  assert.doesNotMatch(out['/g/a.js'], /import\.meta\.__clodeReq/,
    'the prefix must not survive in front of the local binding');
  assert.doesNotMatch(out['/g/a.js'], /import\.meta\.require\(/,
    'no import.meta.require(...) of the converted target survives');
  assert.match(out['/g/a.js'], /(?<!\.)\b__clodeReq0\.x/,
    'the call site reads the bare namespace binding');
});
