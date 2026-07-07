'use strict';
// Characterization: node:util's isDeepStrictEqual must match host node exactly,
// including the signed-zero distinction (Node treats +0 and -0 as NOT deeply
// equal, unlike ===). A naive `if (a === b) return true;` fast-path masks this.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

const PROG = `
const util = require('node:util');
const out = [];
out.push(util.isDeepStrictEqual(0, -0));
out.push(util.isDeepStrictEqual(-0, -0));
out.push(util.isDeepStrictEqual(0, 0));
out.push(util.isDeepStrictEqual({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 2 } }));
out.push(util.isDeepStrictEqual({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 3 } }));
out.push(util.isDeepStrictEqual(NaN, NaN));
console.log(JSON.stringify(out));
`;

test('util.isDeepStrictEqual characterization vs host node (incl. signed zero)', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-util-'));
  const f = path.join(dir, 'prog.cjs');
  fs.writeFileSync(f, PROG);
  const nodeOut = require('node:child_process')
    .execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim();
  // Host node's actual answer, pinned so a regression in the shim OR a
  // surprise change in host node's semantics both fail loud rather than
  // silently comparing two wrong values against each other.
  assert.strictEqual(nodeOut, JSON.stringify([false, true, true, true, false, true]));
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), nodeOut);
});
