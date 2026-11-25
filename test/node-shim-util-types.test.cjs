'use strict';
// util/types under node-shim answers as host node's does: every predicate node has, over one value matrix
// (test/fixtures/util-types-probe.cjs), including the spoofs a toStringTag or prototype check would fall for.
//
// WHY. 2.1.332 imports util/types as a namespace and calls A.isRegExp(o) while loading builtin plugins' hooks
// modules. The shim's util.types held only isDate and isProxy, so three of four hooks modules failed to load with
// QuickJS's nameless "not a function", in every quaude turn. The shim-surface map now measures subpath members too
// (test/shim-surface/collect.cjs); this holds each predicate's ANSWERS, which a presence map cannot.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { skipUnlessTjs, runLoader } = require('./node-shim-helper.cjs');

const PROBE = path.join(__dirname, 'fixtures', 'util-types-probe.cjs');

// Where the shim cannot read the slot node reads, it says so in libexec/node-shim/modules/util.cjs; each such
// answer is named here, by predicate and value, and nothing else may differ.
const KNOWN = {
  isProxy: [],   // no Proxy is in the matrix: the shim answers false for all, as node does for non-proxies
};

test('util/types: every predicate host node has, answered as host node answers it', (t) => {
  if (skipUnlessTjs(t)) return;
  const node = spawnSync(process.execPath, [PROBE], { encoding: 'utf8' });
  assert.strictEqual(node.status, 0, node.stderr);
  const ref = JSON.parse(node.stdout);
  const shim = runLoader(PROBE, [JSON.stringify(ref.names)]);
  assert.strictEqual(shim.status, 0, shim.stderr);
  const got = JSON.parse(shim.stdout);
  const diffs = [];
  for (const [label, answers] of Object.entries(ref.rows)) {
    answers.forEach((a, i) => {
      const name = ref.names[i];
      if (got.rows[label][i] !== a && !(KNOWN[name] || []).includes(label)) diffs.push(`${name}(${label}): node ${a}, shim ${got.rows[label][i]}`);
    });
  }
  assert.deepStrictEqual(diffs, [], `util/types answers that differ from host node ${process.version}:\n  ${diffs.join('\n  ')}`);
  assert.ok(ref.names.length >= 40, `node's util.types has ${ref.names.length} predicates; expected at least 40`);
});
