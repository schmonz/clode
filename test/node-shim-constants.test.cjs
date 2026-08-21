'use strict';
// The CLASS behind the 2.1.238 errno P0.
//
// The bundle reads `constants` tables the shim hand-maintains. When it reads one
// we never populated, the failure mode depends entirely on luck: os.constants.errno
// was absent, `Object.entries(undefined)` threw, and every quaude built against
// 2.1.238 was dead on arrival — loud, but only once someone ran a build. The quiet
// version is worse: a missing fs.constants.S_IFMT makes a file-type mask evaluate
// to NaN and silently misclassify, with nothing to catch it.
//
// Individual rows pin the tables we KNOW the bundle reads (os.constants.signals,
// os.constants.errno, zlib.constants). This row exists for the ones we don't: it
// inventories every constants surface against host node and pins the gap set to a
// golden file, so a gap that appears — because upstream node grew a constant, or
// because someone trimmed a table — shows up as a dated, named failure instead of
// waiting for a boot to trip over it. Closing a gap fails too, asking you to
// ratchet the golden down; the list only shrinks.
//
// Deliberately NOT a demand that every gap be closed. Most of these are unread and
// some are unimplementable here. The product is an accurate, reviewed list.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

const GOLDEN = path.join(__dirname, 'shim-surface', 'constants-golden.json');
const MODULES = ['os', 'fs', 'zlib', 'crypto', 'dns', 'tty', 'net', 'http2'];

// Report shape, not values: group NAMES and their member counts. Values are the
// job of the per-table deep-equal rows; this row is about presence.
const PROBE = `
const out = {};
for (const m of ${JSON.stringify(MODULES)}) {
  let c;
  try { c = require(m).constants; }
  catch (e) { out[m] = 'THROWS'; continue; }
  if (c === undefined || c === null) { out[m] = 'ABSENT'; continue; }
  const g = {};
  for (const k of Object.keys(c)) {
    const v = c[k];
    g[k] = (v && typeof v === 'object') ? Object.keys(v).length : null;
  }
  out[m] = g;
}
console.log(JSON.stringify(out));
`;

function gaps() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-const-'));
  const f = path.join(dir, 'probe.cjs');
  fs.writeFileSync(f, PROBE);
  const host = JSON.parse(execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim());
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  const shim = JSON.parse(r.stdout.trim());

  const report = {};
  for (const m of MODULES) {
    const h = host[m], s = shim[m];
    // One side absent/throwing: record LABELS, not the table. Spilling node's
    // whole http2 constants map into the golden would make the file unreviewable,
    // and an unreviewable golden gets rubber-stamped — which is how a golden stops
    // being a decision and becomes decoration.
    const label = (v) => (typeof v === 'string' ? v : `PRESENT(${Object.keys(v).length} groups)`);
    if (typeof h === 'string' || typeof s === 'string') {
      if (label(h) !== label(s)) report[m] = { host: label(h), shim: label(s) };
      continue;
    }
    const missing = Object.keys(h).filter((k) => !(k in s));
    // A group present on both but of a different SIZE is a partial table — the
    // shape that lets a lookup return undefined without anything looking absent.
    const partial = Object.keys(h).filter((k) => k in s && h[k] !== s[k])
      .map((k) => `${k} (host ${h[k]}, shim ${s[k]})`);
    if (missing.length || partial.length) {
      report[m] = {};
      if (missing.length) report[m].missing = missing.sort();
      if (partial.length) report[m].partial = partial.sort();
    }
  }
  return report;
}

test('node-shim constants: the gap inventory matches the reviewed golden', (t) => {
  if (skipUnlessTjs(t)) return;
  const actual = gaps();
  if (process.env.CLODE_UPDATE_CONSTANTS_GOLDEN === '1') {
    fs.writeFileSync(GOLDEN, JSON.stringify(actual, null, 2) + '\n');
    t.diagnostic('golden rewritten');
    return;
  }
  const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  assert.deepStrictEqual(actual, golden,
    'constants gap inventory moved. A NEW gap means the shim now lacks something host '
    + 'node has — decide whether the bundle can reach it before accepting. A CLOSED gap '
    + 'is good news: ratchet the golden down. Refresh with '
    + 'CLODE_UPDATE_CONSTANTS_GOLDEN=1 node --test test/node-shim-constants.test.cjs');
});
